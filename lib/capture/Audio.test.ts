import { mkdtemp, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { ArtifactStore, makeMemory } from "../ArtifactStore.ts"
import { DATA_DIR, dataPath } from "../lifelog/Resources.ts"
import { hashStreamToFile, ingestAudioFile, type RecordingObject } from "./Audio.ts"

const encode = (text: string) => new TextEncoder().encode(text)

describe("hashStreamToFile", () => {
  test("streams chunked bytes to disk while hashing across chunk boundaries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "medina-audio-test-"))
    try {
      const tmp = join(dir, "capture")
      const digest = await Effect.runPromise(
        hashStreamToFile(Stream.fromIterable([encode("hello "), encode("wor"), encode("ld")]), tmp).pipe(
          Effect.provide(BunFileSystem.layer)
        )
      )
      expect(digest).toBe(createHash("sha256").update("hello world").digest("hex"))
      expect(await readFile(tmp, "utf8")).toBe("hello world")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a failed stream removes the partial file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "medina-audio-test-"))
    try {
      const tmp = join(dir, "capture")
      await expect(Effect.runPromise(
        hashStreamToFile(
          Stream.concat(Stream.make(encode("partial")), Stream.fail(new Error("boom"))),
          tmp
        ).pipe(Effect.provide(BunFileSystem.layer))
      )).rejects.toThrow("boom")
      expect(existsSync(tmp)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("ingestAudioFile against a non-local artifact store", () => {
  // The regression the first bucket flip exposed: the blob must land in
  // the same store as its provenance and receipt. With an in-memory store
  // in context, nothing may touch the local capture dir at all.
  test("blob, provenance, and receipt all land in the store; a second pass is cached", async () => {
    const memory = makeMemory(DATA_DIR)
    const layers = Layer.mergeAll(BunFileSystem.layer, Layer.succeed(ArtifactStore, memory.api))
    const bytes = encode("fake aac bytes for the seam test")
    const captureId = createHash("sha256").update(bytes).digest("hex")
    const file: RecordingObject = {
      id: "drive-file-seam-1",
      name: "2026-10-28 09-00-00.m4a",
      mimeType: "audio/mp4",
      modifiedTime: "2026-10-28T16:00:00.000Z",
      checksum: "abc123"
    }
    const download = Effect.succeed(Stream.make(bytes))

    const first = await Effect.runPromise(
      ingestAudioFile("audio-drive", file, download).pipe(Effect.provide(layers))
    )
    expect(first).toBe("ingested")

    const blobKey = [...memory.objects.keys()].find((key) =>
      key.startsWith(`capture/${captureId}/`) && !key.endsWith("provenance.json")
    )
    expect(blobKey).toBeDefined()
    expect(memory.objects.get(blobKey!)).toEqual(bytes)
    expect(memory.objects.has(`capture/${captureId}/provenance.json`)).toBe(true)
    expect([...memory.objects.keys()].filter((key) => key.startsWith("ingest/audio-drive/")).length).toBe(1)
    // The split, had it happened: blob bytes on this disk instead.
    expect(existsSync(dataPath(`capture/${captureId}`))).toBe(false)

    // The receipt is visible through the store, so the next pass is one
    // existence check — not a re-download.
    const second = await Effect.runPromise(
      ingestAudioFile("audio-drive", file, download).pipe(Effect.provide(layers))
    )
    expect(second).toBe("cached")
  })
})
