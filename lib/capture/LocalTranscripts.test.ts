import { describe, expect, test } from "bun:test"
import { parseLivePhoneTranscript, parsePhoneTranscript, transcriptObjects } from "./LocalTranscripts.ts"
import { liveTranscriptKey, parseCaptureAudioKey, parseLiveCaptureId, transcriptKey } from "../lifelog/Resources.ts"

const obj = (key: string) => ({ key, lastModified: "2026-09-19T00:00:00Z", etag: "abc", size: 100 })

describe("transcriptObjects", () => {
  test("picks up transcript JSON under any install prefix", () => {
    const items = transcriptObjects([
      obj("install-1/transcript/2026/09/19/20260919T003000Z-uuid.json"),
      obj("install-1/audio/2026/09/19/20260919T003000Z-uuid.m4a"),
      obj("install-1/location/2026/09/19/20260919T003000Z-uuid.json"),
      obj("probe/some-uuid"),
    ])
    expect(items.map((i) => i.key)).toEqual([
      "install-1/transcript/2026/09/19/20260919T003000Z-uuid.json",
    ])
  })
})

describe("parsePhoneTranscript", () => {
  const valid = {
    schemaVersion: 1,
    captureId: "a".repeat(64),
    audioId: "uuid",
    audioKey: "install-1/audio/2026/09/19/x.m4a",
    capturedAt: "2026-09-19T00:30:00.000Z",
    engine: "whisper.cpp",
    model: "ggml-tiny.en",
    language: "en",
    segments: [{ start: 0.0, end: 4.2, text: "hello" }],
    text: "hello",
  }
  test("accepts a well-formed phone transcript", () => {
    const parsed = parsePhoneTranscript(valid)
    expect(parsed?.captureId).toBe("a".repeat(64))
    expect(parsed?.segments).toHaveLength(1)
  })
  test("rejects wrong schema version", () => {
    expect(parsePhoneTranscript({ ...valid, schemaVersion: 2 })).toBeNull()
  })
  test("rejects malformed capture id", () => {
    expect(parsePhoneTranscript({ ...valid, captureId: "not-a-hash" })).toBeNull()
  })
  test("rejects malformed segments", () => {
    expect(parsePhoneTranscript({ ...valid, segments: [{ start: "x" }] })).toBeNull()
  })
  test("tolerates missing optional fields", () => {
    const { capturedAt, engine, model, language, audioKey, ...rest } = valid
    const parsed = parsePhoneTranscript(rest)
    expect(parsed?.capturedAt).toBeNull()
    expect(parsed?.engine).toBe("whisper.cpp")
  })
})

describe("parseLivePhoneTranscript", () => {
  const uuid = "7c6e2ede-93e5-4350-8376-6c153a0d33da"
  const valid = {
    schemaVersion: 1,
    live: true,
    segmentUuid: uuid,
    installId: "install-1",
    capturedAt: "2026-09-19T00:30:00.000Z",
    engine: "whisper.cpp",
    model: "ggml-tiny.en",
    language: "en",
    updateSeq: 3,
    segments: [{ start: 0.0, end: 4.2, text: "hello" }],
    text: "hello"
  }
  test("accepts a well-formed live partial", () => {
    const parsed = parseLivePhoneTranscript(valid)
    expect(parsed?.segmentUuid).toBe(uuid)
    expect(parsed?.installId).toBe("install-1")
    expect(parsed?.updateSeq).toBe(3)
  })
  test("rejects a final transcript (live flag missing)", () => {
    const { live, ...rest } = valid
    expect(parseLivePhoneTranscript(rest)).toBeNull()
  })
  test("rejects malformed segment uuid", () => {
    expect(parseLivePhoneTranscript({ ...valid, segmentUuid: "not-a-uuid" })).toBeNull()
  })
  test("rejects empty install id", () => {
    expect(parseLivePhoneTranscript({ ...valid, installId: "" })).toBeNull()
  })
})

describe("live key helpers", () => {
  test("liveTranscriptKey round-trips through parseLiveCaptureId", () => {
    const key = liveTranscriptKey("install-1", "7c6e2ede-93e5-4350-8376-6c153a0d33da")
    expect(key).toBe("transcript/assemblyai-u35p-v1/live/install-1/7c6e2ede-93e5-4350-8376-6c153a0d33da.json")
    // transcriptKey of the synthetic id must land on the same path (day-index dependencies).
    expect(transcriptKey("live/install-1/7c6e2ede-93e5-4350-8376-6c153a0d33da")).toBe(key)
    expect(parseLiveCaptureId("live/install-1/7c6e2ede-93e5-4350-8376-6c153a0d33da")).toEqual({
      installId: "install-1",
      segmentUuid: "7c6e2ede-93e5-4350-8376-6c153a0d33da"
    })
  })
  test("parseLiveCaptureId rejects non-live ids", () => {
    expect(parseLiveCaptureId("a".repeat(64))).toBeNull()
    expect(parseLiveCaptureId("live/install-1/not-a-uuid")).toBeNull()
    expect(parseLiveCaptureId("live/onlyone")).toBeNull()
  })
  test("parseCaptureAudioKey extracts install and segment uuid", () => {
    expect(
      parseCaptureAudioKey("capture/install-1/audio/2026/09/19/20260919T011202Z-7c6e2ede-93e5-4350-8376-6c153a0d33da.m4a")
    ).toEqual({ installId: "install-1", segmentUuid: "7c6e2ede-93e5-4350-8376-6c153a0d33da" })
  })
  test("parseCaptureAudioKey rejects non-audio keys", () => {
    expect(parseCaptureAudioKey("capture/install-1/transcript/2026/09/19/x.live.json")).toBeNull()
    expect(parseCaptureAudioKey("recordings/session-1.mp3")).toBeNull()
  })
})
