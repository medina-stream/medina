/**
 * The capture bucket source: medina ingests recordings the Android capture
 * app uploads to its bucket, and never writes back.
 *
 * The bucket is read through the SourceBucket service (lib/Bucket.ts), whose
 * API has no write operations at all -- the pipeline physically cannot store
 * anything there. The archive sweep keeps writing to the archive Bucket.
 *
 * Object keys look like `<install-id>/audio/YYYY/MM/DD/<utc>-<uuid>.m4a`
 * (audio) and `<install-id>/location/YYYY/MM/DD/<utc>-<uuid>.json`
 * (location). Only audio is ingested; everything else -- the settings
 * validation probe objects under `probe/`, location JSON -- is skipped
 * before any download.
 */
import type * as FileSystem from "effect/FileSystem"
import type { BucketObject, SourceBucketApi } from "../Bucket.ts"
import type { Source } from "../Resource.ts"
import { recordingObjectSource, type RecordingObject } from "./Audio.ts"
import { discoverFresh } from "./Discover.ts"

export const CAPTURE_BUCKET_SOURCE_NAME = "capture-bucket"

/** The audio the capture app writes is M4A; ingest keys off the extension. */
const mimeForKey = (key: string): string =>
  key.toLowerCase().endsWith(".m4a") ? "audio/mp4" : "application/octet-stream"

/**
 * Map a raw bucket listing to ingestable recording objects. Probe objects
 * (the app's settings validation leaves a zero-byte `probe/<uuid>` behind)
 * are dropped here so they never reach ingest; non-audio keys map to a
 * non-audio mime type, which ingestAudioFile skips without downloading.
 */
export const captureBucketObjects = (
  objects: ReadonlyArray<BucketObject>
): ReadonlyArray<RecordingObject> =>
  objects
    .filter((object) => !object.key.startsWith("probe/"))
    .map((object) => ({
      id: object.key,
      name: object.key.split("/").pop() || object.key,
      mimeType: mimeForKey(object.key),
      modifiedTime: object.lastModified ?? new Date(0).toISOString(),
      ...(object.etag === null ? {} : { checksum: object.etag })
    }))

/**
 * Build the pipeline source for a source-only bucket. The api exposes no
 * write operations, so this source cannot store anything in the bucket --
 * ingest-only by construction.
 */
export const captureBucketSource = (
  api: SourceBucketApi,
  prefix: string,
  limit: number
): Source<FileSystem.FileSystem> =>
  recordingObjectSource(
    CAPTURE_BUCKET_SOURCE_NAME,
    discoverFresh(
      api,
      CAPTURE_BUCKET_SOURCE_NAME,
      prefix,
      limit,
      captureBucketObjects,
      (file) => ({ key: file.id, version: file.checksum ?? file.modifiedTime }),
      // Non-audio keys are skipped at ingest without a receipt, so they
      // would occupy the window forever: drop them at discovery instead.
      (file) => file.mimeType.startsWith("audio/")
    ),
    (file) => api.download(file.id)
  )
