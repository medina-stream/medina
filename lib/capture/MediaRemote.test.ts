import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { AssemblyAI, VendorTranscript } from "../AssemblyAI.ts"
import { Bucket } from "../Bucket.ts"
import * as Files from "../Files.ts"
import { R2TempCreds, TempCredentials } from "../R2TempCreds.ts"
import { DATA_DIR, dataPath, Transcript, transcriptKey } from "../lifelog/Resources.ts"
import {
  MediaChunk,
  MediaManifest,
  mediaManifestKey,
  transcribeMediaCapture,
  transcriptJobsKey,
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
      submit: (url) => Effect.sync(() => {
        submitted.push(url)
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
})
