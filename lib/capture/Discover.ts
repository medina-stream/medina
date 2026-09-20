/**
 * Discovery for the bucket-backed ingest sources (capture audio, device
 * events, on-device transcripts).
 *
 * Every pass lists the whole source-bucket prefix (newest-first, as the
 * bucket layer sorts), drops whatever already has an ingest receipt, and
 * takes the per-pass work bound off the front. Ingest priority is newest
 * data first: newer captures are almost always more valuable. This is safe
 * against the 2026-09-18 starvation mode -- that stall came from slicing a
 * fixed window off the top of the listing *before* filtering receipted
 * objects. With the receipt filter first, the window always advances past
 * receipted objects, so newest-first ordering can't strand older ones.
 *
 * Why the receipt filter lives here: the ingest loop is receipt-guarded and
 * idempotent, so a pass only ever needs the next *un-ingested* objects. A
 * fixed window sliced off the top of the bucket listing instead starves
 * everything past the window -- newest-first dropped the middle of an upload
 * burst (the 34 never-ingested backlog segments of 2026-09-18), and the
 * oldest-first flip re-wedged the loop on the oldest cached/skipped objects,
 * ingesting nothing for two days. Filtering receipted objects before the
 * slice makes every pass advance, whatever the backlog size.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type { BucketObject, SourceBucketApi } from "../Bucket.ts"
import { dataPath, ingestReceiptKey } from "../lifelog/Resources.ts"

/**
 * Discover the next un-ingested objects under `prefix`: list everything,
 * map to source items, drop the ones that fail `ingestable` (permanently
 * skipped at ingest time, never receipted) and the ones that already have
 * an ingest receipt, then take `limit`.
 *
 * `identity` must match the receipt the source's ingest step writes:
 * `ingestReceiptKey(sourceName, key, version)`.
 */
export const discoverFresh = <T>(
  api: SourceBucketApi,
  sourceName: string,
  prefix: string,
  limit: number,
  toObjects: (objects: ReadonlyArray<BucketObject>) => ReadonlyArray<T>,
  identity: (item: T) => { readonly key: string; readonly version: string },
  ingestable: (item: T) => boolean = () => true
): Effect.Effect<ReadonlyArray<T>, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (limit <= 0) return []
    // The bucket layer pages the whole prefix and sorts newest-first
    // regardless of limit, so ask for everything: the receipt filter needs
    // to see the full backlog, and the slice below is the per-pass bound.
    const items = toObjects(yield* api.list(prefix, Number.MAX_SAFE_INTEGER))
    const fs = yield* FileSystem.FileSystem
    const fresh: Array<T> = []
    for (const item of items) {
      if (fresh.length >= limit) break
      if (!ingestable(item)) continue
      const { key, version } = identity(item)
      if (yield* fs.exists(dataPath(ingestReceiptKey(sourceName, key, version)))) continue
      fresh.push(item)
    }
    return fresh
  })
