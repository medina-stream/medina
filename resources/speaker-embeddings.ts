import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Bucket } from "../lib/bucket";
import { fetchBucketObjectToTempFile, writeBucketJson } from "../lib/resource";
import { getFfmpegCommand } from "./media-tools";
import { listSpeakers, type SpeakerSample } from "./speakers";

export type SpeakerCentroid = {
  createdAt: string;
  dims: number;
  embedding: number[];
  model: string;
  samples: { name: string; size: number }[];
  speakerId: string;
};

export type SpanGroup = { end: number; start: number }[];

const EMBED_MODEL = "speechbrain/spkrec-ecapa-voxceleb";

export function speakerCentroidKey(speakerId: string) {
  return `speakers/${speakerId}/centroid.embedding.json`;
}

function getEmbedCommand() {
  return process.env.SPEAKER_EMBED_COMMAND ?? "uv";
}

function getEmbedCommandArgs(wavPath: string, groups: SpanGroup[]) {
  const script = process.env.SPEAKER_EMBED_SCRIPT ?? "scripts/speaker-embed.py";
  const groupArgs = groups.flatMap((group) => [
    "--group",
    group.map((span) => `${span.start.toFixed(3)}-${span.end.toFixed(3)}`).join(","),
  ]);

  if (getEmbedCommand() === "uv") {
    return [
      "run",
      "--with", "speechbrain",
      "--with", "soundfile",
      "--with", "torch",
      "--with", "numpy",
      "python", script,
      wavPath,
      ...groupArgs,
    ];
  }
  return [script, wavPath, ...groupArgs];
}

export async function convertToWav(inputPath: string, outputPath: string) {
  const proc = Bun.spawn([
    getFfmpegCommand(),
    "-hide_banner", "-nostats",
    "-i", inputPath,
    "-ar", "16000", "-ac", "1",
    "-f", "wav", outputPath, "-y",
  ], { stderr: "pipe", stdout: "ignore" });
  const stderr = await new Response(proc.stderr).text();
  if (await proc.exited !== 0) throw new Error(`ffmpeg wav conversion failed: ${stderr.trim().slice(-300)}`);
  return outputPath;
}

