/**
 * End-to-end ingest test for on-device first-look transcripts, with a stub
 * bucket API and a temp DATA_DIR. Run with:
 *   DATA_DIR=$(mktemp -d) bun test lib/capture/LocalTranscriptIngest.test.ts
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { BunFileSystem } from "@effect/platform-bun"
import { ingestLocalTranscript, localTranscriptSource, transcriptObjects } from "./LocalTranscripts.ts"
import { dataPath, localTranscriptKey, Transcript } from "../lifelog/Resources.ts"
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

    const second = await run(source.ingest)
    expect(second.ingested).toBe(0)
    expect(second.cached).toBe(1)
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
