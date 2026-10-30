/**
 * Probing and normalizing captures whose blob lives only in the artifact
 * store — the state every fresh capture is in since the bucket flip.
 * The regression: `blobPathFor` saw no local path, the probe stayed
 * uncached with media=false, and normalize/transcribe never ran.
 *
 * The store here is the in-memory ArtifactStore (nothing on local disk);
 * the fix materializes small blobs to a scratch file for a byte-exact
 * probe, so these tests run the real ffprobe/ffmpeg against real bytes.
 */
import { tmpdir } from "node:os"
import { readdir } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { AssemblyAI, VendorTranscript } from "../AssemblyAI.ts"
import { ArtifactStore, makeMemory, type MemoryStore } from "../ArtifactStore.ts"
import { Bucket } from "../Bucket.ts"
import * as Files from "../Files.ts"
import { sha256 } from "../Hash.ts"
import { R2TempCreds, TempCredentials } from "../R2TempCreds.ts"
import { captureDir, DATA_DIR, dataPath, Transcript, transcriptKey } from "../lifelog/Resources.ts"
import {
  ffprobeKey,
  MediaManifest,
  mediaManifestKey,
  mediaNormalizeSource,
  normalizeCapture,
  probeCapture,
  ProbeRecord,
  transcribeMediaCapture
} from "./Media.ts"
import { TransloaditNormalize } from "./TransloaditNormalize.ts"