export async function embedWavGroups(wavPath: string, groups: SpanGroup[]): Promise<(number[] | null)[]> {
  const proc = Bun.spawn([getEmbedCommand(), ...getEmbedCommandArgs(wavPath, groups)], { stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Speaker embedding failed: ${stderr.trim().slice(-500) || `exit ${exitCode}`}`);
  const parsed = JSON.parse(stdout) as { embeddings: (number[] | null)[]; model: string };
  return parsed.embeddings;
}

export function cosineSimilarity(left: number[], right: number[]) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i]! * right[i]!;
    leftNorm += left[i]! * left[i]!;
    rightNorm += right[i]! * right[i]!;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator > 0 ? dot / denominator : 0;
}

function meanEmbedding(embeddings: number[][]) {
  const sum = new Array<number>(embeddings[0]!.length).fill(0);
  for (const embedding of embeddings) {
    for (let i = 0; i < embedding.length; i += 1) sum[i]! += embedding[i]!;
  }
  return sum.map((value) => value / embeddings.length);
}

function sampleSignature(samples: SpeakerSample[]) {
  return samples.map((sample) => ({ name: sample.name, size: sample.size }));
}

function signaturesMatch(left: { name: string; size: number }[], right: { name: string; size: number }[]) {
  return left.length === right.length
    && left.every((sample, index) => sample.name === right[index]!.name && sample.size === right[index]!.size);
}

export async function ensureSpeakerCentroid(options: {
  bucket: Bucket;
  now?: Date;
  samples: SpeakerSample[];
  speakerId: string;
}): Promise<SpeakerCentroid | null> {
  const audioSamples = options.samples.filter((sample) => /audio|video|webm|ogg|wav|mp3/i.test(sample.contentType) || /\.(ogg|wav|mp3|webm|m4a)$/i.test(sample.name));
  if (audioSamples.length === 0) return null;

  const key = speakerCentroidKey(options.speakerId);
  const signature = sampleSignature(audioSamples);
  if (await options.bucket.exists(key)) {
    const existing = await options.bucket.readJson<SpeakerCentroid>(key).catch(() => null);
    if (existing && existing.model === EMBED_MODEL && signaturesMatch(existing.samples, signature)) return existing;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "medina-speaker-centroid-"));
  try {
    const embeddings: number[][] = [];
    for (const sample of audioSamples) {
      const localPath = await fetchBucketObjectToTempFile(sample.key, sample.name, { bucket: options.bucket, tempDir });
      const wavPath = await convertToWav(localPath, join(tempDir, `${sample.name}.wav`));
      const [embedding] = await embedWavGroups(wavPath, []);
      if (embedding) embeddings.push(embedding);
    }
    if (embeddings.length === 0) return null;

    const centroid: SpeakerCentroid = {
      createdAt: (options.now ?? new Date()).toISOString(),
      dims: embeddings[0]!.length,
      embedding: meanEmbedding(embeddings),
      model: EMBED_MODEL,
      samples: signature,
      speakerId: options.speakerId,
    };
    await writeBucketJson(key, centroid, options.bucket);
    return centroid;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

export async function listSpeakerCentroids(options: { bucket: Bucket; now?: Date }): Promise<SpeakerCentroid[]> {
  const speakers = await listSpeakers({ bucket: options.bucket });
  const centroids: SpeakerCentroid[] = [];
  for (const speaker of speakers) {
    const centroid = await ensureSpeakerCentroid({
      bucket: options.bucket,
      now: options.now,
      samples: speaker.samples,
      speakerId: speaker.id,
    });
    if (centroid) centroids.push(centroid);
  }
  return centroids;
}

export type DiarizedSpan = { end: number; speaker: number; start: number };

export type SpeakerMatch = {
  diarizedSpeaker: number;
  similarity: number | null;
  speakerId: string | null;
  speechSeconds: number;
};

function getSpeakerMatchThreshold() {
  const raw = Number(process.env.SPEAKER_MATCH_THRESHOLD ?? "0.4");
  return Number.isFinite(raw) ? raw : 0.4;
}

const MIN_EMBED_SECONDS = 1;
const MAX_EMBED_SECONDS = 30;

export async function identifyDiarizedSpeakers(options: {
  audioPath: string;
  bucket: Bucket;
  now?: Date;
  spans: DiarizedSpan[];
}): Promise<SpeakerMatch[]> {
  const bySpeaker = new Map<number, SpanGroup>();
  for (const span of options.spans) {
    const group = bySpeaker.get(span.speaker) ?? [];
    group.push({ end: span.end, start: span.start });
    bySpeaker.set(span.speaker, group);
  }
  const speakers = [...bySpeaker.keys()].sort((a, b) => a - b);
  if (speakers.length === 0) return [];

  const groups: SpanGroup[] = speakers.map((speaker) => {
    const spans = bySpeaker.get(speaker)!.sort((a, b) => b.end - b.start - (a.end - a.start));
    const capped: SpanGroup = [];
    let total = 0;
    for (const span of spans) {
      if (total >= MAX_EMBED_SECONDS) break;
      capped.push(span);
      total += span.end - span.start;
    }
    return capped.sort((a, b) => a.start - b.start);
  });

  const speechSeconds = groups.map((group) => group.reduce((sum, span) => sum + (span.end - span.start), 0));
  const centroids = await listSpeakerCentroids({ bucket: options.bucket, now: options.now });

  let embeddings: (number[] | null)[] = speakers.map(() => null);
  if (centroids.length > 0 && speechSeconds.some((seconds) => seconds >= MIN_EMBED_SECONDS)) {
    const tempDir = await mkdtemp(join(tmpdir(), "medina-speaker-id-"));
    try {
      const wavPath = await convertToWav(options.audioPath, join(tempDir, "chunk.wav"));
      embeddings = await embedWavGroups(wavPath, groups);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  }

  const threshold = getSpeakerMatchThreshold();
  return speakers.map((speaker, index) => {
    const embedding = speechSeconds[index]! >= MIN_EMBED_SECONDS ? embeddings[index] : null;
    let best: { similarity: number; speakerId: string } | null = null;
    if (embedding) {
      for (const centroid of centroids) {
        const similarity = cosineSimilarity(embedding, centroid.embedding);
        if (!best || similarity > best.similarity) best = { similarity, speakerId: centroid.speakerId };
      }
    }
    const matched = best && best.similarity >= threshold;
    return {
      diarizedSpeaker: speaker,
      similarity: best?.similarity ?? null,
      speakerId: matched ? best!.speakerId : null,
      speechSeconds: speechSeconds[index]!,
    };
  });
}
