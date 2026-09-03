/**
 * Push ingest: an HTTP-posted body becomes a capture, uninterpreted.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Files from "../lib/Files.ts"
import { sha256 } from "./Hash.ts"
import { captureBlobName, captureDir, dataPath, Provenance, provenanceKey } from "./Resources.ts"

/**
 * Ingest one HTTP-posted body (e.g. a GPS app posting location batches) as a
 * capture: contenthash identity, provenance beside the blob, zero
 * interpretation — a future resource derives daily summaries from these.
 *
 * The blob keeps a synthesized name carrying the only born metadata an HTTP
 * push has: the source name and receipt time.
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

  return { captureId, bytes: bytes.length, duplicate }
})
