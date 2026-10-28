import { tmpdir } from "node:os"
import { rm } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { AssemblyAI, VendorTranscript } from "../AssemblyAI.ts"
import { Bucket } from "../Bucket.ts"
import * as Files from "../Files.ts"
import { R2TempCreds, TempCredentials } from "../R2TempCreds.ts"
import { DATA_DIR, dataPath, Transcript, transcriptKey, vendorKey } from "../lifelog/Resources.ts"
import { transcribedCaptures } from "../lifelog/Attribution.ts"
import {
  MediaChunk,
  MediaManifest,
  mediaManifestKey,
  mediaTranscribeSource,
  transcribeMediaCapture,
  transcriptJobsKey,
  transcriptSettledKey,
  TranscriptJobReceipt
} from "./Media.ts"

if (!DATA_DIR.startsWith(tmpdir())) throw new Error(`refusing to run against a non-temp data dir: ${DATA_DIR}`)

describe("remote media transcription", () => {
  test("submits R2 URLs once, persists ids, and polls only on later passes", async () => {
    const captureId = "remote-transcription-a"
    const key = `media/media-v1/${captureId}/chunk-0.ogg`
    await Effect.runPromise(
      Files.writeJson(dataPath(mediaManifestKey(captureId)), new MediaManifest({
        captureId,
        version: "media-v1",
        createdAt: new Date().toISOString(),
        sourceDurationSeconds: 5,
        chunks: [new MediaChunk({ index: 0, key, startSeconds: 0, durationSeconds: 5 })]
      })).pipe(Effect.provide(BunFileSystem.layer))
    )

    const signed: Array<string> = []
    const submitted: Array<string> = []
    const polled: Array<string> = []
    let pollStatus: "processing" | "completed" = "processing"
    const BucketTest = Layer.succeed(Bucket)({
      configured: true,
      list: () => Effect.succeed([]),
      head: (candidate) => Effect.succeed(candidate === key ? {
        key: candidate,
        size: 100,
        etag: "etag",
        lastModified: null
      } : null),
      download: () => Effect.fail(new Error("audio download must never be called")),
      put: () => Effect.fail(new Error("audio put must not happen during transcription")),
      putFile: () => Effect.fail(new Error("audio putFile must not happen during transcription"))
    })
    const R2Test = Layer.succeed(R2TempCreds)({
      configured: true,
      endpoint: "https://r2.test",
      bucket: "archive",
      mint: () => Effect.succeed(new TempCredentials({
        accessKeyId: "unused",
        secretAccessKey: "unused",
        sessionToken: "unused"
      })),
      presignGet: (candidate) => Effect.sync(() => {
        signed.push(candidate)
        return `https://r2.test/signed/${candidate}`
      })
    })
    const AssemblyTest = Layer.succeed(AssemblyAI)({
      submit: (audio) => Effect.sync(() => {
        if (audio._tag !== "url") throw new Error("expected url audio")
        submitted.push(audio.url)
        return {
          transcript: new VendorTranscript({ id: "transcript-1", status: "queued" }),
          raw: { id: "transcript-1", status: "queued" }
        }
      }),
      poll: (id) => Effect.sync(() => {
        polled.push(id)
        return pollStatus === "processing"
          ? {
              transcript: new VendorTranscript({ id, status: "processing" }),
              raw: { id, status: "processing" }
            }
          : {
              transcript: new VendorTranscript({
                id,
                status: "completed",
                text: "hello",
                utterances: [{ speaker: "A", start: 100, end: 500, text: "hello", confidence: 0.9 }]
              }),
              raw: { id, status: "completed", text: "hello" }
            }
      })
    })
    const live = Layer.mergeAll(BunFileSystem.layer, BucketTest, R2Test, AssemblyTest)

    const submittedPass = await Effect.runPromise(transcribeMediaCapture(captureId).pipe(Effect.provide(live)))
    expect(submittedPass).toBe("ingested")
    expect(submitted).toEqual([`https://r2.test/signed/${key}`])
    expect(polled).toEqual([])
    expect(signed).toEqual([key])
    expect(await Bun.file(dataPath(key)).exists()).toBe(false)
    const receipt = Option.getOrThrow(await Effect.runPromise(
      Files.readJson(TranscriptJobReceipt, dataPath(transcriptJobsKey(captureId))).pipe(
        Effect.provide(BunFileSystem.layer)
      )
    ))
    expect(receipt.chunks[0]!.transcriptId).toBe("transcript-1")

    const pendingPass = await Effect.runPromise(transcribeMediaCapture(captureId).pipe(Effect.provide(live)))
    expect(pendingPass).toBe("skipped")
    expect(submitted.length).toBe(1)
    expect(polled).toEqual(["transcript-1"])

    pollStatus = "completed"
    const completedPass = await Effect.runPromise(transcribeMediaCapture(captureId).pipe(Effect.provide(live)))
    expect(completedPass).toBe("ingested")
    expect(submitted.length).toBe(1)
    expect(polled).toEqual(["transcript-1", "transcript-1"])
    const transcript = Option.getOrThrow(await Effect.runPromise(
      Files.readJson(Transcript, dataPath(transcriptKey(captureId))).pipe(Effect.provide(BunFileSystem.layer))
    ))
    expect(transcript.text).toBe("hello")
    expect(transcript.utterances[0]!.startMs).toBe(100)
  })

  test("a fully failed transcription settles as errored; only a manual requeue resubmits", async () => {
    const captureId = "remote-transcription-error-retry"
    const key = `media/media-v1/${captureId}/chunk-0.ogg`
    await Effect.runPromise(
      Files.writeJson(dataPath(mediaManifestKey(captureId)), new MediaManifest({
        captureId,
        version: "media-v1",
        createdAt: new Date().toISOString(),
        sourceDurationSeconds: 5,
        chunks: [new MediaChunk({ index: 0, key, startSeconds: 0, durationSeconds: 5 })]
      })).pipe(Effect.provide(BunFileSystem.layer))
    )

    const submitted: Array<string> = []
    const BucketTest = Layer.succeed(Bucket)({
      configured: true,
      list: () => Effect.succeed([]),
      head: (candidate) => Effect.succeed(candidate === key ? { key: candidate, size: 100, etag: "etag", lastModified: null } : null),
      download: () => Effect.fail(new Error("audio download must never be called")),
      put: () => Effect.fail(new Error("audio put must not happen during transcription")),
      putFile: () => Effect.fail(new Error("audio putFile must not happen during transcription"))
    })
    const R2Test = Layer.succeed(R2TempCreds)({
      configured: true,
      endpoint: "https://r2.test",
      bucket: "archive",
      mint: () => Effect.succeed(new TempCredentials({ accessKeyId: "unused", secretAccessKey: "unused", sessionToken: "unused" })),
      presignGet: (candidate) => Effect.succeed(`https://r2.test/signed/${candidate}`)
    })
    const AssemblyTest = Layer.succeed(AssemblyAI)({
      submit: (audio) => Effect.sync(() => {
        if (audio._tag !== "url") throw new Error("expected url audio")
        submitted.push(audio.url)
        const id = `transcript-${submitted.length}`
        return { transcript: new VendorTranscript({ id, status: "queued" }), raw: { id, status: "queued" } }
      }),
      poll: (id) => Effect.sync(() => id === "transcript-1"
        ? {
            transcript: new VendorTranscript({ id, status: "error", error: "vendor download failed" }),
            raw: { id, status: "error", error: "vendor download failed" }
          }
        : {
            transcript: new VendorTranscript({
              id,
              status: "completed",
              text: "recovered",
              utterances: [{ speaker: "A", start: 0, end: 400, text: "recovered", confidence: 0.9 }]
            }),
            raw: { id, status: "completed", text: "recovered" }
          })
    })
    const live = Layer.mergeAll(BunFileSystem.layer, BucketTest, R2Test, AssemblyTest)
    const run = () => Effect.runPromise(transcribeMediaCapture(captureId).pipe(Effect.provide(live)))
    const readTranscript = () => Effect.runPromise(
      Files.readJson(Transcript, dataPath(transcriptKey(captureId))).pipe(Effect.provide(BunFileSystem.layer))
    )

    // Submit, then poll an error: the failure surfaces and no canonical
    // transcript strands the capture — but the jobs receipt is KEPT and a
    // settled marker is written, so the capture is done spending money.
    expect(await run()).toBe("ingested")
    const failed = await run().then(() => null, (error: unknown) => error)
    expect(String(failed)).toContain("vendor download failed")
    expect(Option.isNone(await readTranscript())).toBe(true)
    expect(await Bun.file(dataPath(vendorKey(captureId))).exists()).toBe(true)
    expect(await Bun.file(dataPath(transcriptJobsKey(captureId))).exists()).toBe(true)
    expect(await Bun.file(dataPath(transcriptSettledKey(captureId))).exists()).toBe(true)
    const afterError = await Effect.runPromise(transcribedCaptures.pipe(Effect.provide(BunFileSystem.layer)))
    expect(afterError).not.toContain(captureId)

    // Further passes never resubmit the terminal errored id.
    const failedAgain = await run().then(() => null, (error: unknown) => error)
    expect(String(failedAgain)).toContain("vendor download failed")
    expect(submitted.length).toBe(1)

    // A manual requeue (delete the settled marker and the jobs receipt)
    // resubmits fresh and lands a completed transcript that downstream
    // indexing can now see.
    await rm(dataPath(transcriptSettledKey(captureId)), { force: true })
    await rm(dataPath(transcriptJobsKey(captureId)), { force: true })
    expect(await run()).toBe("ingested")
    expect(submitted.length).toBe(2)
    expect(await run()).toBe("ingested")
    const transcript = Option.getOrThrow(await readTranscript())
    expect(transcript.status).toBe("completed")
    expect(transcript.text).toBe("recovered")
    const afterFix = await Effect.runPromise(transcribedCaptures.pipe(Effect.provide(BunFileSystem.layer)))
    expect(afterFix).toContain(captureId)
  })

  test("one errored chunk does not re-buy the completed chunks", async () => {
    const captureId = "remote-transcription-partial"
    const key0 = `media/media-v1/${captureId}/chunk-0.ogg`
    const key1 = `media/media-v1/${captureId}/chunk-1.ogg`
    await Effect.runPromise(
      Files.writeJson(dataPath(mediaManifestKey(captureId)), new MediaManifest({
        captureId,
        version: "media-v1",
        createdAt: new Date().toISOString(),
        sourceDurationSeconds: 10,
        chunks: [
          new MediaChunk({ index: 0, key: key0, startSeconds: 0, durationSeconds: 5 }),
          new MediaChunk({ index: 1, key: key1, startSeconds: 5, durationSeconds: 5 })
        ]
      })).pipe(Effect.provide(BunFileSystem.layer))
    )

    const submitted: Array<string> = []
    const BucketTest = Layer.succeed(Bucket)({
      configured: true,
      list: () => Effect.succeed([]),
      head: (candidate) => Effect.succeed(candidate === key0 || candidate === key1
        ? { key: candidate, size: 100, etag: "etag", lastModified: null }
        : null),
      download: () => Effect.fail(new Error("audio download must never be called")),
      put: () => Effect.fail(new Error("audio put must not happen during transcription")),
      putFile: () => Effect.fail(new Error("audio putFile must not happen during transcription"))
    })
    const R2Test = Layer.succeed(R2TempCreds)({
      configured: true,
      endpoint: "https://r2.test",
      bucket: "archive",
      mint: () => Effect.succeed(new TempCredentials({ accessKeyId: "unused", secretAccessKey: "unused", sessionToken: "unused" })),
      presignGet: (candidate) => Effect.succeed(`https://r2.test/signed/${candidate}`)
    })
    const AssemblyTest = Layer.succeed(AssemblyAI)({
      submit: (audio) => Effect.sync(() => {
        if (audio._tag !== "url") throw new Error("expected url audio")
        submitted.push(audio.url)
        const id = audio.url.endsWith("chunk-0.ogg") ? "t-chunk-0" : "t-chunk-1"
        return { transcript: new VendorTranscript({ id, status: "queued" }), raw: { id, status: "queued" } }
      }),
      poll: (id) => Effect.sync(() => id === "t-chunk-0"
        ? {
            transcript: new VendorTranscript({
              id,
              status: "completed",
              text: "hello",
              utterances: [{ speaker: "A", start: 0, end: 400, text: "hello", confidence: 0.9 }]
            }),
            raw: { id, status: "completed", text: "hello" }
          }
        : {
            transcript: new VendorTranscript({ id, status: "error", error: "vendor exploded" }),
            raw: { id, status: "error", error: "vendor exploded" }
          })
    })
    const live = Layer.mergeAll(BunFileSystem.layer, BucketTest, R2Test, AssemblyTest)
    const run = () => Effect.runPromise(transcribeMediaCapture(captureId).pipe(Effect.provide(live)))

    expect(await run()).toBe("ingested")
    expect(submitted.length).toBe(2)
    // The poll pass settles with the completed chunk instead of failing
    // the whole file — and no pass ever resubmits either chunk.
    expect(await run()).toBe("ingested")
    const transcript = Option.getOrThrow(await Effect.runPromise(
      Files.readJson(Transcript, dataPath(transcriptKey(captureId))).pipe(Effect.provide(BunFileSystem.layer))
    ))
    expect(transcript.status).toBe("completed")
    expect(transcript.text).toBe("hello")
    expect(await run()).toBe("ingested")
    expect(submitted.length).toBe(2)
  })

  test("a capture with no spoken audio settles as a completed empty transcript", async () => {
    const captureId = "remote-transcription-silent"
    const key = `media/media-v1/${captureId}/chunk-0.ogg`
    await Effect.runPromise(
      Files.writeJson(dataPath(mediaManifestKey(captureId)), new MediaManifest({
        captureId,
        version: "media-v1",
        createdAt: new Date().toISOString(),
        sourceDurationSeconds: 5,
        chunks: [new MediaChunk({ index: 0, key, startSeconds: 0, durationSeconds: 5 })]
      })).pipe(Effect.provide(BunFileSystem.layer))
    )

    const submitted: Array<string> = []
    const BucketTest = Layer.succeed(Bucket)({
      configured: true,
      list: () => Effect.succeed([]),
      head: (candidate) => Effect.succeed(candidate === key ? { key: candidate, size: 100, etag: "etag", lastModified: null } : null),
      download: () => Effect.fail(new Error("audio download must never be called")),
      put: () => Effect.fail(new Error("audio put must not happen during transcription")),
      putFile: () => Effect.fail(new Error("audio putFile must not happen during transcription"))
    })
    const R2Test = Layer.succeed(R2TempCreds)({
      configured: true,
      endpoint: "https://r2.test",
      bucket: "archive",
      mint: () => Effect.succeed(new TempCredentials({ accessKeyId: "unused", secretAccessKey: "unused", sessionToken: "unused" })),
      presignGet: (candidate) => Effect.succeed(`https://r2.test/signed/${candidate}`)
    })
    const AssemblyTest = Layer.succeed(AssemblyAI)({
      submit: (audio) => Effect.sync(() => {
        if (audio._tag !== "url") throw new Error("expected url audio")
        submitted.push(audio.url)
        return { transcript: new VendorTranscript({ id: "t-silent", status: "queued" }), raw: { id: "t-silent", status: "queued" } }
      }),
      poll: (id) => Effect.sync(() => ({
        transcript: new VendorTranscript({
          id,
          status: "error",
          error: "language_detection cannot be performed on files with no spoken audio."
        }),
        raw: { id, status: "error", error: "language_detection cannot be performed on files with no spoken audio." }
      }))
    })
    const live = Layer.mergeAll(BunFileSystem.layer, BucketTest, R2Test, AssemblyTest)
    const run = () => Effect.runPromise(transcribeMediaCapture(captureId).pipe(Effect.provide(live)))

    expect(await run()).toBe("ingested")
    expect(await run()).toBe("ingested")
    const transcript = Option.getOrThrow(await Effect.runPromise(
      Files.readJson(Transcript, dataPath(transcriptKey(captureId))).pipe(Effect.provide(BunFileSystem.layer))
    ))
    expect(transcript.status).toBe("completed")
    expect(transcript.text).toBeNull()
    expect(transcript.utterances).toEqual([])
    expect(submitted.length).toBe(1)
  })

  test("discovery skips settled captures but still retries legacy error transcripts", async () => {
    const settledId = "remote-transcription-discovery-settled"
    const legacyId = "remote-transcription-discovery-legacy"
    const settledKey = `media/media-v1/${settledId}/chunk-0.ogg`
    const legacyKey = `media/media-v1/${legacyId}/chunk-0.ogg`
    const writeManifest = (captureId: string, key: string) =>
      Files.writeJson(dataPath(mediaManifestKey(captureId)), new MediaManifest({
        captureId,
        version: "media-v1",
        createdAt: new Date().toISOString(),
        sourceDurationSeconds: 5,
        chunks: [new MediaChunk({ index: 0, key, startSeconds: 0, durationSeconds: 5 })]
      }))
    await Effect.runPromise(writeManifest(settledId, settledKey).pipe(Effect.provide(BunFileSystem.layer)))
    await Effect.runPromise(writeManifest(legacyId, legacyKey).pipe(Effect.provide(BunFileSystem.layer)))
    // Settled: marker present, nothing else.
    await Effect.runPromise(
      Files.writeJson(dataPath(transcriptSettledKey(settledId)), {
        captureId: settledId,
        error: "boom",
        settledAt: new Date().toISOString()
      }).pipe(Effect.provide(BunFileSystem.layer))
    )
    // Legacy: an error-status canonical transcript and no settled marker.
    await Effect.runPromise(
      Files.writeJson(dataPath(transcriptKey(legacyId)), new Transcript({
        provider: "assemblyai",
        version: "assemblyai-u35p-v1",
        ingestId: legacyId,
        inputKey: mediaManifestKey(legacyId),
        transcriptId: "t-old",
        vendorKey: null,
        status: "error",
        completedAt: new Date().toISOString(),
        text: null,
        utterances: [],
        error: "old failure"
      })).pipe(Effect.provide(BunFileSystem.layer))
    )

    const submitted: Array<string> = []
    const BucketTest = Layer.succeed(Bucket)({
      configured: true,
      list: () => Effect.succeed([]),
      head: (candidate) => Effect.succeed(candidate === legacyKey
        ? { key: candidate, size: 100, etag: "etag", lastModified: null }
        : null),
      download: () => Effect.fail(new Error("audio download must never be called")),
      put: () => Effect.fail(new Error("audio put must not happen during transcription")),
      putFile: () => Effect.fail(new Error("audio putFile must not happen during transcription"))
    })
    const R2Test = Layer.succeed(R2TempCreds)({
      configured: true,
      endpoint: "https://r2.test",
      bucket: "archive",
      mint: () => Effect.succeed(new TempCredentials({ accessKeyId: "unused", secretAccessKey: "unused", sessionToken: "unused" })),
      presignGet: (candidate) => Effect.succeed(`https://r2.test/signed/${candidate}`)
    })
    const AssemblyTest = Layer.succeed(AssemblyAI)({
      submit: (audio) => Effect.sync(() => {
        if (audio._tag !== "url") throw new Error("expected url audio")
        submitted.push(audio.url)
        return { transcript: new VendorTranscript({ id: "t-new", status: "queued" }), raw: { id: "t-new", status: "queued" } }
      }),
      poll: (id) => Effect.sync(() => ({
        transcript: new VendorTranscript({ id, status: "processing" }),
        raw: { id, status: "processing" }
      }))
    })
    const live = Layer.mergeAll(BunFileSystem.layer, BucketTest, R2Test, AssemblyTest)

    const report = await Effect.runPromise(mediaTranscribeSource.ingest.pipe(Effect.provide(live)))
    expect(submitted).toEqual([`https://r2.test/signed/${legacyKey}`])
    expect(report.failures.map((failure) => failure.item)).not.toContain(`capture/${settledId}`)
  })

  test("a chunk missing from R2 and local storage settles instead of failing every pass", async () => {
    const captureId = "remote-transcription-missing-chunk"
    const key = `media/media-v1/${captureId}/chunk-0.ogg`
    await Effect.runPromise(
      Files.writeJson(dataPath(mediaManifestKey(captureId)), new MediaManifest({
        captureId,
        version: "media-v1",
        createdAt: new Date().toISOString(),
        sourceDurationSeconds: 5,
        chunks: [new MediaChunk({ index: 0, key, startSeconds: 0, durationSeconds: 5 })]
      })).pipe(Effect.provide(BunFileSystem.layer))
    )

    const submitted: Array<string> = []
    const BucketTest = Layer.succeed(Bucket)({
      configured: true,
      list: () => Effect.succeed([]),
      // The chunk is in neither store: head misses and no local file exists.
      head: () => Effect.succeed(null),
      download: () => Effect.fail(new Error("audio download must never be called")),
      put: () => Effect.fail(new Error("audio put must not happen during transcription")),
      putFile: () => Effect.fail(new Error("audio putFile must not happen during transcription"))
    })
    const R2Test = Layer.succeed(R2TempCreds)({
      configured: true,
      endpoint: "https://r2.test",
      bucket: "archive",
      mint: () => Effect.succeed(new TempCredentials({ accessKeyId: "unused", secretAccessKey: "unused", sessionToken: "unused" })),
      presignGet: (candidate) => Effect.succeed(`https://r2.test/signed/${candidate}`)
    })
    const AssemblyTest = Layer.succeed(AssemblyAI)({
      submit: (audio) => Effect.sync(() => {
        if (audio._tag !== "url") throw new Error("expected url audio")
        submitted.push(audio.url)
        return { transcript: new VendorTranscript({ id: "t-never", status: "queued" }), raw: { id: "t-never", status: "queued" } }
      }),
      poll: () => Effect.fail(new Error("poll must not happen for a settled capture"))
    })
    const live = Layer.mergeAll(BunFileSystem.layer, BucketTest, R2Test, AssemblyTest)

    // The pass settles the capture: skipped, not failed; nothing submitted
    // and no jobs receipt -- and the settled marker records the chunk.
    expect(await Effect.runPromise(transcribeMediaCapture(captureId).pipe(Effect.provide(live)))).toBe("skipped")
    expect(submitted).toEqual([])
    expect(await Bun.file(dataPath(transcriptJobsKey(captureId))).exists()).toBe(false)
    const marker = await Bun.file(dataPath(transcriptSettledKey(captureId))).json()
    expect(marker.captureId).toBe(captureId)
    expect(marker.error).toContain(key)

    // Discovery now skips the capture entirely: a source pass neither
    // submits nor records a failure for it.
    const report = await Effect.runPromise(mediaTranscribeSource.ingest.pipe(Effect.provide(live)))
    expect(report.failures.map((failure) => failure.item)).not.toContain(`capture/${captureId}`)
    expect(submitted).toEqual([])
  })

  test("a chunk missing from R2 but present locally still fails retryably", async () => {
    const captureId = "remote-transcription-local-chunk"
    const key = `media/media-v1/${captureId}/chunk-0.ogg`
    await Effect.runPromise(
      Files.writeJson(dataPath(mediaManifestKey(captureId)), new MediaManifest({
        captureId,
        version: "media-v1",
        createdAt: new Date().toISOString(),
        sourceDurationSeconds: 5,
        chunks: [new MediaChunk({ index: 0, key, startSeconds: 0, durationSeconds: 5 })]
      })).pipe(Effect.provide(BunFileSystem.layer))
    )
    // The chunk survives locally: normalize can restore it to R2, so the
    // capture must NOT settle -- it fails with the usual error, no marker.
    await Bun.write(dataPath(key), new Uint8Array([1, 2, 3]))

    const BucketTest = Layer.succeed(Bucket)({
      configured: true,
      list: () => Effect.succeed([]),
      head: () => Effect.succeed(null),
      download: () => Effect.fail(new Error("audio download must never be called")),
      put: () => Effect.fail(new Error("audio put must not happen during transcription")),
      putFile: () => Effect.fail(new Error("audio putFile must not happen during transcription"))
    })
    const R2Test = Layer.succeed(R2TempCreds)({
      configured: true,
      endpoint: "https://r2.test",
      bucket: "archive",
      mint: () => Effect.succeed(new TempCredentials({ accessKeyId: "unused", secretAccessKey: "unused", sessionToken: "unused" })),
      presignGet: (candidate) => Effect.succeed(`https://r2.test/signed/${candidate}`)
    })
    const AssemblyTest = Layer.succeed(AssemblyAI)({
      submit: () => Effect.fail(new Error("submit must not happen while a chunk is missing")),
      poll: () => Effect.fail(new Error("poll must not happen while a chunk is missing"))
    })
    const live = Layer.mergeAll(BunFileSystem.layer, BucketTest, R2Test, AssemblyTest)

    const failed = await Effect.runPromise(transcribeMediaCapture(captureId).pipe(Effect.provide(live)))
      .then(() => null, (error: unknown) => error)
    expect(String(failed)).toContain("R2 media chunk missing for transcription")
    expect(await Bun.file(dataPath(transcriptSettledKey(captureId))).exists()).toBe(false)
    // Remove the manifest so no later source pass in this file keeps
    // discovering (and failing) this deliberately unsettled capture.
    await rm(dataPath(mediaManifestKey(captureId)), { force: true })
  })
})
