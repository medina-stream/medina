/**
 * End-to-end ingest test for on-device first-look transcripts, with a stub
 * bucket API and a temp DATA_DIR. Run with:
 *   DATA_DIR=$(mktemp -d) bun test lib/capture/LocalTranscriptIngest.test.ts
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { BunFileSystem } from "@effect/platform-bun"
import { ingestLocalTranscript, localTranscriptSource, promoteLiveTranscript, transcriptObjects } from "./LocalTranscripts.ts"
import { dataPath, liveTranscriptKey, localTranscriptKey, Transcript } from "../lifelog/Resources.ts"
import * as Files from "../Files.ts"
import type { SourceBucketApi } from "../Bucket.ts"

const dataDir = process.env["DATA_DIR"]
if (!dataDir || !dataDir.startsWith("/tmp/")) {
  throw new Error("refusing to run: set DATA_DIR to a temp dir, e.g. DATA_DIR=$(mktemp -d)")
}

const captureId = "b".repeat(64)
const phoneJson = JSON.stringify({
  schemaVersion: 1,
  captureId,
  audioId: "audio-uuid",
  audioKey: "install-1/audio/2026/09/19/x.m4a",
  capturedAt: "2026-09-19T00:30:00.000Z",
  engine: "whisper.cpp",
  model: "ggml-tiny.en",
  language: "en",
  segments: [
    { start: 0.0, end: 4.2, text: "hello world" },
    { start: 4.2, end: 9.0, text: "second line" }
  ],
  text: "hello world second line"
})

const stubApi = {
  configured: true,
  list: () =>
    Effect.succeed([
      { key: "install-1/transcript/2026/09/19/x.json", size: phoneJson.length, etag: "etag-1", lastModified: "2026-09-19T01:00:00Z" }
    ]),
  download: (_key: string) => Effect.succeed(Stream.fromIterable([Buffer.from(phoneJson)])),
  head: (_key: string) => Effect.succeed(null)
} as unknown as SourceBucketApi

const live = BunFileSystem.layer
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/FileSystem").FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(live)) as Effect.Effect<A, E, never>)

describe("local transcript ingest", () => {
  test("ingests the phone JSON as an on-device transcript, then receipt-guards", async () => {
    const source = localTranscriptSource(stubApi, "install-1/", 25)
    const first = await run(source.ingest)
    expect(first.discovered).toBe(1)
    expect(first.ingested).toBe(1)

    const stored = await run(Files.readJson(Transcript, dataPath(localTranscriptKey(captureId))))
    expect(stored._tag).toBe("Some")
    if (stored._tag !== "Some") throw new Error("missing transcript")
    expect(stored.value.provider).toBe("ondevice")
    expect(stored.value.text).toBe("hello world second line")
    expect(stored.value.status).toBe("completed")
    expect(stored.value.utterances).toHaveLength(2)
    expect(stored.value.utterances[0]?.startMs).toBe(0)
    expect(stored.value.utterances[0]?.endMs).toBe(4200)
    expect(stored.value.inputKey).toBe("install-1/audio/2026/09/19/x.m4a")

    // Receipted objects are filtered at discovery (the 2026-09-18 stall
    // fix): the second pass discovers nothing instead of re-discovering the
    // receipted transcript as cached.
    const second = await run(source.ingest)
    expect(second.discovered).toBe(0)
    expect(second.ingested).toBe(0)
    expect(second.cached).toBe(0)
  })

  test("skips (with receipt) a transcript that fails validation", async () => {
    const badKey = "install-1/transcript/2026/09/19/bad.json"
    const badApi = {
      ...stubApi,
      download: (_key: string) => Effect.succeed(Stream.fromIterable([Buffer.from("{\"nope\":true}")]))
    } as unknown as SourceBucketApi
    const objs = transcriptObjects([{ key: badKey, size: 12, etag: "etag-bad", lastModified: "2026-09-19T01:00:00Z" }])
    expect(objs).toHaveLength(1)
    const outcome = await run(ingestLocalTranscript(badApi, objs[0]!))
    expect(outcome).toBe("skipped")
    const again = await run(ingestLocalTranscript(badApi, objs[0]!))
    expect(again).toBe("cached")
  })
})

describe("live transcript ingest", () => {
  const uuidFor = (n: number) => `7c6e2ede-93e5-4350-8376-6c153a0d33${n.toString().padStart(2, "0")}`
  const liveKeyFor = (uuid: string) => `install-1/transcript/2026/09/19/${uuid}.live.json`
  const liveJson = (uuid: string, seq: number, text: string) =>
    JSON.stringify({
      schemaVersion: 1,
      live: true,
      segmentUuid: uuid,
      installId: "install-1",
      capturedAt: "2026-09-19T00:30:00.000Z",
      engine: "whisper.cpp",
      model: "ggml-tiny.en",
      language: "en",
      updateSeq: seq,
      segments: [{ start: 0.0, end: 4.2, text }],
      text
    })
  const liveApiFor = (uuid: string, seq: number, text: string, etag: string) =>
    ({
      configured: true,
      list: () =>
        Effect.succeed([{ key: liveKeyFor(uuid), size: 100, etag, lastModified: "2026-09-19T01:00:00Z" }]),
      download: (_key: string) => Effect.succeed(Stream.fromIterable([Buffer.from(liveJson(uuid, seq, text))])),
      head: (_key: string) => Effect.succeed(null)
    }) as unknown as SourceBucketApi

  test("files each tick as a provisional, overwriting the last", async () => {
    const uuid = uuidFor(1)
    const liveKey = liveKeyFor(uuid)
    const objs = transcriptObjects([{ key: liveKey, size: 100, etag: "etag-1", lastModified: "2026-09-19T01:00:00Z" }])
    expect(objs).toHaveLength(1)
    expect(await run(ingestLocalTranscript(liveApiFor(uuid, 1, "hello", "etag-1"), objs[0]!))).toBe("ingested")

    const first = await run(Files.readJson(Transcript, dataPath(liveTranscriptKey("install-1", uuid))))
    expect(first._tag).toBe("Some")
    if (first._tag !== "Some") throw new Error("missing provisional")
    expect(first.value.provider).toBe("ondevice")
    expect(first.value.text).toBe("hello")
    expect(first.value.capturedAt).toBe("2026-09-19T00:30:00.000Z")

    // Second tick: new etag, same object key -> provisional overwritten.
    const objs2 = transcriptObjects([{ key: liveKey, size: 100, etag: "etag-2", lastModified: "2026-09-19T01:01:00Z" }])
    expect(await run(ingestLocalTranscript(liveApiFor(uuid, 2, "hello world", "etag-2"), objs2[0]!))).toBe("ingested")
    const second = await run(Files.readJson(Transcript, dataPath(liveTranscriptKey("install-1", uuid))))
    if (second._tag !== "Some") throw new Error("missing provisional")
    expect(second.value.text).toBe("hello world")
  })

  test("promoteLiveTranscript files the provisional under the capture id and blocks resurrection", async () => {
    const uuid = uuidFor(2)
    const liveKey = liveKeyFor(uuid)
    const objs = transcriptObjects([{ key: liveKey, size: 100, etag: "etag-1", lastModified: "2026-09-19T01:00:00Z" }])
    await run(ingestLocalTranscript(liveApiFor(uuid, 1, "hello world", "etag-1"), objs[0]!))

    const sealedId = "c".repeat(64)
    const audioKey = `capture/install-1/audio/2026/09/19/20260919T003000Z-${uuid}.m4a`
    await run(promoteLiveTranscript(audioKey, sealedId))

    const promoted = await run(Files.readJson(Transcript, dataPath(localTranscriptKey(sealedId))))
    expect(promoted._tag).toBe("Some")
    if (promoted._tag !== "Some") throw new Error("missing promoted transcript")
    expect(promoted.value.text).toBe("hello world")

    // Provisional is gone; a racing partial is receipted but not re-filed.
    const gone = await run(Files.readJson(Transcript, dataPath(liveTranscriptKey("install-1", uuid))))
    expect(gone._tag).toBe("None")
    const objs2 = transcriptObjects([{ key: liveKey, size: 100, etag: "etag-2", lastModified: "2026-09-19T01:01:00Z" }])
    expect(await run(ingestLocalTranscript(liveApiFor(uuid, 2, "hello world again", "etag-2"), objs2[0]!))).toBe("cached")
    const stillGone = await run(Files.readJson(Transcript, dataPath(liveTranscriptKey("install-1", uuid))))
    expect(stillGone._tag).toBe("None")
  })

  test("promotion never clobbers a batch final that won the race", async () => {
    const uuid = uuidFor(3)
    const liveKey = liveKeyFor(uuid)
    const objs = transcriptObjects([{ key: liveKey, size: 100, etag: "etag-1", lastModified: "2026-09-19T01:00:00Z" }])
    await run(ingestLocalTranscript(liveApiFor(uuid, 1, "live text", "etag-1"), objs[0]!))

    const sealedId = "d".repeat(64)
    // Batch final lands first (full-file transcription is the better text).
    await run(
      Files.writeJson(
        dataPath(localTranscriptKey(sealedId)),
        new Transcript({
          provider: "ondevice",
          version: "1",
          ingestId: sealedId,
          inputKey: "install-1/audio/2026/09/19/x.m4a",
          capturedAt: undefined,
          transcriptId: null,
          vendorKey: null,
          status: "completed",
          completedAt: new Date().toISOString(),
          text: "batch final text",
          utterances: [],
          error: null
        })
      )
    )
    const audioKey = `capture/install-1/audio/2026/09/19/20260919T003000Z-${uuid}.m4a`
    await run(promoteLiveTranscript(audioKey, sealedId))
    const kept = await run(Files.readJson(Transcript, dataPath(localTranscriptKey(sealedId))))
    if (kept._tag !== "Some") throw new Error("missing transcript")
    expect(kept.value.text).toBe("batch final text")
  })
})
