/**
 * Domain tests for src/transcribe.ts: the vendor projection is as
 * strict as lib's Schema decode, the merge reproduces lib's
 * mergeParts offset/join semantics, and the receipt/transcript
 * JSON shapes carry the lib field order.
 */
import { describe, expect, test } from "bun:test";
import {
  filenameWallClock,
  isNoSpokenAudioError,
  jobReceiptJson,
  mergeParts,
  mergedTranscriptJson,
  parseJobReceipt,
  projectVendorTranscript,
  type TranscriptChunkPart,
} from "./transcribe.ts";

describe("projectVendorTranscript", () => {
  test("projects a completed response", () => {
    const projected = projectVendorTranscript({
      id: "t1",
      status: "completed",
      text: "hello",
      audio_duration: 12.3,
      utterances: [
        { speaker: "A", start: 0, end: 900, text: "hello", confidence: 0.9 },
        { start: 1000, end: 2000, text: "world" },
      ],
      error: null,
    });
    expect(projected).toEqual({
      id: "t1",
      status: "completed",
      text: "hello",
      utterances: [
        { speaker: "A", start: 0, end: 900, text: "hello", confidence: 0.9 },
        { speaker: null, start: 1000, end: 2000, text: "world", confidence: null },
      ],
      error: null,
    });
  });

  test("rejects what the server's decode rejects", () => {
    expect(projectVendorTranscript({ status: "completed" })).toBeNull();
    expect(projectVendorTranscript({ id: "t", status: "bogus" })).toBeNull();
    expect(
      projectVendorTranscript({
        id: "t",
        status: "completed",
        utterances: [{ speaker: 0, start: 0, end: 1, text: "x" }],
      }),
    ).toBeNull();
    expect(
      projectVendorTranscript({
        id: "t",
        status: "completed",
        utterances: [{ start: 0, text: "x" }],
      }),
    ).toBeNull();
    expect(
      projectVendorTranscript({ id: "t", status: "error", error: 42 }),
    ).toBeNull();
  });
});

describe("mergeParts", () => {
  const part = (patch: Partial<TranscriptChunkPart>): TranscriptChunkPart => ({
    chunk: { startSeconds: 0 },
    utterances: [],
    text: null,
    transcriptId: null,
    error: null,
    ...patch,
  });

  test("offsets utterances by chunk start and joins text/ids", () => {
    const merged = mergeParts([
      part({
        text: "first",
        transcriptId: "a",
        utterances: [
          { speaker: "A", startMs: 0, endMs: 500, text: "first", confidence: 0.5 },
        ],
      }),
      part({
        chunk: { startSeconds: 14400 },
        text: "second",
        transcriptId: "b",
        utterances: [
          { speaker: null, startMs: 100, endMs: 600, text: "second", confidence: null },
        ],
      }),
    ]);
    expect(merged.status).toBe("completed");
    expect(merged.text).toBe("first\nsecond");
    expect(merged.transcriptId).toBe("a,b");
    expect(merged.utterances[1]).toEqual({
      speaker: null,
      startMs: 14400100,
      endMs: 14400600,
      text: "second",
      confidence: null,
    });
    expect(merged.error).toBeNull();
  });

  test("empty text merges to null; first error wins", () => {
    const merged = mergeParts([
      part({ text: null }),
      part({ error: "boom", transcriptId: "x" }),
    ]);
    expect(merged.status).toBe("error");
    expect(merged.text).toBeNull();
    expect(merged.error).toBe("boom");
    expect(merged.transcriptId).toBe(",x");
  });
});

describe("mergedTranscriptJson", () => {
  test("Transcript field order; capturedAt omitted when null", () => {
    const json = mergedTranscriptJson({
      captureId: "cap",
      capturedAt: null,
      vendorKey: "transcript/assemblyai-u35p-v1/cap.assemblyai.json",
      parts: [],
      completedAt: "2026-11-03T00:00:00.000Z",
    });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "provider",
      "version",
      "ingestId",
      "inputKey",
      "transcriptId",
      "vendorKey",
      "status",
      "completedAt",
      "text",
      "utterances",
      "error",
    ]);
    expect(parsed["provider"]).toBe("assemblyai");
    expect(parsed["version"]).toBe("assemblyai-u35p-v1");
    expect(parsed["inputKey"]).toBe("media/media-v1/cap.json");
    expect(parsed["status"]).toBe("completed");
    expect(parsed["text"]).toBeNull();
  });

  test("capturedAt sits between inputKey and transcriptId when present", () => {
    const json = mergedTranscriptJson({
      captureId: "cap",
      capturedAt: "2026-11-02T18:00:00",
      vendorKey: "v",
      parts: [],
      completedAt: "2026-11-03T00:00:00.000Z",
    });
    const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
    expect(keys.indexOf("capturedAt")).toBe(keys.indexOf("inputKey") + 1);
    expect(keys.indexOf("transcriptId")).toBe(keys.indexOf("capturedAt") + 1);
  });
});

describe("job receipts", () => {
  test("round-trip with schema field order", () => {
    const json = jobReceiptJson({
      captureId: "cap",
      version: "assemblyai-u35p-v1",
      chunks: [
        { index: 0, key: "media/media-v1/cap/x_0.ogg", transcriptId: "t1", submittedAt: "2026-11-03T00:00:00.000Z" },
      ],
    });
    expect(json.startsWith('{"captureId":"cap","version":"assemblyai-u35p-v1","chunks":[{"index":0')).toBe(true);
    expect(parseJobReceipt(JSON.parse(json))?.chunks[0]?.transcriptId).toBe("t1");
    expect(parseJobReceipt({ captureId: "cap" })).toBeNull();
  });
});

describe("filenameWallClock + no-spoken-audio", () => {
  test("recorder stamps parse; plain names do not", () => {
    expect(filenameWallClock("0-20261102T180000Z-uuid.m4a")).toBe("2026-11-02T18:00:00");
    expect(filenameWallClock("voice memo.m4a")).toBeNull();
  });

  test("the silence classification", () => {
    expect(isNoSpokenAudioError("No spoken audio detected")).toBe(true);
    expect(isNoSpokenAudioError("network timeout")).toBe(false);
    expect(isNoSpokenAudioError(null)).toBe(false);
  });
});
