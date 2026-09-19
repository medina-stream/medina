/**
 * The on-device transcript source: the Android capture app transcribes its
 * latest segment locally (whisper.cpp) and uploads the result beside the
 * audio, under `<install-id>/transcript/YYYY/MM/DD/<utc>-<uuid>.json`.
 * This source ingests those first-look transcripts so the journal can
 * reflect recent events before the vendor transcription lands.
 *
 * Like the capture bucket source, this is ingest-only: the SourceBucket API
 * has no write operations.
 *
 * The phone computes the capture id itself (sha256 of the audio bytes, the
 * same content identity the audio ingest derives), so no audio download is
 * needed to file the transcript.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as Files from "../Files.ts"
import type { BucketObject, SourceBucketApi } from "../Bucket.ts"
import type { Source } from "../Resource.ts"
import { makeItemSource } from "../Source.ts"
import {
  dataPath,
  IngestReceipt,
  ingestReceiptKey,
  liveTranscriptKey,
  liveTranscriptPromotedKey,
  localTranscriptKey,
  parseCaptureAudioKey,
  Transcript,
  Utterance
} from "../lifelog/Resources.ts"

export const LOCAL_TRANSCRIPT_SOURCE_NAME = "local-transcripts"

interface LocalTranscriptObject {
  readonly key: string
  readonly version: string
}

export const transcriptObjects = (
  objects: ReadonlyArray<BucketObject>
): ReadonlyArray<LocalTranscriptObject> =>
  objects
    .filter((object) => object.key.includes("/transcript/") && object.key.endsWith(".json"))
    .map((object) => ({
      key: object.key,
      version: object.etag ?? object.lastModified ?? ""
    }))

interface PhoneTranscript {
  readonly captureId: string
  readonly audioKey: string
  readonly capturedAt: string | null
  readonly engine: string
  readonly model: string
  readonly language: string
  readonly segments: ReadonlyArray<{ start: number; end: number; text: string }>
  readonly text: string
}

export const parsePhoneTranscript = (raw: unknown): PhoneTranscript | null => {
  if (typeof raw !== "object" || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o["schemaVersion"] !== 1) return null
  const captureId = o["captureId"]
  const text = o["text"]
  const segments = o["segments"]
  if (typeof captureId !== "string" || !/^[0-9a-f]{64}$/.test(captureId)) return null
  if (typeof text !== "string" || !Array.isArray(segments)) return null
  for (const s of segments) {
    if (typeof s !== "object" || s === null) return null
    const seg = s as Record<string, unknown>
    if (typeof seg["start"] !== "number" || typeof seg["end"] !== "number" || typeof seg["text"] !== "string") return null
  }
  return {
    captureId,
    audioKey: typeof o["audioKey"] === "string" ? o["audioKey"] : "",
    capturedAt: typeof o["capturedAt"] === "string" ? o["capturedAt"] : null,
    engine: typeof o["engine"] === "string" ? o["engine"] : "whisper.cpp",
    model: typeof o["model"] === "string" ? o["model"] : "",
    language: typeof o["language"] === "string" ? o["language"] : "en",
    segments: segments as PhoneTranscript["segments"],
    text
  }
}

interface LivePhoneTranscript {
  readonly segmentUuid: string
  readonly installId: string
  readonly capturedAt: string | null
  readonly updateSeq: number
  readonly segments: ReadonlyArray<{ start: number; end: number; text: string }>
  readonly text: string
}

/**
 * A live partial for an in-progress segment: same envelope as the final
 * first-look, but keyed by segment UUID (the content hash doesn't exist yet)
 * and overwritten on every tick. Null when the payload isn't a live partial.
 */
export const parseLivePhoneTranscript = (raw: unknown): LivePhoneTranscript | null => {
  if (typeof raw !== "object" || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o["schemaVersion"] !== 1 || o["live"] !== true) return null
  const segmentUuid = o["segmentUuid"]
  const installId = o["installId"]
  const text = o["text"]
  const segments = o["segments"]
  if (typeof segmentUuid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segmentUuid)) return null
  if (typeof installId !== "string" || installId.length === 0) return null
  if (typeof text !== "string" || !Array.isArray(segments)) return null
  for (const s of segments) {
    if (typeof s !== "object" || s === null) return null
    const seg = s as Record<string, unknown>
    if (typeof seg["start"] !== "number" || typeof seg["end"] !== "number" || typeof seg["text"] !== "string") return null
  }
  return {
    segmentUuid,
    installId,
    capturedAt: typeof o["capturedAt"] === "string" ? o["capturedAt"] : null,
    updateSeq: typeof o["updateSeq"] === "number" ? o["updateSeq"] : 0,
    segments: segments as LivePhoneTranscript["segments"],
    text
  }
}

const utterancesFromSegments = (
  segments: ReadonlyArray<{ start: number; end: number; text: string }>
): ReadonlyArray<Utterance> =>
  segments.map((s) =>
    new Utterance({
      speaker: null,
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
      text: s.text,
      confidence: null
    })
  )

const transcriptFromPhone = (
  parsed: { capturedAt: string | null; segments: LivePhoneTranscript["segments"]; text: string },
  version: string,
  ingestId: string,
  inputKey: string
): Transcript =>
  new Transcript({
    provider: "ondevice",
    version,
    ingestId,
    inputKey,
    capturedAt: parsed.capturedAt ?? undefined,
    transcriptId: null,
    vendorKey: null,
    status: "completed",
    completedAt: new Date().toISOString(),
    text: parsed.text,
    utterances: utterancesFromSegments(parsed.segments),
    error: null
  })

