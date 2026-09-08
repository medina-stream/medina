/**
 * Capture archival: the bucket is the durable home for born evidence.
 *
 * The local data dir remains the working set and the derivation cache --
 * everything under `journal/`, `index/`, `attribution/` is rebuildable from
 * captures -- but the captures themselves are not rebuildable from anything.
 * A VM disk is not an archive, so every file under `capture/` must also
 * exist in the bucket before the data is considered safe.
 *
 * Bucket keys mirror artifact keys exactly (`capture/<sha256>/<file>`): the
 * archive is readable with `aws s3 ls` and nothing else, and restoring a
 * data dir is a plain `aws s3 sync` in either direction.
 *
 * `archiveSweepSource` is the guarantee: a pipeline stage that walks
 * `capture/` and uploads anything the bucket is missing. A per-capture
 * receipt under `archive/v1/` makes a settled pass one local read per
 * capture -- no bucket round-trips. The receipt is a cache of bucket state,
 * not the truth: when it is missing or stale the sweep asks the bucket
 * (`head`) before uploading, so deleting `archive/` re-verifies instead of
 * re-uploading, and two hosts sharing one bucket converge.
 *
 * `archiveCapture` is the same reconciliation for one capture, for callers
 * that want promptness (the HTTP push route archives its capture right
 * away, because unlike Drive the pushing client keeps no copy). Both paths
 * are idempotent and safe to race: content-addressed keys mean a double
 * upload writes the same bytes.
 *
 * Provenance files are mutable (each re-sighting appends a record), so a
 * size change re-uploads them; blobs are immutable under their hash and are
 * verified by size alone.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Bucket } from "../Bucket.ts"
import * as Files from "../Files.ts"
import type { Source } from "../Resource.ts"
import { makeItemSource } from "../Source.ts"
import { captureDir, dataPath } from "../lifelog/Resources.ts"

export const ARCHIVE_VERSION = "archive-v1"

/** Local receipt: which of a capture's files the bucket is known to hold. */
export const archiveReceiptKey = (captureId: string) => `archive/${ARCHIVE_VERSION}/${captureId}.json`

export class ArchivedFile extends Schema.Class<ArchivedFile>("ArchivedFile")({
  name: Schema.String,
  size: Schema.Number,
  etag: Schema.NullOr(Schema.String),
  uploadedAt: Schema.String
}) {}

export class ArchiveReceipt extends Schema.Class<ArchiveReceipt>("ArchiveReceipt")({
  captureId: Schema.String,
  files: Schema.Array(ArchivedFile)
}) {}

const contentTypeFor = (name: string) => {
  const extension = name.split(".").pop()?.toLowerCase() ?? ""
  return {
    json: "application/json",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    aac: "audio/aac",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    csv: "text/csv",
    txt: "text/plain"
  }[extension]
}

/**
 * Reconcile one capture with the bucket; resolves to how many files were
 * uploaded. Fails only on bucket errors (an unconfigured bucket included);
 * a capture directory that has vanished resolves to 0.
 */
export const archiveCapture = (
  captureId: string
): Effect.Effect<number, Error, Bucket | FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const bucket = yield* Bucket
    const dir = dataPath(captureDir(captureId))
    const names = yield* Files.listFiles(dir)
    if (names.length === 0) return 0

    const receipt = yield* Files.readJson(ArchiveReceipt, dataPath(archiveReceiptKey(captureId))).pipe(
      Effect.orElseSucceed(() => Option.none<ArchiveReceipt>())
    )
    const known = new Map(
      Option.isSome(receipt) ? receipt.value.files.map((file) => [file.name, file]) : []
    )

    let uploaded = 0
    let changed = false
    const files: Array<ArchivedFile> = []
    for (const name of names) {
      const path = `${dir}/${name}`
      const size = Number((yield* fs.stat(path).pipe(
        Effect.mapError((cause) => new Error(String(cause)))
      )).size)
      const bucketKey = `${captureDir(captureId)}/${name}`

      const existing = known.get(name)
      if (existing !== undefined && existing.size === size) {
        files.push(existing)
        continue
      }

      // No receipt (or the file grew): ask the bucket before uploading, so
      // a lost receipt re-verifies instead of re-pushing hundreds of MB.
      const remote = yield* bucket.head(bucketKey)
      if (remote !== null && remote.size === size) {
        files.push(new ArchivedFile({
          name,
          size,
          etag: remote.etag,
          uploadedAt: remote.lastModified ?? new Date().toISOString()
        }))
        changed = true
        continue
      }

      const etag = yield* bucket.putFile(bucketKey, path, contentTypeFor(name))
      files.push(new ArchivedFile({ name, size, etag, uploadedAt: new Date().toISOString() }))
      uploaded += 1
      changed = true
    }

    if (changed || Option.isNone(receipt)) {
      yield* Files.writeJson(
        dataPath(archiveReceiptKey(captureId)),
        new ArchiveReceipt({ captureId, files })
      )
    }
    return uploaded
  })

/**
 * The archive guarantee as a pipeline stage: every pass, every capture on
 * disk is reconciled with the bucket. Settled captures cost one receipt
 * read each. An unconfigured bucket fails the stage, which is the point:
 * pipeline status shows `archive: failing` until the deployment has a
 * durable home for its evidence.
 */
export const archiveSweepSource: Source<Bucket | FileSystem.FileSystem> = makeItemSource({
  name: "archive",
  discover: Effect.gen(function*() {
    const bucket = yield* Bucket
    if (!bucket.configured) {
      return yield* Effect.fail(
        new Error("bucket is not configured; captures have no durable home "
          + "(set BUCKET_NAME and BUCKET_ENDPOINT)")
      )
    }
    const entries = yield* Files.listFiles(dataPath("capture"))
    const captureIds = [...new Set(entries.map((entry) => entry.split("/")[0]!))]
    return captureIds.sort()
  }),
  ingest: (captureId) =>
    Effect.map(archiveCapture(captureId), (uploaded) => uploaded > 0 ? "ingested" : "cached"),
  label: (captureId) => `capture/${captureId}`,
  concurrency: 2
})
