/**
 * The audio source: Drive voice recordings become captures.
 *
 * Ingest stores the bytes under their sha256 (content identity) and records
 * everything Drive knew as provenance beside the blob. It never interprets
 * that metadata -- deciding when a capture happened is attribution's job --
 * and it never reads the audio: probing, transcoding and transcription are
 * pipeline stages over captures (see `Media.ts`). Ingest's whole contract
 * is "the bytes are safe and their story is recorded".
 */
import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as Files from "../Files.ts"
import { Drive, type DriveFile } from "../Drive.ts"
import type { Source } from "../Resource.ts"
import { makeItemSource } from "../Source.ts"
import {
  captureBlobName,
  captureDir,
  dataPath,
  IngestReceipt,
  ingestId,
  ingestReceiptKey,
  Provenance,
  provenanceKey,
  transcriptKey
} from "../lifelog/Resources.ts"

const AUDIO_SOURCE_NAME = "audio-drive"

export interface RecordingObject {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly modifiedTime: string
  readonly checksum?: string
}

/**
 * Stream chunks to `tmpPath` while hashing them; resolves to the hex sha256.
 * The caller picks a temp path on the same filesystem as the final home so
 * the later rename is atomic. A failed stream removes the partial file, so
 * no caller ever observes one.
 */
export const hashStreamToFile = (
  stream: Stream.Stream<Uint8Array, Error>,
  tmpPath: string
): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const hash = createHash("sha256")
    yield* Stream.run(
      Stream.tap(stream, (chunk) =>
        Effect.sync(() => {
          hash.update(chunk)
        })),
      fs.sink(tmpPath)
    ).pipe(
      Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
      Effect.onError(() => fs.remove(tmpPath, { force: true }).pipe(Effect.ignore))
    )
    return hash.digest("hex")
  })

/**
 * Ingest one Drive file: store the bytes as a capture named by their sha256
 * and preserve everything Drive knew about them as provenance beside the
 * blob (the filename is often the only clue to when a capture was recorded
 * — it must survive anything short of losing the data dir). The receipt
 * makes the next pass a single existence check, since the capture id is not
 * derivable without downloading the bytes. Probing and transcription happen
 * downstream, as stages over the capture.
 */
export const ingestAudioFile = Effect.fn("ingestAudioFile")(function*(
  sourceName: string,
  file: RecordingObject,
  download: Effect.Effect<Stream.Stream<Uint8Array, Error>, Error>
) {
  const fs = yield* FileSystem.FileSystem
  const version = file.checksum ?? file.modifiedTime
  const receiptKey = ingestReceiptKey(sourceName, file.id, version)
  if (yield* fs.exists(dataPath(receiptKey))) return "cached" as const
  if (!file.mimeType.startsWith("audio/")) {
    yield* Effect.logDebug(`skipping non-audio file ${file.name} (${file.mimeType})`)
    return "skipped" as const
  }

  // Grandfather: a transcript already exists under the pre-contenthash id.
  // Adopt that id as the capture id (audio bytes not retained; backfilling
  // legacy audio is a separate migration).
  const legacyId = ingestId(sourceName, file.id, version)
  if (yield* fs.exists(dataPath(transcriptKey(legacyId)))) {
    yield* Files.writeJson(
      dataPath(receiptKey),
      new IngestReceipt({ captureId: legacyId, ingestedAt: new Date().toISOString() })
    )
    return "cached" as const
  }

  yield* Effect.log(`capturing ${file.name}`)
  // Stream straight to disk while hashing: hours-long recordings can be
  // hundreds of MB, so the bytes must never sit in memory whole. The
  // capture id (content hash) is known only once the stream ends, hence a
  // temp file in the data dir (same filesystem, so the rename is atomic)
  // renamed into place afterwards. Nothing lists the data dir root, so the
  // temp file is invisible to enumeration while it exists.
  const tmpPath = dataPath(`tmp/capture-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  yield* fs.makeDirectory(dataPath("tmp"), { recursive: true })
  const captureId = yield* hashStreamToFile(yield* download, tmpPath)

  const blobKey = `${captureDir(captureId)}/${captureBlobName(file.name)}`
  if (yield* fs.exists(dataPath(blobKey))) {
    // Same bytes already captured (renamed re-upload, or a pass that died
    // between blob write and receipt): drop the duplicate download.
    yield* fs.remove(tmpPath)
  } else {
    yield* fs.makeDirectory(dataPath(captureDir(captureId)), { recursive: true })
    yield* fs.rename(tmpPath, dataPath(blobKey))
  }

  // Append this sighting to provenance unless already recorded: the same
  // content can arrive twice (renamed file, second source), and each
  // sighting's metadata is evidence.
  const provenance = yield* Files.readJson(Provenance, dataPath(provenanceKey(captureId)))
  const records = Option.isSome(provenance) ? provenance.value.records : []
  const seen = records.some((record) =>
    record.source === sourceName && record.fileId === file.id && record.filename === file.name
  )
  if (!seen) {
    yield* Files.writeJson(
      dataPath(provenanceKey(captureId)),
      new Provenance({
        captureId,
        records: [...records, {
          source: sourceName,
          filename: file.name,
          fileId: file.id,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
          md5Checksum: file.checksum ?? null,
          fetchedAt: new Date().toISOString()
        }]
      })
    )
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
): Source<Drive | FileSystem.FileSystem> => makeItemSource({
  name: AUDIO_SOURCE_NAME,
  discover: Effect.gen(function*() {
    const drive = yield* Drive
    const files = yield* drive.list(folderId, latest)
    yield* Effect.log(`discovered ${files.length} files`)
    return files
  }),
  ingest: (driveFile: DriveFile) => {
    const file: RecordingObject = {
      id: driveFile.id,
      name: driveFile.name,
      mimeType: driveFile.mimeType,
      modifiedTime: driveFile.modifiedTime,
      ...(driveFile.md5Checksum === undefined ? {} : { checksum: driveFile.md5Checksum })
    }
    return Effect.flatMap(Drive, (drive) => ingestAudioFile(AUDIO_SOURCE_NAME, file, drive.download(driveFile.id)))
  },
  label: (file) => file.name,
  concurrency: 2
})

/** Build an audio source for any object listing/downloader, including S3. */
export const recordingObjectSource = <R>(
  name: string,
  list: Effect.Effect<ReadonlyArray<RecordingObject>, Error, R>,
  download: (file: RecordingObject) => Effect.Effect<Stream.Stream<Uint8Array, Error>, Error, R>
): Source<R | FileSystem.FileSystem> => makeItemSource({
  name,
  discover: list,
  ingest: (file) => Effect.flatMap(download(file), (stream) => ingestAudioFile(name, file, Effect.succeed(stream))),
  label: (file) => file.name,
  concurrency: 2
})