if (!DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run against a non-temp data dir: ${DATA_DIR}`)
}

/** Synthesize a capture's bytes and park them in the store only. The
 * random metadata comment makes the bytes unique to this call — a bare
 * sine tone is deterministic, and its hash would alias the capture ids
 * other test files synthesize onto the shared temp disk. */
const makeRemoteCapture = async (
  memory: MemoryStore,
  seconds: number,
  extension: string,
  extra: ReadonlyArray<string> = []
) => {
  const tmp = `${tmpdir()}/media-probe-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`
  const proc = Bun.spawn([
    "ffmpeg", "-nostdin", "-v", "error",
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-metadata", `comment=probe-test-${Math.random().toString(36).slice(2)}`,
    ...extra,
    tmp
  ])
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text())
  const bytes = new Uint8Array(await Bun.file(tmp).arrayBuffer())
  await Bun.file(tmp).delete()
  const captureId = sha256(bytes)
  const name = `tone.${extension}`
  memory.objects.set(`${captureDir(captureId)}/${name}`, bytes)
  return { captureId, name, bytes }
}

const storeLayers = (memory: MemoryStore) =>
  Layer.mergeAll(BunFileSystem.layer, Layer.succeed(ArtifactStore, memory.api))

const scratchLeftovers = async () => {
  const entries = await readdir(dataPath("tmp")).catch(() => [] as Array<string>)
  return entries.filter((entry) => entry.startsWith("probe-"))
}

describe("probeCapture against a store-only blob", () => {
  test("materializes, probes, and caches the record in the store — nothing lands on disk", async () => {
    const memory = makeMemory(DATA_DIR)
    const layers = storeLayers(memory)
    const { captureId, name } = await makeRemoteCapture(memory, 2, "wav")

    const probe = await Effect.runPromise(probeCapture(captureId).pipe(Effect.provide(layers)))
    expect(probe.media).toBe(true)
    expect(probe.blobName).toBe(name)
    const raw = probe.ffprobe as { format: { duration: string } }
    expect(Number(raw.format.duration)).toBeCloseTo(2, 0)

    // The record is cached in the store, beside where the blob lives.
    const cached = await Effect.runPromise(
      Files.readJson(ProbeRecord, dataPath(ffprobeKey(captureId))).pipe(Effect.provide(layers))
    )
    expect(Option.isSome(cached)).toBe(true)
    expect(memory.objects.has(ffprobeKey(captureId))).toBe(true)

    // The blob never touched local disk, and the probe's scratch is gone.
    expect(await Bun.file(dataPath(`${captureDir(captureId)}/${name}`)).exists()).toBe(false)
    expect(await scratchLeftovers()).toEqual([])
  })

  test("store-only non-media bytes probe as not-media, cached in the store", async () => {
    const memory = makeMemory(DATA_DIR)
    const layers = storeLayers(memory)
    const bytes = new TextEncoder().encode("{\"kind\": \"gps batch\", \"points\": []}")
    const captureId = sha256(bytes)
    memory.objects.set(`${captureDir(captureId)}/batch.json`, bytes)

    const probe = await Effect.runPromise(probeCapture(captureId).pipe(Effect.provide(layers)))
    expect(probe.media).toBe(false)
    expect(probe.blobName).toBe("batch.json")
    expect(memory.objects.has(ffprobeKey(captureId))).toBe(true)
    expect(await scratchLeftovers()).toEqual([])
  })
})

describe("normalizeCapture against a store-only blob", () => {
  test("transcodes from the materialized blob; chunks and manifest land in the store", async () => {
    const memory = makeMemory(DATA_DIR)
    const layers = storeLayers(memory)
    const { captureId } = await makeRemoteCapture(memory, 3, "wav")

    const manifest = await Effect.runPromise(normalizeCapture(captureId).pipe(Effect.provide(layers)))
    expect(manifest.chunks.length).toBe(1)
    expect(manifest.chunks[0]!.durationSeconds).toBeCloseTo(3, 0)
    expect(memory.objects.has(manifest.chunks[0]!.key)).toBe(true)
    expect(memory.objects.has(mediaManifestKey(captureId))).toBe(true)
    // Chunk bytes live in the store, not on local disk.
    expect(await Bun.file(dataPath(manifest.chunks[0]!.key)).exists()).toBe(false)
    expect(await scratchLeftovers()).toEqual([])
  })
})

describe("a fresh recorder-shaped capture, store-only, end to end", () => {
  test("normalize builds the direct manifest and transcribe lands a transcript — in the store", async () => {
    const memory = makeMemory(DATA_DIR)
    const { captureId, name, bytes } = await makeRemoteCapture(memory, 2, "m4a", [
      "-c:a", "aac", "-ac", "1", "-ar", "16000", "-b:a", "32k"
    ])
    const blobKey = `${captureDir(captureId)}/${name}`

    const BucketTest = Layer.succeed(Bucket)({
      configured: true,
      list: () => Effect.succeed([]),
      head: (candidate) => Effect.succeed(candidate === blobKey
        ? { key: candidate, size: bytes.length, etag: "etag", lastModified: null }
        : null),
      download: () => Effect.fail(new Error("download must not happen")),
      put: () => Effect.fail(new Error("put must not happen")),
      putFile: () => Effect.fail(new Error("putFile must not happen"))
    })
    const TransloaditTest = Layer.succeed(TransloaditNormalize)({
      configured: false,
      normalize: () => Effect.fail(new Error("transloadit must not be called for a direct capture")),
      ingestDrive: () => Effect.fail(new Error("transloadit must not be called"))
    })
    const submitted: Array<string> = []
    const R2Test = Layer.succeed(R2TempCreds)({
      configured: true,
      endpoint: "https://r2.test",
      bucket: "archive",
      mint: () => Effect.succeed(new TempCredentials({
        accessKeyId: "unused",
        secretAccessKey: "unused",
        sessionToken: "unused"
      })),
      presignGet: (candidate) => Effect.succeed(`https://r2.test/signed/${candidate}`)
    })
    const AssemblyTest = Layer.succeed(AssemblyAI)({
      submit: (audio) => Effect.sync(() => {
        if (audio._tag !== "url") throw new Error("expected url audio")
        submitted.push(audio.url)
        return { transcript: new VendorTranscript({ id: "t-remote-1", status: "queued" }), raw: {} }
      }),
      poll: (id) => Effect.succeed({
        transcript: new VendorTranscript({
          id,
          status: "completed",
          text: "hello remote",
          utterances: [{ speaker: "A", start: 0, end: 400, text: "hello remote", confidence: 0.9 }]
        }),
        raw: { id, status: "completed" }
      })
    })
    const live = Layer.mergeAll(
      storeLayers(memory),
      BucketTest,
      TransloaditTest,
      R2Test,
      AssemblyTest
    )

    // Normalize: the probe materializes the store-only blob, recognizes
    // the recorder shape, and the manifest points at the blob itself.
    const report = await Effect.runPromise(mediaNormalizeSource.ingest.pipe(Effect.provide(live)))
    expect(report.failures.map((failure) => failure.item)).not.toContain(`capture/${captureId}`)
    const manifest = Option.getOrThrow(await Effect.runPromise(
      Files.readJson(MediaManifest, dataPath(mediaManifestKey(captureId))).pipe(Effect.provide(live))
    ))
    expect(manifest.chunks.map((chunk) => chunk.key)).toEqual([blobKey])

    // Transcribe: submits the blob's signed URL once, polls to a
    // completed transcript — written to the store like everything else.
    expect(await Effect.runPromise(transcribeMediaCapture(captureId).pipe(Effect.provide(live)))).toBe("ingested")
    expect(submitted).toEqual([`https://r2.test/signed/${blobKey}`])
    expect(await Effect.runPromise(transcribeMediaCapture(captureId).pipe(Effect.provide(live)))).toBe("ingested")
    expect(submitted.length).toBe(1)
    const transcript = Option.getOrThrow(await Effect.runPromise(
      Files.readJson(Transcript, dataPath(transcriptKey(captureId))).pipe(Effect.provide(live))
    ))
    expect(transcript.status).toBe("completed")
    expect(transcript.text).toBe("hello remote")
    expect(memory.objects.has(transcriptKey(captureId))).toBe(true)
  })
})
