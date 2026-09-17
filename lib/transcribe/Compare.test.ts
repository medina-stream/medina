import { describe, expect, test } from "bun:test"
import { MediaChunk, mergeParts } from "../capture/Media.ts"
import {
  COMPARE_DIR,
  COMPARE_VERSION,
  compareJobsKey,
  compareRawKey,
  compareTranscriptKey,
  formatSummary,
  inWindow,
  mergeCompareTranscript,
  parseCompareArgs
} from "./Compare.ts"

const chunk = (index: number, startSeconds: number) =>
  new MediaChunk({ index, key: `media/k/${index}.ogg`, startSeconds, durationSeconds: 60 })

describe("inWindow", () => {
  test("inclusive start, exclusive end, null never matches", () => {
    expect(inWindow("2026-09-16T08:00:00", "2026-09-16T08:00:00", "2026-09-16T12:00:00")).toBe(true)
    expect(inWindow("2026-09-16T11:59:59", "2026-09-16T08:00:00", "2026-09-16T12:00:00")).toBe(true)
    expect(inWindow("2026-09-16T12:00:00", "2026-09-16T08:00:00", "2026-09-16T12:00:00")).toBe(false)
    expect(inWindow("2026-09-16T07:59:59", "2026-09-16T08:00:00", "2026-09-16T12:00:00")).toBe(false)
    expect(inWindow(null, "2026-09-16T08:00:00", "2026-09-16T12:00:00")).toBe(false)
  })
})

describe("parseCompareArgs", () => {
  test("parses a full argument list", () => {
    const args = parseCompareArgs([
      "--start", "2026-09-16T08:00:00",
      "--end", "2026-09-16T12:00:00",
      "--limit", "3",
      "--submit-only"
    ])
    expect(args).toEqual({
      start: "2026-09-16T08:00:00",
      end: "2026-09-16T12:00:00",
      limit: 3,
      submitOnly: true,
      pollOnly: false
    })
  })

  test("rejects missing bounds, bad formats, and inverted windows", () => {
    expect(() => parseCompareArgs(["--end", "2026-09-16T12:00:00"])).toThrow(/missing --start/)
    expect(() => parseCompareArgs(["--start", "2026-09-16", "--end", "2026-09-16T12:00:00"])).toThrow(/YYYY-MM-DDTHH:mm:ss/)
    expect(() => parseCompareArgs(["--start", "2026-09-16T12:00:00", "--end", "2026-09-16T08:00:00"])).toThrow(/before --end/)
    expect(() => parseCompareArgs(["--start", "2026-09-16T08:00:00", "--end", "2026-09-16T12:00:00", "--submit-only", "--poll-only"])).toThrow(/mutually exclusive/)
    expect(() => parseCompareArgs(["--start", "2026-09-16T08:00:00", "--end", "2026-09-16T12:00:00", "--limit", "0"])).toThrow(/positive integer/)
  })
})

describe("comparison key namespace", () => {
  test("comparison keys never collide with production transcript keys", () => {
    const id = "abc123"
    for (const key of [compareJobsKey(id), compareRawKey(id), compareTranscriptKey(id)]) {
      expect(key.startsWith(`${COMPARE_DIR}/`)).toBe(true)
      expect(key).not.toContain("transcript/assemblyai")
      expect(key).not.toContain(".assemblyai.json")
    }
    expect(compareRawKey(id)).toBe(`${COMPARE_DIR}/${id}.meta-muse.json`)
  })
})

describe("mergeParts", () => {
  test("offsets utterances by chunk start and joins text and ids", () => {
    const merged = mergeParts([
      {
        chunk: chunk(0, 0),
        utterances: [{ speaker: "speaker_A", startMs: 100, endMs: 500, text: "hello", confidence: null }],
        text: "hello",
        transcriptId: "t-0",
        error: null
      },
      {
        chunk: chunk(1, 60),
        utterances: [{ speaker: "speaker_B", startMs: 200, endMs: 900, text: "world", confidence: null }],
        text: "world",
        transcriptId: "t-1",
        error: null
      }
    ])
    expect(merged.status).toBe("completed")
    expect(merged.text).toBe("hello\nworld")
    expect(merged.transcriptId).toBe("t-0,t-1")
    expect(merged.utterances).toEqual([
      { speaker: "speaker_A", startMs: 100, endMs: 500, text: "hello", confidence: null },
      { speaker: "speaker_B", startMs: 60200, endMs: 60900, text: "world", confidence: null }
    ])
    expect(merged.error).toBeNull()
  })

  test("first error wins and marks the merge failed", () => {
    const merged = mergeParts([
      {
        chunk: chunk(0, 0),
        utterances: [],
        text: null,
        transcriptId: "t-0",
        error: "boom"
      }
    ])
    expect(merged.status).toBe("error")
    expect(merged.error).toBe("boom")
    expect(merged.text).toBeNull()
  })
})

describe("mergeCompareTranscript", () => {
  test("tags provider meta-muse and points at the comparison vendor key", () => {
    const merged = mergeCompareTranscript("abc123", "2026-09-16T08:00:00", [
      {
        chunk: chunk(0, 0),
        utterances: [{ speaker: "speaker_A", startMs: 0, endMs: 1000, text: "hi", confidence: null }],
        text: "hi",
        transcriptId: "m-0",
        error: null
      }
    ])
    expect(merged["provider"]).toBe("meta-muse")
    expect(merged["version"]).toBe(COMPARE_VERSION)
    expect(merged["vendorKey"]).toBe(compareRawKey("abc123"))
    expect(merged["ingestId"]).toBe("abc123")
    expect(merged["capturedAt"]).toBe("2026-09-16T08:00:00")
  })
})

describe("formatSummary", () => {
  test("reports counts, hours, and both cost estimates", () => {
    const text = formatSummary({
      windowStart: "2026-09-16T08:00:00",
      windowEnd: "2026-09-16T12:00:00",
      capturesInWindow: 4,
      submitted: 4,
      completed: 3,
      failed: 1,
      audioSeconds: 7200
    })
    expect(text).toContain("captures in window: 4")
    expect(text).toContain("submitted: 4, completed: 3, failed: 1")
    expect(text).toContain("audio: 2.0h")
    expect(text).toContain("Muse Voice @ $0.18/audio-hr: $0.36")
    expect(text).toContain("AssemblyAI @ $0.23/audio-hr: $0.46")
  })
})
