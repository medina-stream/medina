/**
 * The audio source: Drive voice recordings become captures.
 *
 * Ingest stores the bytes under their sha256 (content identity) and records
 * everything Drive knew as provenance beside the blob. It never interprets
 * that metadata -- deciding when a capture happened is attribution's job.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as Files from "../lib/Files.ts"
import { AssemblyAI, type VendorTranscript } from "../lib/AssemblyAI.ts"
import { Drive, type DriveFile } from "../lib/Drive.ts"
import type { Source, SourceReport } from "../lib/Resource.ts"
import { sha256 } from "./Hash.ts"
import {
  captureBlobName,
  captureDir,
  captureTime,
  dataPath,
  IngestReceipt,
  ingestId,
  ingestReceiptKey,
  Provenance,
  provenanceKey,
  Transcript,
  TRANSCRIPT_VERSION,
  transcriptKey,
  vendorKey
} from "./Resources.ts"

const AUDIO_SOURCE_NAME = "easy-voice"

const normalize = (file: DriveFile, id: string, vendor: VendorTranscript): Transcript =>
  new Transcript({
    provider: "assemblyai",
    version: TRANSCRIPT_VERSION,
    ingestId: id,
    inputKey: `in/${id}`,
    capturedAt: captureTime(file.name, file.modifiedTime),
    transcriptId: vendor.id,
    vendorKey: vendorKey(id),
    status: vendor.status === "completed" ? "completed" : "error",
    completedAt: new Date().toISOString(),
    text: vendor.text ?? null,
    utterances: (vendor.utterances ?? []).map((utterance) => ({
      speaker: utterance.speaker ?? null,
      startMs: utterance.start,
      endMs: utterance.end,
      text: utterance.text,
      confidence: utterance.confidence ?? null
    })),
    error: vendor.error ?? null
  })

/**
 * Ingest one Drive file: store the bytes as a capture named by their sha256,
 * preserve everything Drive knew about them as provenance beside the blob
 * (the filename is often the only clue to when a capture was recorded — it
 * must survive anything short of losing the data dir), and transcribe. The
 * receipt makes the next pass a single existence check, since the capture id
 * is not derivable without downloading the bytes.
 */
const ingestAudioFile = Effect.fn("ingestAudioFile")(function*(file: DriveFile) {
  const fs = yield* FileSystem.FileSystem
  const receiptKey = ingestReceiptKey(AUDIO_SOURCE_NAME, file.id, file.md5Checksum ?? file.modifiedTime)
  if (yield* fs.exists(dataPath(receiptKey))) return "cached" as const
  if (!file.mimeType.startsWith("audio/")) {
    yield* Effect.logDebug(`skipping non-audio file ${file.name} (${file.mimeType})`)
    return "skipped" as const
  }

  // Grandfather: a transcript already exists under the pre-contenthash id.
  // Adopt that id as the capture id (audio bytes not retained; backfilling
  // legacy audio is a separate migration).
  const legacyId = ingestId(AUDIO_SOURCE_NAME, file.id, file.md5Checksum ?? file.modifiedTime)
  if (yield* fs.exists(dataPath(transcriptKey(legacyId)))) {
    yield* Files.writeJson(
      dataPath(receiptKey),
      new IngestReceipt({ captureId: legacyId, ingestedAt: new Date().toISOString() })
    )
    return "cached" as const
  }

  yield* Effect.log(`capturing ${file.name}`)
  const drive = yield* Drive
  const chunks: Array<Uint8Array> = []
  yield* Stream.runForEach(yield* drive.download(file.id), (chunk) =>
    Effect.sync(() => {
      chunks.push(chunk)
    }))
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const captureId = sha256(bytes)

  const blobKey = `${captureDir(captureId)}/${captureBlobName(file.name)}`
  if (!(yield* fs.exists(dataPath(blobKey)))) {
    yield* fs.makeDirectory(dataPath(captureDir(captureId)), { recursive: true })
    yield* fs.writeFile(dataPath(blobKey), bytes)
  }

  // Append this sighting to provenance unless already recorded: the same
  // content can arrive twice (renamed file, second source), and each
  // sighting's metadata is evidence.
  const provenance = yield* Files.readJson(Provenance, dataPath(provenanceKey(captureId)))
  const records = Option.isSome(provenance) ? provenance.value.records : []
  const seen = records.some((record) =>
    record.source === AUDIO_SOURCE_NAME && record.fileId === file.id && record.filename === file.name
  )
  if (!seen) {
    yield* Files.writeJson(
      dataPath(provenanceKey(captureId)),
      new Provenance({
        captureId,
        records: [...records, {
          source: AUDIO_SOURCE_NAME,
          filename: file.name,
          fileId: file.id,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
          md5Checksum: file.md5Checksum ?? null,
          fetchedAt: new Date().toISOString()
        }]
      })
    )
  }

  if (!(yield* fs.exists(dataPath(transcriptKey(captureId))))) {
    yield* Effect.log(`transcribing ${file.name}`)
    const assemblyai = yield* AssemblyAI
    const audio = fs.stream(dataPath(blobKey)).pipe(Stream.mapError((cause) => new Error(String(cause))))
    const vendor = yield* assemblyai.transcribe(audio)
    yield* Files.writeJson(dataPath(vendorKey(captureId)), vendor)
    yield* Files.writeJson(dataPath(transcriptKey(captureId)), normalize(file, captureId, vendor))
  }

  yield* Files.writeJson(
    dataPath(receiptKey),
    new IngestReceipt({ captureId, ingestedAt: new Date().toISOString() })
  )
  return "ingested" as const
})

export const audioSource = (
  folderId: string,
  latest: number
): Source<Drive | AssemblyAI | FileSystem.FileSystem> => ({
  name: AUDIO_SOURCE_NAME,
  ingest: Effect.gen(function*() {
    const drive = yield* Drive
    const files = yield* drive.list(folderId, latest)
    yield* Effect.log(`discovered ${files.length} files`)
    const failures: Array<{ item: string; error: string }> = []
    // Bounded concurrency; one failure doesn't stop the rest.
    const outcomes = yield* Effect.forEach(files, (file) =>
      ingestAudioFile(file).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`ingest failed for ${file.name}`, cause).pipe(
            Effect.tap(() => Effect.sync(() => failures.push({ item: file.name, error: String(cause).slice(0, 500) }))),
            Effect.as("failed" as const)
          )
        )
      ), { concurrency: 2 })
    const count = (outcome: string) => outcomes.filter((entry) => entry === outcome).length
    return {
      discovered: files.length,
      ingested: count("ingested"),
      cached: count("cached"),
      skipped: count("skipped"),
      failures
    } satisfies SourceReport
  })
})
