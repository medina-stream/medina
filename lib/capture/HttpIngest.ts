/**
 * Push ingest: an HTTP-posted body becomes a capture, uninterpreted.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import type { Bucket } from "../Bucket.ts"
import * as Files from "../Files.ts"
import { sha256 } from "../Hash.ts"
import { captureBlobName, captureDir, dataPath, Provenance, provenanceKey } from "../lifelog/Resources.ts"
import { archiveCapture } from "./Archive.ts"

/**
 * Ingest one HTTP-posted body (e.g. a GPS app posting location batches) as a
 * capture: contenthash identity, provenance beside the blob, zero
 * interpretation — a future resource derives daily summaries from these.
 *
 * The blob keeps a synthesized name carrying the only born metadata an HTTP
 * push has: the source name and receipt time.
 *
 * Unlike a Drive or bucket source, the pushing client keeps no copy — the
 * moment the response is sent, this host holds the only bytes. So the
 * capture is archived to the bucket before returning, best-effort: an
 * archive failure is logged, not surfaced, because the periodic sweep
 * (`archiveSweepSource`) retries every pass and refusing the ingest would
 * lose the bytes for sure rather than probably not.
 */
export const httpIngest = Effect.fn("httpIngest")(function*(
  source: string,
  bytes: Uint8Array,
  contentType: string
) {
  const fs = yield* FileSystem.FileSystem
  const receivedAt = new Date().toISOString()
  const captureId = sha256(bytes)

  const extension = contentType.includes("json")
    ? "json"
    : contentType.includes("csv")
      ? "csv"
      : contentType.includes("text")
        ? "txt"
        : "bin"
  const filename = `${source}-${receivedAt.replace(/[:.]/g, "")}.${extension}`

  const provenance = yield* Files.readJson(Provenance, dataPath(provenanceKey(captureId)))
  const existingRecords = Option.isSome(provenance) ? provenance.value.records : []
  const duplicate = existingRecords.length > 0

  if (!duplicate) {
    const blobKey = `${captureDir(captureId)}/${captureBlobName(filename)}`
    yield* fs.makeDirectory(dataPath(captureDir(captureId)), { recursive: true })
    yield* fs.writeFile(dataPath(blobKey), bytes)
  }

  // Duplicate content re-posted is still a sighting: append its provenance.
  yield* Files.writeJson(
    dataPath(provenanceKey(captureId)),
    new Provenance({
      captureId,
      records: [...existingRecords, {
        source: `http-${source}`,
        filename,
        fileId: captureId,
        mimeType: contentType,
        modifiedTime: receivedAt,
        md5Checksum: null,
        fetchedAt: receivedAt
      }]
    })
  )

  // Provenance changed even for duplicates, so reconcile either way.
  yield* archiveCapture(captureId).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`archive deferred for capture ${captureId.slice(0, 12)} (sweep will retry)`, cause)
    )
  )

  return { captureId, bytes: bytes.length, duplicate }
})