/**
 * Promote a live provisional to the sealed capture's first-look key once the
 * segment's audio is ingested and its content-hash capture id is known. The
 * provisional is removed and a marker left behind so a racing partial can't
 * resurrect it. A batch final that already filed `.ondevice.json` is never
 * clobbered — it transcribes the whole file, so it's the better text.
 */
export const promoteLiveTranscript = (
  objectKey: string,
  captureId: string
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const parsed = parseCaptureAudioKey(objectKey)
    if (parsed === null) return
    const fs = yield* FileSystem.FileSystem
    const liveKey = dataPath(liveTranscriptKey(parsed.installId, parsed.segmentUuid))
    if (!(yield* fs.exists(liveKey))) return
    const provisional = yield* Files.readJson(Transcript, liveKey)
    const target = dataPath(localTranscriptKey(captureId))
    if (Option.isSome(provisional) && !(yield* fs.exists(target))) {
      yield* Files.writeJson(target, provisional.value)
    } else if (Option.isNone(provisional)) {
      yield* Effect.logWarning(`live provisional ${liveKey} failed validation; dropping`)
    }
    yield* fs.remove(liveKey)
    yield* Files.writeJson(
      dataPath(liveTranscriptPromotedKey(parsed.installId, parsed.segmentUuid)),
      new IngestReceipt({ captureId, ingestedAt: new Date().toISOString() })
    )
  })

const ingestLiveTranscript = (
  api: SourceBucketApi,
  item: LocalTranscriptObject
): Effect.Effect<"ingested" | "cached" | "skipped", Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const receiptKey = dataPath(ingestReceiptKey(LOCAL_TRANSCRIPT_SOURCE_NAME, item.key, item.version))
    if (yield* fs.exists(receiptKey)) return "cached" as const

    const bytes = yield* (yield* api.download(item.key)).pipe(Stream.runCollect)
    const raw = JSON.parse(Buffer.concat([...bytes] as Uint8Array[]).toString("utf-8"))
    const parsed = parseLivePhoneTranscript(raw)
    if (parsed === null) {
      yield* Effect.logWarning(`live transcript ${item.key} failed validation; recording receipt to skip`)
      yield* Files.writeJson(receiptKey, new IngestReceipt({ captureId: "", ingestedAt: new Date().toISOString() }))
      return "skipped" as const
    }

    // A partial that raced the seal must not resurrect a promoted provisional.
    const promotedKey = dataPath(liveTranscriptPromotedKey(parsed.installId, parsed.segmentUuid))
    if (yield* fs.exists(promotedKey)) {
      yield* Files.writeJson(receiptKey, new IngestReceipt({ captureId: "", ingestedAt: new Date().toISOString() }))
      return "cached" as const
    }

    // Overwrite every tick: the object key is stable per segment, so each
    // upload carries a new etag and re-ingests here.
    yield* Files.writeJson(
      dataPath(liveTranscriptKey(parsed.installId, parsed.segmentUuid)),
      transcriptFromPhone(parsed, `live-${parsed.updateSeq}`, `live/${parsed.installId}/${parsed.segmentUuid}`, item.key)
    )
    yield* Files.writeJson(receiptKey, new IngestReceipt({ captureId: "", ingestedAt: new Date().toISOString() }))
    return "ingested" as const
  })

export const ingestLocalTranscript = (
  api: SourceBucketApi,
  item: LocalTranscriptObject
): Effect.Effect<"ingested" | "cached" | "skipped", Error, FileSystem.FileSystem> =>
  // Live partials take the provisional path; sealed-segment finals keep the capture-id path.
  item.key.endsWith(".live.json") ? ingestLiveTranscript(api, item) : ingestFinalTranscript(api, item)

const ingestFinalTranscript = (
  api: SourceBucketApi,
  item: LocalTranscriptObject
): Effect.Effect<"ingested" | "cached" | "skipped", Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const receiptKey = dataPath(ingestReceiptKey(LOCAL_TRANSCRIPT_SOURCE_NAME, item.key, item.version))
    if (yield* fs.exists(receiptKey)) return "cached" as const

    const bytes = yield* (yield* api.download(item.key)).pipe(Stream.runCollect)
    const raw = JSON.parse(Buffer.concat([...bytes] as Uint8Array[]).toString("utf-8"))
    const parsed = parsePhoneTranscript(raw)
    if (parsed === null) {
      yield* Effect.logWarning(`local transcript ${item.key} failed validation; recording receipt to skip`)
      yield* Files.writeJson(receiptKey, new IngestReceipt({ captureId: "", ingestedAt: new Date().toISOString() }))
      return "skipped" as const
    }

    // Always write: the batch final transcribes the whole sealed file, so it
    // is the authoritative first-look and wins over a promoted live provisional
    // regardless of ingest order.
    const key = dataPath(localTranscriptKey(parsed.captureId))
    yield* Files.writeJson(
      key,
      transcriptFromPhone(parsed, "1", parsed.captureId, parsed.audioKey)
    )
    yield* Files.writeJson(
      receiptKey,
      new IngestReceipt({ captureId: parsed.captureId, ingestedAt: new Date().toISOString() })
    )
    return "ingested" as const
  })

/**
 * Build the pipeline source for on-device first-look transcripts. The api
 * exposes no write operations, so this source cannot store anything in the
 * bucket -- ingest-only by construction.
 */
export const localTranscriptSource = (
  api: SourceBucketApi,
  prefix: string,
  limit: number
): Source<FileSystem.FileSystem> =>
  makeItemSource({
    name: LOCAL_TRANSCRIPT_SOURCE_NAME,
    discover: api.list(prefix, limit).pipe(Effect.map(transcriptObjects)),
    ingest: (item) => ingestLocalTranscript(api, item),
    label: (item) => item.key,
    concurrency: "unbounded"
  })
