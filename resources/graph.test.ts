import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAllBucketKeys, type Bucket } from "../lib/bucket";
import { createMemoryBucket } from "../lib/bucket.test";
import { createIngestService, getIngestRequestKey } from "../lib/ingest";
import { runResource } from "../lib/resource";
import { readIngestAnalysis } from "./ingest";
import { ingestsDefinition } from "./ingests";
import { getDailyIntervalId, readInterval } from "./interval";
import { getRecordings } from "./recording";
import { intervalsDefinition } from "./intervals";
import { getPodcastFeedKey, getPodcastEpisodeKey, podcastFeedDefinition, podcastEpisodeDefinition } from "./podcast";
import { recordingsDefinition } from "./recordings";

const originalEnv = { ...process.env };

async function generateAudioFile(outputPath: string) {
  const proc = Bun.spawn([
    "ffmpeg",
    "-f", "lavfi",
    "-i", "sine=frequency=880:duration=1",
    "-q:a", "4",
    "-y",
    outputPath,
  ], {
    stderr: "pipe",
    stdout: "ignore",
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed to generate test audio: ${stderr.trim() || `exit ${exitCode}`}`);
  }
}

describe("resource graph", () => {
  let bucketRoot = "";
  let bucket: Bucket;

  beforeEach(() => {
    process.env = { ...originalEnv };
    bucketRoot = mkdtempSync(join(tmpdir(), "medina-pipeline-"));
    bucket = createMemoryBucket();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(bucketRoot, { force: true, recursive: true });
  });

  test("audio ingest produces ingest analysis and recording outputs", async () => {
    const audioPath = join(bucketRoot, "input.mp3");
    await generateAudioFile(audioPath);
    const ingestService = createIngestService({
      bucket,
      presignIngestUpload: async () => {
        throw new Error("presignIngestUpload should not be called in pipeline tests");
      },
    });

    const ingestResult = await ingestService.storeIncomingIngest(new Request("http://localhost/in", {
      method: "POST",
      headers: {
        "content-type": "audio/mpeg",
        "x-amz-meta-created-at": "2026-05-15T14:00:00.000Z",
        "x-amz-meta-original-filename": "input.mp3",
        "x-amz-meta-recording-started-at": "2026-05-15T13:55:00.000Z",
        "x-amz-meta-sdk-version": "medina-sdk/test",
        "x-medina-ingest-key": "in/audio-test",
      },
      body: Bun.file(audioPath),
    }));

    const ingestRun = await runResource(ingestsDefinition, {
      bucket,
      inputKey: ingestResult.key,
    });
    const analysisKey = ingestRun.outputs[0];
    expect(analysisKey).toBeDefined();

    const analysis = await readIngestAnalysis(bucket, analysisKey!);
    expect(analysis).toMatchObject({
      ingestKey: "in/audio-test",
      media: {
        hasAudioStream: true,
        kind: "audio",
      },
      startTime: {
        estimatedAt: "2026-05-15T13:55:00.000Z",
        source: "metadata:recording-started-at",
      },
    });

    const recordingRun = await runResource(recordingsDefinition, {
      bucket,
      inputKey: analysisKey!,
    });
    expect(recordingRun.outputs).toEqual(expect.arrayContaining([
      expect.stringMatching(/^chunks\/0202605151350\/.+\.ogg$/),
      expect.stringMatching(/^recordings\/.+\/manifest\.json$/),
      expect.stringMatching(/^recordings\/.+\/meta\.json$/),
    ]));

    const recordings = await getRecordings({ bucket });
    expect(recordings).toHaveLength(1);
    expect(recordings[0]).toMatchObject({
      durationSeconds: expect.any(Number),
      startTime: "2026-05-15T13:55:00.000Z",
    });
    expect(recordings[0]?.chunks.length).toBeGreaterThan(0);

    const intervalRun = await runResource(intervalsDefinition, {
      bucket,
      inputKey: getDailyIntervalId(new Date("2026-05-15T13:55:00.000Z")),
    });
    expect(intervalRun.outputs).toEqual([
      "intervals/020260515.json",
    ]);

    const interval = await readInterval("020260515", { bucket });
    expect(interval).toMatchObject({
      id: "020260515",
      key: "intervals/020260515.json",
      length: "P1D",
    });
    expect(interval?.recordings).toHaveLength(1);
    expect(interval?.recordings[0]?.id).toBe(recordings[0]?.id);

    const podcastEpisodeRun = await runResource(podcastEpisodeDefinition, {
      bucket,
      inputKey: recordings[0]!.id,
    });
    expect(podcastEpisodeRun.outputs).toEqual([
      getPodcastEpisodeKey(recordings[0]!.id),
    ]);
    expect(await bucket.exists(getPodcastEpisodeKey(recordings[0]!.id))).toBe(true);

    const podcastFeedRun = await runResource(podcastFeedDefinition, {
      bucket,
      inputKey: getPodcastFeedKey(),
    });
    expect(podcastFeedRun.outputs).toEqual([
      getPodcastFeedKey(),
    ]);
    const feed = await bucket.readText(getPodcastFeedKey());
    expect(feed).toContain("<rss");
    expect(feed).toContain(getPodcastEpisodeKey(recordings[0]!.id));
  }, 60_000);

  test("recording rematerialization removes stale derived chunks", async () => {
    const audioPath = join(bucketRoot, "retimed.mp3");
    await generateAudioFile(audioPath);
    const ingestService = createIngestService({
      bucket,
      presignIngestUpload: async () => { throw new Error("unexpected presign"); },
    });
    await ingestService.storeIncomingIngest(new Request("http://localhost/in", {
      method: "POST",
      headers: {
        "content-type": "audio/mpeg",
        "x-amz-meta-created-at": "2026-05-15T14:00:00.000Z",
        "x-amz-meta-original-filename": "retimed.mp3",
        "x-amz-meta-recording-started-at": "2026-05-15T13:55:00.000Z",
        "x-amz-meta-sdk-version": "medina-sdk/test",
        "x-medina-ingest-key": "in/retimed",
      },
      body: Bun.file(audioPath),
    }));
    const firstIngest = await runResource(ingestsDefinition, { bucket, inputKey: "in/retimed" });
    await runResource(recordingsDefinition, { bucket, inputKey: firstIngest.outputs[0]! });
    const oldChunkKeys = (await listAllBucketKeys(bucket, { prefix: "chunks/020260515" })).filter((key) => key.endsWith(".ogg"));
    expect(oldChunkKeys.length).toBeGreaterThan(0);

    const requestKey = getIngestRequestKey("in/retimed");
    const request = await bucket.readJson<{ metadata: Record<string, string> }>(requestKey);
    request.metadata["recording-started-at"] = "2026-05-16T01:00:00.000Z";
    await bucket.write(requestKey, JSON.stringify(request));
    const nextIngest = await runResource(ingestsDefinition, { bucket, force: true, inputKey: "in/retimed" });
    const nextRecording = await runResource(recordingsDefinition, { bucket, force: true, inputKey: nextIngest.outputs[0]! });

    expect(nextRecording.plan.state.materializable && nextRecording.plan.state.staleChunkKeys).toEqual(oldChunkKeys);
    expect((await listAllBucketKeys(bucket, { prefix: "chunks/020260515" })).filter((key) => key.endsWith(".ogg"))).toEqual([]);
    expect((await listAllBucketKeys(bucket, { prefix: "chunks/020260516" })).some((key) => key.endsWith(".ogg"))).toBe(true);
  }, 60_000);

  test("non-audio ingest produces analysis but no recording outputs", async () => {
    const ingestService = createIngestService({
      bucket,
      presignIngestUpload: async () => {
        throw new Error("presignIngestUpload should not be called in pipeline tests");
      },
    });

    const ingestResult = await ingestService.storeIncomingIngest(new Request("http://localhost/in", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-amz-meta-created-at": "2026-05-15T14:00:00.000Z",
        "x-amz-meta-original-filename": "note.txt",
        "x-amz-meta-sdk-version": "medina-sdk/test",
        "x-medina-ingest-key": "in/text-test",
      },
      body: "hello world",
    }));

    const ingestRun = await runResource(ingestsDefinition, {
      bucket,
      inputKey: ingestResult.key,
    });
    const analysisKey = ingestRun.outputs[0];
    expect(analysisKey).toBeDefined();

    const analysis = await readIngestAnalysis(bucket, analysisKey!);
    expect(analysis).toMatchObject({
      ingestKey: "in/text-test",
      media: {
        hasAudioStream: false,
        kind: "other",
      },
    });

    const recordingRun = await runResource(recordingsDefinition, {
      bucket,
      inputKey: analysisKey!,
    });
    expect(recordingRun.outputs).toEqual([]);
    expect(await getRecordings({ bucket })).toEqual([]);
  });
});
