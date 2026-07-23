import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { listAllBucketKeys, normalizeBucketKey, type Bucket } from "../lib/bucket";
import { createBucketFromEnv } from "../lib/bucket-bun";
import { readStreamPreferences, streamPreferencesKey } from "../lib/stream";
import {
  bucketObject,
  defineResource,
  fetchBucketObjectToTempFile,
  parseResourceArgs,
  runResource,
} from "../lib/resource";
import { getFfmpegCommand } from "./media-tools";
import { createRecordingFromManifest, type Recording, type RecordingManifest } from "./recording";

const podcastFeedKey = "podcast/feed.xml";

export function getPodcastEpisodeKey(recordingId: string) {
  return normalizeBucketKey(`podcast/episodes/${recordingId}.ogg`);
}

export function getPodcastFeedKey() {
  return podcastFeedKey;
}

type PodcastEpisodeState = {
  episodeKey: string;
  recording: Recording;
  recordingId: string;
  sourceChunkKeys: string[];
};

type PodcastFeedEpisode = {
  audioKey: string;
  audioSize: number;
  publishedAt: string;
  recording: Recording;
  recordingId: string;
};

type PodcastFeedState = {
  episodes: PodcastFeedEpisode[];
  outputKey: string;
  streamName: string;
};

function getPodcastBaseUrl() {
  const configured = process.env.MEDINA_ROOT?.trim();
  if (configured) {
    return configured.endsWith("/") ? configured.slice(0, -1) : configured;
  }
  return `http://127.0.0.1:${process.env.PORT || "3002"}`;
}

function withQueryToken(urlString: string) {
  const token = process.env.MEDINA_TOKEN?.trim();
  if (!token) {
    return urlString;
  }

  const url = new URL(urlString);
  url.searchParams.set("token", token);
  return url.toString();
}

function getPodcastFeedUrl(baseUrl: string) {
  return withQueryToken(`${baseUrl}/podcast.xml`);
}

