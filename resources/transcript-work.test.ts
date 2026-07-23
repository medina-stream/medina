import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMemoryBucket } from "../lib/bucket.test";
import { claimWork, failWork, readWork } from "../lib/work-queue";
import { createGpsHour, getGpsHourKey } from "./gps-hour";
import { getSpeechAnalysisKey } from "./speech-analysis";
import { getTranscriptKey } from "./transcripts";
import {
  ensureTranscriptWork,
  executeTranscriptWork,
  reconcileTranscriptWork,
  transcriptWorkDefinition,
  transcriptWorkItemKey,
} from "./transcript-work";

const originalEnv = { ...process.env };

describe("transcript work orchestration", () => {
  let root: string;
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv };
    root = mkdtempSync(join(tmpdir(), "medina-transcript-work-test-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      metadata: { duration: 600, request_id: "mock-request" },
      results: {
        channels: [{ alternatives: [{ transcript: "queued transcript" }] }],
        utterances: [{ confidence: 0.9, end: 2, speaker: 0, start: 0, transcript: "queued transcript" }],
      },
    })) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };
    process.env.DEEPGRAM_API_KEY = "test-key";
    process.env.DEEPGRAM_MODEL = "nova-3";
    process.env.DEEPGRAM_BASE_URL = "http://deepgram.test";
    process.env.TRANSCRIPT_MAX_AGE_DAYS = "0";
  });

  async function writeSpeechAnalysis(bucket: ReturnType<typeof createMemoryBucket>, chunkKey: string, shouldTranscribe = true) {
    await bucket.write(getSpeechAnalysisKey(chunkKey), JSON.stringify({
      chunkKey,
      speechLikelihood: shouldTranscribe ? 0.5 : 0,
      speechSeconds: shouldTranscribe ? 60 : 0,
      transcriptPolicy: { minSpeechSeconds: 1.5, shouldTranscribe },
    }), { type: "application/json" });
  }

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    process.env = { ...originalEnv };
    rmSync(root, { force: true, recursive: true });
  });

  test("reconciliation creates deterministic newest-first chunk work", async () => {
    const bucket = createMemoryBucket();
    const older = "chunks/0202606050950/recording-1.ogg";
    const newer = "chunks/0202606051000/recording-1.ogg";
    await bucket.write(older, "older", { type: "audio/ogg" });
    await bucket.write(newer, "newer", { type: "audio/ogg" });
    await bucket.write("recordings/recording-1/manifest.json", JSON.stringify({
      chunkFormats: {
        ogg: {
          chunks: [{ key: older }, { key: newer }],
          format: "ogg",
        },
      },
    }));

    expect(await reconcileTranscriptWork({ bucket, limit: 10 })).toEqual({ created: 2, scanned: 1, skipped: 0 });
    expect((await bucket.list({ prefix: "work/transcript-chunks/" })).contents).toHaveLength(2);
    expect((await claimWork({ bucket, definitionName: transcriptWorkDefinition.name, workerId: "test" }))?.inputKey).toBe(newer);
  });

  test("reconciliation ignores legacy non-canonical manifest chunks", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("recordings/legacy/manifest.json", JSON.stringify({
      chunkFormats: { ogg: { chunks: [{ key: "recordings/legacy/chunk-000.ogg" }], format: "ogg" } },
    }));

    expect(await reconcileTranscriptWork({ bucket, limit: 10 })).toEqual({ created: 0, scanned: 1, skipped: 1 });
    expect((await bucket.list({ prefix: "work/transcript-chunks/" })).contents).toHaveLength(0);
  });

  test("reconciliation bounds work creation even for a large manifest", async () => {
    const bucket = createMemoryBucket();
    const chunkKeys = [
      "chunks/0202606050950/recording-1.ogg",
      "chunks/0202606051000/recording-1.ogg",
      "chunks/0202606051010/recording-1.ogg",
    ];
    for (const chunkKey of chunkKeys) await bucket.write(chunkKey, "audio", { type: "audio/ogg" });
    await bucket.write("recordings/recording-1/manifest.json", JSON.stringify({
      chunkFormats: { ogg: { chunks: chunkKeys.map((key) => ({ key })), format: "ogg" } },
    }));

    expect(await reconcileTranscriptWork({ bucket, limit: 1 })).toMatchObject({ created: 1 });
    expect((await bucket.list({ prefix: "work/transcript-chunks/" })).contents).toHaveLength(1);
    expect(await reconcileTranscriptWork({ bucket, limit: 1 })).toMatchObject({ created: 1 });
    expect((await bucket.list({ prefix: "work/transcript-chunks/" })).contents).toHaveLength(2);
  });

  test("manifest reconciliation leaves same-version terminal failures for explicit retry", async () => {
    const bucket = createMemoryBucket();
    const chunkKey = "chunks/0202606050950/recording-1.ogg";
    await bucket.write(chunkKey, "audio", { type: "audio/ogg" });
    await bucket.write("recordings/recording-1/manifest.json", JSON.stringify({
      chunkFormats: { ogg: { chunks: [{ key: chunkKey }], format: "ogg" } },
    }));
    await ensureTranscriptWork({ bucket, chunkKey });
    const claimed = await claimWork({ bucket, definitionName: transcriptWorkDefinition.name, workerId: "test" });
    await failWork({ bucket, error: "terminal", maxAttempts: 1, work: claimed! });

    expect(await reconcileTranscriptWork({ bucket, limit: 10 })).toMatchObject({ created: 0 });
    expect(await readWork(bucket, transcriptWorkDefinition.name, chunkKey)).toMatchObject({ generation: 1, status: "failed" });
  });

  test("executor materializes a transcript and completes independently", async () => {
    const bucket = createMemoryBucket();
    const chunkKey = "chunks/0202606050950/recording-1.ogg";
    await bucket.write(chunkKey, "audio", { type: "audio/ogg" });
    await writeSpeechAnalysis(bucket, chunkKey);
    await ensureTranscriptWork({ bucket, chunkKey });
    const work = await claimWork({ bucket, definitionName: transcriptWorkDefinition.name, workerId: "test" });
    const events: Record<string, unknown>[] = [];

    await executeTranscriptWork({
      backend: bucket,
      maxAttempts: 3,
      publishEvent: async (event) => { events.push(event); },
      work: work!,
    });

    expect(await bucket.readJson(getTranscriptKey(chunkKey))).toMatchObject({ text: "queued transcript" });
    expect(await readWork(bucket, transcriptWorkDefinition.name, chunkKey)).toMatchObject({ status: "complete" });
    expect(events).toEqual([expect.objectContaining({ chunkKey, dayIds: ["020260605"], type: "transcript.materialized" })]);
    expect(await bucket.exists(transcriptWorkItemKey(chunkKey))).toBe(true);
  });

  test("executor rematerializes local and utc day rollups when timezone shifts day membership", async () => {
    const bucket = createMemoryBucket();
    const chunkKey = "chunks/0202606050105/recording-1.ogg";
    await bucket.write(chunkKey, "audio", { type: "audio/ogg" });
    await bucket.write(getGpsHourKey("02026060501"), `${JSON.stringify(createGpsHour("02026060501", [
      { ingestKey: "in/gps-1", latitude: 34.05, longitude: -118.24, speed: 0, time: "2026-06-05T01:00:00.000Z", timeZone: "America/Los_Angeles" },
    ]), null, 2)}\n`, { type: "application/json; charset=utf-8" });
    await writeSpeechAnalysis(bucket, chunkKey);
    await ensureTranscriptWork({ bucket, chunkKey });
    const work = await claimWork({ bucket, definitionName: transcriptWorkDefinition.name, workerId: "test" });
    const events: Record<string, unknown>[] = [];

    await executeTranscriptWork({
      backend: bucket,
      maxAttempts: 3,
      publishEvent: async (event) => { events.push(event); },
      work: work!,
    });

    expect(await bucket.readJson("transcripts/020260604.json")).toMatchObject([
      expect.objectContaining({ text: "queued transcript", timeZone: "America/Los_Angeles", timeZoneSource: "gps" }),
    ]);
    expect(await bucket.readJson("transcripts/020260605.json")).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({ chunkKey, dayIds: ["020260604", "020260605"], type: "transcript.materialized" }),
    ]);
  });

  test("executor skips chunks without enough speech", async () => {
    const bucket = createMemoryBucket();
    const chunkKey = "chunks/0202606050950/recording-1.ogg";
    await bucket.write(chunkKey, "audio", { type: "audio/ogg" });
    await writeSpeechAnalysis(bucket, chunkKey, false);
    await ensureTranscriptWork({ bucket, chunkKey });
    const work = await claimWork({ bucket, definitionName: transcriptWorkDefinition.name, workerId: "test" });
    const events: Record<string, unknown>[] = [];

    await executeTranscriptWork({
      backend: bucket,
      maxAttempts: 3,
      publishEvent: async (event) => { events.push(event); },
      work: work!,
    });

    expect(await bucket.exists(getTranscriptKey(chunkKey))).toBe(false);
    expect(await readWork(bucket, transcriptWorkDefinition.name, chunkKey)).toMatchObject({
      result: { skipped: "no-speech" },
      status: "complete",
    });
    expect(events).toEqual([expect.objectContaining({ chunkKey, type: "transcript.skipped.no-speech" })]);

    expect(await ensureTranscriptWork({ bucket, chunkKey })).toMatchObject({ status: "complete" });
  });

  test("executor skips chunks older than the max transcript age", async () => {
    process.env.TRANSCRIPT_MAX_AGE_DAYS = "4";
    const bucket = createMemoryBucket();
    const chunkKey = "chunks/0202606050950/recording-1.ogg";
    await bucket.write(chunkKey, "audio", { type: "audio/ogg" });
    await ensureTranscriptWork({ bucket, chunkKey });
    const work = await claimWork({ bucket, definitionName: transcriptWorkDefinition.name, workerId: "test" });

    await executeTranscriptWork({
      backend: bucket,
      maxAttempts: 3,
      now: new Date("2026-06-20T00:00:00Z"),
      publishEvent: async () => {},
      work: work!,
    });

    expect(await bucket.exists(getTranscriptKey(chunkKey))).toBe(false);
    expect(await readWork(bucket, transcriptWorkDefinition.name, chunkKey)).toMatchObject({
      result: { skipped: "chunk-too-old" },
      status: "complete",
    });
  });

  test("reconciliation skips chunks older than the max transcript age", async () => {
    process.env.TRANSCRIPT_MAX_AGE_DAYS = "4";
    const bucket = createMemoryBucket();
    const oldChunk = "chunks/0202606050950/recording-1.ogg";
    const newChunk = "chunks/0202606190950/recording-1.ogg";
    for (const key of [oldChunk, newChunk]) await bucket.write(key, "audio", { type: "audio/ogg" });
    await bucket.write("recordings/recording-1/manifest.json", JSON.stringify({
      chunkFormats: { ogg: { chunks: [{ key: oldChunk }, { key: newChunk }], format: "ogg" } },
    }));

    expect(await reconcileTranscriptWork({ bucket, limit: 10, now: new Date("2026-06-20T00:00:00Z") }))
      .toEqual({ created: 1, scanned: 1, skipped: 1 });
    expect(await readWork(bucket, transcriptWorkDefinition.name, newChunk)).toMatchObject({ status: "pending" });
    expect(await readWork(bucket, transcriptWorkDefinition.name, oldChunk)).toBeNull();
  });
});
