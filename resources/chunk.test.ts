import { describe, expect, test } from "bun:test";

import { CHUNK_DURATION_SECONDS, getChunkId, getChunkKey, getChunkWindows, parseChunkId } from "./chunk";

describe("chunk", () => {
  test("getChunkId rounds down to the nearest 10-minute boundary", () => {
    expect(getChunkId(new Date("2026-05-17T23:50:00.000Z"))).toBe("0202605172350");
    expect(getChunkId(new Date("2026-05-18T00:00:00.000Z"))).toBe("0202605180000");
    expect(getChunkId(new Date("2026-05-18T00:10:00.000Z"))).toBe("0202605180010");
    expect(getChunkId(new Date("2026-05-17T23:55:30.000Z"))).toBe("0202605172350");
  });

  test("parseChunkId round-trips with getChunkId", () => {
    const id = "0202605172350";
    const { startTime, endTime } = parseChunkId(id);
    expect(startTime).toEqual(new Date("2026-05-17T23:50:00.000Z"));
    expect(endTime).toEqual(new Date("2026-05-18T00:00:00.000Z"));
    expect(getChunkId(startTime)).toBe(id);
  });

  test("parseChunkId rejects malformed ids", () => {
    expect(() => parseChunkId("020260517235")).toThrow();
    expect(() => parseChunkId("02026051723500")).toThrow();
    expect(() => parseChunkId("abcdefghijklm")).toThrow();
  });

  test("getChunkKey produces the expected path", () => {
    expect(getChunkKey("0202605172350", "abc-123")).toBe("chunks/0202605172350/abc-123.ogg");
  });

  test("getChunkWindows: recording fits entirely within one chunk", () => {
    const start = new Date("2026-05-17T23:53:00.000Z");
    const windows = getChunkWindows("rec-1", start, 120);
    expect(windows).toHaveLength(1);
    const [w] = windows;
    expect(w.chunkId).toBe("0202605172350");
    expect(w.leadingSilenceSeconds).toBe(180);
    expect(w.recordingAudioOffsetSeconds).toBe(0);
    expect(w.recordingAudioDurationSeconds).toBe(120);
    expect(w.outputKey).toBe("chunks/0202605172350/rec-1.ogg");
  });

  test("getChunkWindows: recording starts exactly at a chunk boundary", () => {
    const start = new Date("2026-05-18T00:00:00.000Z");
    const windows = getChunkWindows("rec-1", start, CHUNK_DURATION_SECONDS);
    expect(windows).toHaveLength(1);
    const [w] = windows;
    expect(w.chunkId).toBe("0202605180000");
    expect(w.leadingSilenceSeconds).toBe(0);
    expect(w.recordingAudioOffsetSeconds).toBe(0);
    expect(w.recordingAudioDurationSeconds).toBe(CHUNK_DURATION_SECONDS);
  });

  test("getChunkWindows: recording crosses midnight into the next day", () => {
    const start = new Date("2026-05-17T23:53:00.000Z");
    const windows = getChunkWindows("rec-1", start, 900);
    expect(windows).toHaveLength(2);

    const [w0, w1] = windows;
    expect(w0.chunkId).toBe("0202605172350");
    expect(w0.leadingSilenceSeconds).toBe(180);
    expect(w0.recordingAudioOffsetSeconds).toBe(0);
    expect(w0.recordingAudioDurationSeconds).toBe(420);

    expect(w1.chunkId).toBe("0202605180000");
    expect(w1.leadingSilenceSeconds).toBe(0);
    expect(w1.recordingAudioOffsetSeconds).toBe(420);
    expect(w1.recordingAudioDurationSeconds).toBe(480);
  });

  test("getChunkWindows: recording spans multiple full chunks", () => {
    const start = new Date("2026-05-18T00:00:00.000Z");
    const windows = getChunkWindows("rec-1", start, CHUNK_DURATION_SECONDS * 3);
    expect(windows).toHaveLength(3);
    expect(windows.map((w) => w.chunkId)).toEqual([
      "0202605180000",
      "0202605180010",
      "0202605180020",
    ]);
    for (const w of windows) {
      expect(w.leadingSilenceSeconds).toBe(0);
      expect(w.recordingAudioDurationSeconds).toBe(CHUNK_DURATION_SECONDS);
    }
  });

  test("getChunkWindows: returns empty array for zero or negative duration", () => {
    const start = new Date("2026-05-18T00:00:00.000Z");
    expect(getChunkWindows("rec-1", start, 0)).toHaveLength(0);
    expect(getChunkWindows("rec-1", start, -1)).toHaveLength(0);
  });
});
