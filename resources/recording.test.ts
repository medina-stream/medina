import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMemoryBucket } from "../lib/bucket.test";
import { createIngestAnalysis } from "./ingest";
import {
  checkRecordingAsset,
  checkRecordingManifest,
  createRecordingAsset,
  createRecordingFromManifest,
  estimateRecordingStartTime,
  getRecordingChunkKey,
  getRecordingId,
  parseFilenameStartTime,
  type RecordingStartTimeEstimate,
} from "./recording";

const originalFilenameTimeZone = process.env.MEDINA_FILENAME_TIMEZONE;

afterEach(() => {
  if (originalFilenameTimeZone === undefined) {
    delete process.env.MEDINA_FILENAME_TIMEZONE;
  } else {
    process.env.MEDINA_FILENAME_TIMEZONE = originalFilenameTimeZone;
  }
});

describe("recording assets", () => {
  test("derive stable recording ids from ingest analysis keys", async () => {
    const first = await getRecordingId("02026/05/15/ingests/in/test-key.json");
    const second = await getRecordingId("02026/05/15/ingests/in/test-key.json");
    const other = await getRecordingId("02026/05/15/ingests/in/other-key.json");

    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });

  test("derive manifest and meta keys from ingest analysis", () => {
    const analysis = createIngestAnalysis({
      contentType: "audio/mpeg",
      ingestKey: "in/test-key",
      ingestedAt: "2026-05-15T14:00:00.000Z",
      metadata: {
        "original-filename": "clip.mp3",
        "recording-started-at": "2026-05-15T13:55:00.000Z",
      },
      probe: {
        format: {
          duration: "30.0",
        },
        streams: [
          {
            codec_name: "mp3",
            codec_type: "audio",
          },
        ],
      },
      sizeBytes: 1234,
      type: "audio/mpeg",
    });

    const asset = createRecordingAsset({
      analysis,
      chunkKeys: [
        "recordings/recording-1/chunk-000.ogg",
        "recordings/recording-1/chunk-001.ogg",
      ],
      recordingId: "recording-1",
      startTimeEstimate: {
        confidence: 1,
        estimatedAt: "2026-05-15T13:55:00.000Z",
        explanation: "The ingest metadata included an explicit recording-started-at timestamp.",
        precision: "second",
        source: "metadata:recording-started-at",
        upperBound: "2026-05-15T14:00:00.000Z",
      },
    });

    expect(asset.manifestKey).toBe("recordings/recording-1/manifest.json");
    expect(asset.metaKey).toBe("recordings/recording-1/meta.json");
    expect(asset.manifest).toMatchObject({
      analysisKey: analysis.analysisKey,
      estimatedStart: "2026-05-15T13:55:00.000Z",
      ingestKey: "in/test-key",
      recordedAt: "2026-05-15T13:55:00.000Z",
      recordingId: "recording-1",
      startTimeEstimate: {
        confidence: 1,
        precision: "second",
        source: "metadata:recording-started-at",
      },
      type: "audio/mpeg",
    });
    expect(asset.meta).toMatchObject({
      analysisKey: analysis.analysisKey,
      ingestKey: "in/test-key",
      ingestedAt: "2026-05-15T14:00:00.000Z",
      recordingId: "recording-1",
      recordingKey: "recordings/recording-1/manifest.json",
      startTimeEstimate: {
        confidence: 1,
        precision: "second",
        source: "metadata:recording-started-at",
      },
    });
    expect(checkRecordingAsset(asset)).toEqual([]);
  });

  test("builds playback urls from the canonical recording chunk path", () => {
    const recording = createRecordingFromManifest({
      analysisKey: "analysis/example.json",
      chunkDurationSeconds: 1800,
      chunkFormats: {
        ogg: {
          chunks: [
            {
              contentType: "audio/ogg",
              durationSeconds: 1800,
              format: "ogg",
              key: getRecordingChunkKey("recording-1", "chunk-004.ogg"),
              ordinal: 4,
            },
          ],
          format: "ogg",
        },
      },
      estimatedStart: "2026-05-15T13:55:00.000Z",
      ingestKey: "in/test-key",
      metadata: {},
      probe: null,
      recordedAt: "2026-05-15T13:55:00.000Z",
      recordingId: "recording-1",
      startTimeEstimate: {
        confidence: 1,
        estimatedAt: "2026-05-15T13:55:00.000Z",
        explanation: "Legacy test estimate.",
        precision: "second",
        source: "metadata:recording-started-at",
        upperBound: "2026-05-15T14:00:00.000Z",
      },
      type: "audio/mpeg",
    });

    expect(recording.chunks).toEqual([
      expect.objectContaining({
        key: "recordings/recording-1/chunk-004.ogg",
        url: "/recordings/recording-1/chunk-004.ogg",
      }),
    ]);
    expect(recording.startTimeEstimate).toMatchObject({
      confidence: 1,
      source: "metadata:recording-started-at",
    });
  });

  test("parses observed filename timestamp formats", () => {
    process.env.MEDINA_FILENAME_TIMEZONE = "America/Los_Angeles";

    expect(parseFilenameStartTime("lifelog 2022-07-14 20-56-31.wav")).toEqual({
      estimatedAt: "2022-07-15T03:56:31.000Z",
      precision: "second",
    });
    expect(parseFilenameStartTime("recording-2025-10-10T22:24:47.294Z.webm")).toEqual({
      estimatedAt: "2025-10-10T22:24:47.294Z",
      precision: "second",
    });
    expect(parseFilenameStartTime("sco-lifelog2-20260415.mp3")).toEqual({
      estimatedAt: "2026-04-15T07:00:00.000Z",
      precision: "day",
    });
  });

  test("prefers explicit recording-started-at metadata", async () => {
    const bucketRoot = mkdtempSync(join(tmpdir(), "medina-recording-estimate-"));

    try {
      const bucket = createMemoryBucket();
      await bucket.write("in/test-key", "audio", { type: "audio/mpeg" });

      const analysis = createIngestAnalysis({
        contentType: "audio/mpeg",
        ingestKey: "in/test-key",
        ingestedAt: "2026-05-15T14:00:00.000Z",
        metadata: {
          "created-at": "2026-05-15T14:00:00.000Z",
          "original-filename": "clip.mp3",
          "recording-started-at": "2026-05-15T13:55:00.000Z",
          "sdk-version": "medina-app/1.0.0",
        },
        probe: null,
        sizeBytes: 1234,
        type: "audio/mpeg",
      });

      const estimate = await estimateRecordingStartTime({ analysis, bucket });
      expect(estimate).toMatchObject({
        confidence: 1,
        estimatedAt: "2026-05-15T13:55:00.000Z",
        precision: "second",
        source: "metadata:recording-started-at",
        upperBound: "2026-05-15T14:00:00.000Z",
      });
    } finally {
      rmSync(bucketRoot, { force: true, recursive: true });
    }
  });

  test("prefers a historical filename day over generic import-time created-at", async () => {
    process.env.MEDINA_FILENAME_TIMEZONE = "America/Los_Angeles";
    const bucketRoot = mkdtempSync(join(tmpdir(), "medina-recording-estimate-"));

    try {
      const bucket = createMemoryBucket();
      await bucket.write("in/test-key", "audio", { type: "audio/mpeg" });

      const analysis = createIngestAnalysis({
        contentType: "audio/mpeg",
        ingestKey: "in/test-key",
        ingestedAt: "2026-05-18T23:24:38.831Z",
        metadata: {
          "created-at": "2026-05-18T23:24:38.831Z",
          "original-filename": "sco-lifelog2-20260415.mp3",
          source: "bin/cli",
        },
        probe: null,
        sizeBytes: 1234,
        type: "audio/mpeg",
      });

      const estimate = await estimateRecordingStartTime({ analysis, bucket });
      expect(estimate).toMatchObject({
        estimatedAt: "2026-04-15T07:00:00.000Z",
        precision: "day",
        source: "filename:date",
        upperBound: "2026-05-18T23:24:38.831Z",
      });
      expect(estimate.confidence).toBeGreaterThan(0.2);
      expect(estimate.confidence).toBeLessThan(0.6);
    } finally {
      rmSync(bucketRoot, { force: true, recursive: true });
    }
  });

  test("basename start wins when strong", async () => {
    process.env.MEDINA_FILENAME_TIMEZONE = "America/Los_Angeles";
    const bucketRoot = mkdtempSync(join(tmpdir(), "medina-recording-estimate-"));

    try {
      const bucket = createMemoryBucket();
      await bucket.write("in/test-key", "audio", { type: "audio/wav" });

      const analysis = createIngestAnalysis({
        contentType: "audio/wav",
        ingestKey: "in/test-key",
        ingestedAt: "2026-05-18T23:24:38.831Z",
        metadata: {
          "created-at": "2026-05-18T23:24:38.831Z",
          "original-filename": "lifelog 2026-05-15 06-55-00.wav",
        },
        probe: { format: { duration: "60.0", format_name: "wav" }, streams: [{ codec_type: "audio" }] },
        sizeBytes: 1234,
        type: "audio/wav",
      });

      const estimate = await estimateRecordingStartTime({ analysis, bucket });
      expect(estimate).toMatchObject({
        estimatedAt: "2026-05-15T13:55:00.000Z",
        precision: "second",
        source: "filename:timestamp",
      });
      expect(estimate.evidence).toContainEqual(expect.objectContaining({
        kind: "start",
        source: "filename:timestamp",
      }));
      expect(estimate.confidence).toBeGreaterThan(0.8);
    } finally {
      rmSync(bucketRoot, { force: true, recursive: true });
    }
  });

  test("WAV mtime corroborates end and does not override filename start", async () => {
    process.env.MEDINA_FILENAME_TIMEZONE = "America/Los_Angeles";
    const bucketRoot = mkdtempSync(join(tmpdir(), "medina-recording-estimate-"));

    try {
      const bucket = createMemoryBucket();
      await bucket.write("in/test-key", "audio", { type: "audio/wav" });

      const analysis = createIngestAnalysis({
        contentType: "audio/wav",
        ingestKey: "in/test-key",
        ingestedAt: "2026-05-18T23:24:38.831Z",
        metadata: {
          "fs-mtime": "2026-05-15T14:25:02.500Z",
          "original-filename": "lifelog 2026-05-15 06-55-00.wav",
        },
        probe: { format: { duration: "1802.0", format_name: "wav" }, streams: [{ codec_type: "audio" }] },
        sizeBytes: 1234,
        type: "audio/wav",
      });

      const estimate = await estimateRecordingStartTime({ analysis, bucket });
      expect(estimate).toMatchObject({
        estimatedAt: "2026-05-15T13:55:00.000Z",
        source: "filename:timestamp",
      });
      expect(estimate.evidence).toContainEqual(expect.objectContaining({
        deltaSeconds: 0.5,
        kind: "end",
        source: "metadata:fs-mtime",
        time: "2026-05-15T14:25:02.500Z",
      }));
    } finally {
      rmSync(bucketRoot, { force: true, recursive: true });
    }
  });

  test("MP4 creation_time corroborates end and does not override filename start", async () => {
    process.env.MEDINA_FILENAME_TIMEZONE = "America/Los_Angeles";
    const bucketRoot = mkdtempSync(join(tmpdir(), "medina-recording-estimate-"));

    try {
      const bucket = createMemoryBucket();
      await bucket.write("in/test-key", "audio", { type: "video/mp4" });

      const analysis = createIngestAnalysis({
        contentType: "video/mp4",
        ingestKey: "in/test-key",
        ingestedAt: "2026-05-18T23:24:38.831Z",
        metadata: {
          "original-filename": "VID_20260515_065500.mp4",
        },
        probe: {
          format: {
            duration: "1802.0",
            format_name: "mov,mp4,m4a,3gp,3g2,mj2",
            tags: { creation_time: "2026-05-15T14:25:02.500Z" },
          },
          streams: [{ codec_type: "audio" }],
        },
        sizeBytes: 1234,
        type: "video/mp4",
      });

      const estimate = await estimateRecordingStartTime({ analysis, bucket });
      expect(estimate).toMatchObject({
        estimatedAt: "2026-05-15T13:55:00.000Z",
        source: "filename:timestamp",
      });
      expect(estimate.evidence).toContainEqual(expect.objectContaining({
        deltaSeconds: 0.5,
        kind: "end",
        source: "probe:creation_time",
        time: "2026-05-15T14:25:02.500Z",
      }));
    } finally {
      rmSync(bucketRoot, { force: true, recursive: true });
    }
  });

  test("weak basename falls back with lower confidence", async () => {
    const bucketRoot = mkdtempSync(join(tmpdir(), "medina-recording-estimate-"));

    try {
      const backend = createMemoryBucket();
      const bucket = {
        ...backend,
        async list() { throw new Error("start-time estimation must not scan the ingest bucket"); },
      };
      await bucket.write("in/test-key", "audio", { type: "audio/wav" });

      const analysis = createIngestAnalysis({
        contentType: "audio/wav",
        ingestKey: "in/test-key",
        ingestedAt: "2026-05-18T23:24:38.831Z",
        metadata: {
          "original-filename": "Recording #123.wav",
        },
        probe: null,
        sizeBytes: 1234,
        type: "audio/wav",
      });

      const estimate = await estimateRecordingStartTime({ analysis, bucket });
      expect(estimate).toMatchObject({
        estimatedAt: "2026-05-18T23:24:38.831Z",
        source: "content-hash:first-seen",
      });
      expect(estimate.confidence).toBeLessThan(0.2);
    } finally {
      rmSync(bucketRoot, { force: true, recursive: true });
    }
  });

  test("rejects manifests without a structured start-time estimate", () => {
    const issues = checkRecordingManifest({
      analysisKey: "analysis/example.json",
      chunkDurationSeconds: 1800,
      chunkFormats: {},
      estimatedStart: "2026-05-15T13:55:00.000Z",
      ingestKey: "in/test-key",
      metadata: {},
      probe: null,
      recordedAt: "2026-05-15T13:55:00.000Z",
      recordingId: "recording-1",
      startTimeEstimate: null as unknown as RecordingStartTimeEstimate,
      type: "audio/mpeg",
    });

    expect(issues).toEqual([
      expect.objectContaining({ field: "startTimeEstimate.estimatedAt" }),
      expect.objectContaining({ field: "startTimeEstimate.confidence" }),
    ]);
  });
});