function getPodcastAudioBaseUrl(baseUrl: string) {
  return baseUrl;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toRfc822(value: string) {
  return new Date(value).toUTCString();
}

function formatEpisodeTitle(recording: Recording) {
  if (!recording.startTime) {
    return recording.id;
  }
  const date = new Date(recording.startTime);
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

function firstAndLastChunkKeys(recording: Recording) {
  const chunks = recording.chunks
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((chunk) => normalizeBucketKey(chunk.key));

  if (chunks.length === 0) {
    throw new Error(`Recording ${recording.id} has no chunks.`);
  }

  const first = chunks[0]!;
  const last = chunks[chunks.length - 1]!;
  return first === last ? [first] : [first, last];
}

async function readRecordingManifest(bucket: Bucket, recordingId: string) {
  const manifestKey = normalizeBucketKey(`recordings/${recordingId}/manifest.json`);
  const manifest = await bucket.readJson<RecordingManifest>(manifestKey);
  return {
    manifest,
    manifestKey,
    recording: createRecordingFromManifest(manifest),
  };
}

async function ensurePodcastEpisode(bucket: Bucket, recordingId: string) {
  const episodeKey = getPodcastEpisodeKey(recordingId);
  if (await bucket.exists(episodeKey)) {
    return episodeKey;
  }

  const result = await runResource(podcastEpisodeDefinition, {
    bucket,
    inputKey: recordingId,
  });
  return result.outputs[0] ?? episodeKey;
}

async function buildPodcastEpisodeFile(options: {
  bucket: Bucket;
  outputKey: string;
  recording: Recording;
  sourceChunkKeys: string[];
}) {
  const tempDir = await mkdtemp(join(tmpdir(), "medina-podcast-episode-"));

  try {
    const files = await Promise.all(
      options.sourceChunkKeys.map((key, index) =>
        fetchBucketObjectToTempFile(key, `${options.recording.id}-${index}.ogg`, {
          bucket: options.bucket,
          tempDir,
        }),
      ),
    );

    if (files.length === 1) {
      await options.bucket.write(options.outputKey, Bun.file(files[0]!), { type: "audio/ogg" });
      return;
    }

    const listPath = join(tempDir, "concat.txt");
    await writeFile(listPath, files.map((file) => `file '${file.replaceAll("'", `'\\''`)}'`).join("\n") + "\n");

    const outputPath = join(tempDir, `${options.recording.id}.ogg`);
    const ffmpeg = getFfmpegCommand();
    const proc = Bun.spawn([
      ffmpeg,
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-y",
      outputPath,
    ], {
      stderr: "pipe",
      stdout: "ignore",
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`ffmpeg concat failed for recording ${options.recording.id}: ${stderr.trim() || `exit ${exitCode}`}`);
    }

    await options.bucket.write(options.outputKey, Bun.file(outputPath), { type: "audio/ogg" });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function buildPodcastFeedXml(episodes: PodcastFeedEpisode[], streamName: string) {
  const baseUrl = getPodcastBaseUrl();
  const audioBaseUrl = getPodcastAudioBaseUrl(baseUrl);
  const channelTitle = `${streamName} podcast`;
  const lastBuildDate = toRfc822(episodes[0]?.publishedAt || new Date().toISOString());
  const selfUrl = getPodcastFeedUrl(baseUrl);

  const items = episodes.map((episode) => {
    const title = formatEpisodeTitle(episode.recording);
    const description = `First and last chunk from recording ${episode.recordingId}.`;
    const episodeUrl = withQueryToken(`${audioBaseUrl}/${episode.audioKey}`);
    const pageUrl = `${baseUrl}/recordings/${episode.recordingId}/manifest.json`;

    return [
      "    <item>",
      `      <title>${escapeXml(title)}</title>`,
      `      <guid isPermaLink=\"false\">${escapeXml(episode.recordingId)}</guid>`,
      `      <pubDate>${escapeXml(toRfc822(episode.publishedAt))}</pubDate>`,
      `      <description>${escapeXml(description)}</description>`,
      `      <link>${escapeXml(pageUrl)}</link>`,
      `      <enclosure url=\"${escapeXml(episodeUrl)}\" length=\"${episode.audioSize}\" type=\"audio/ogg\" />`,
      "    </item>",
    ].join("\n");
  }).join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(channelTitle)}</title>`,
    `    <link>${escapeXml(baseUrl)}</link>`,
    "    <description>Recording capsules.</description>",
    "    <language>en-us</language>",
    `    <lastBuildDate>${escapeXml(lastBuildDate)}</lastBuildDate>`,
    `    <atom:link href=\"${escapeXml(selfUrl)}\" rel=\"self\" type=\"application/rss+xml\" />`,
    items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

export const podcastEpisodeDefinition = defineResource<PodcastEpisodeState>({
  async materialize({ bucket, plan }) {
    await buildPodcastEpisodeFile({
      bucket,
      outputKey: plan.state.episodeKey,
      recording: plan.state.recording,
      sourceChunkKeys: plan.state.sourceChunkKeys,
    });
  },
  name: "podcast-episodes",
  async plan({ bucket, inputKey }) {
    const recordingId = normalizeBucketKey(inputKey).split("/").at(-1) ?? inputKey;
    const { manifestKey, recording } = await readRecordingManifest(bucket, recordingId);
    const sourceChunkKeys = firstAndLastChunkKeys(recording);
    const episodeKey = getPodcastEpisodeKey(recordingId);

    return {
      dependencies: [bucketObject(manifestKey), ...sourceChunkKeys.map(bucketObject)],
      outputs: [episodeKey],
      state: {
        episodeKey,
        recording,
        recordingId,
        sourceChunkKeys,
      },
    };
  },
  version: "1",
});

export const podcastFeedDefinition = defineResource<PodcastFeedState>({
  async materialize({ bucket, plan }) {
    const xml = buildPodcastFeedXml(plan.state.episodes, plan.state.streamName);
    await bucket.write(plan.state.outputKey, xml, { type: "application/rss+xml; charset=utf-8" });
  },
  name: "podcast-feed",
  async plan({ bucket, inputKey }) {
    const outputKey = normalizeBucketKey(inputKey || podcastFeedKey);
    const manifestKeys = (await listAllBucketKeys(bucket, { prefix: "recordings/" }))
      .filter((key) => key.endsWith("/manifest.json"))
      .sort();

    const episodes: PodcastFeedEpisode[] = [];
    const dependencies = manifestKeys.map(bucketObject);
    const streamPreferences = await readStreamPreferences(bucket);
    if (await bucket.exists(streamPreferencesKey)) {
      dependencies.push(bucketObject(streamPreferencesKey));
    }
    for (const manifestKey of manifestKeys) {
      const manifest = await bucket.readJson<RecordingManifest>(manifestKey);
      const recording = createRecordingFromManifest(manifest);
      const audioKey = await ensurePodcastEpisode(bucket, recording.id);
      const audioStats = await bucket.stat(audioKey);
      dependencies.push(bucketObject(audioKey));
      episodes.push({
        audioKey,
        audioSize: audioStats.size,
        publishedAt: recording.startTime || manifest.recordedAt,
        recording,
        recordingId: recording.id,
      });
    }

    episodes.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

    return {
      dependencies,
      outputs: [outputKey],
      state: {
        episodes,
        outputKey,
        streamName: streamPreferences.name,
      },
    };
  },
  version: "2",
});

if (import.meta.main) {
  const bucket = createBucketFromEnv();
  const { force, inputKey } = parseResourceArgs();
  const definition = inputKey === podcastFeedKey || inputKey === "podcast" || inputKey === "podcast/feed.xml"
    ? podcastFeedDefinition
    : podcastEpisodeDefinition;
  const result = await runResource(definition, { bucket, force, inputKey });
  console.log(JSON.stringify(result.outputs));
}
