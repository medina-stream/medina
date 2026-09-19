import { describe, expect, test } from "bun:test"
import { parsePhoneTranscript, transcriptObjects } from "./LocalTranscripts.ts"

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
