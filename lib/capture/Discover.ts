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
 *
 * Discovery state now persists in one index file per source
 * (`discovery/<source>/index-v1.json`, read once per pass): the last-seen
 * objects (the pending backlog included), the newest-seen cursor, and —
 * via one `ingest/<source>` listing per pass, the way `readCorrections`
 * batches corrections — the receipted set. A warm pass therefore asks the
 * bucket only for the newest `limit` objects (a new upload is by
 * construction among the newest), merges them into the index, and serves
 * the per-pass window from the index — it neither enumerates the whole
 * prefix nor stats a receipt file per candidate. Only a cold index (or a
 * truncated first listing) expands the request until the listing is
 * exhaustive, so a first pass still learns the whole backlog.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Files from "../Files.ts"
import { topNewest, type BucketObject, type SourceBucketApi } from "../Bucket.ts"
import { dataPath, ingestReceiptKey } from "../lifelog/Resources.ts"

export const DISCOVERY_INDEX_VERSION = "discovery-index-v1"

export const discoveryIndexKey = (sourceName: string) =>
  `discovery/${sourceName.replace(/[^a-zA-Z0-9_-]/g, "")}/index-v1.json`

class SeenObject extends Schema.Class<SeenObject>("DiscoverySeenObject")({
  key: Schema.String,
  size: Schema.NullOr(Schema.Number),
  etag: Schema.NullOr(Schema.String),
  lastModified: Schema.NullOr(Schema.String)
}) {}

export class DiscoveryIndex extends Schema.Class<DiscoveryIndex>("DiscoveryIndex")({
  version: Schema.String,
  updatedAt: Schema.String,
  /** Newest `lastModified` seen so far (null before the first listing). */
  cursor: Schema.NullOr(Schema.String),
  seen: Schema.Array(SeenObject)
}) {}

const emptyIndex = () =>
  new DiscoveryIndex({ version: DISCOVERY_INDEX_VERSION, updatedAt: "", cursor: null, seen: [] })

/** Receipt file names for a source, from one listing — never a stat per candidate. */
const receiptedNames = (sourceName: string) =>
  Effect.map(
    Files.listFiles(dataPath(`ingest/${sourceName}`)),
    (entries) => new Set(entries.map((entry) => entry.split("/").pop()!.replace(/\.json$/, "")))
  )

const receiptName = (sourceName: string, key: string, version: string) =>
  ingestReceiptKey(sourceName, key, version).split("/").pop()!.replace(/\.json$/, "")

/**
 * Discover the next un-ingested objects under `prefix`: merge the newest
 * bucket listing into the persisted index, drop items that fail
 * `ingestable` (permanently skipped at ingest time, never receipted) and
 * the ones that already have an ingest receipt, then take `limit`,
 * newest-first.
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
    const indexPath = dataPath(discoveryIndexKey(sourceName))
    const stored = yield* Files.readJson(DiscoveryIndex, indexPath).pipe(
      Effect.orElseSucceed(() => Option.none<DiscoveryIndex>())
    )
    const index = Option.isSome(stored) ? stored.value : emptyIndex()

    // Bounded newest-first listing. A listing that comes back short (or,
    // from a stub, over-long) is exhaustive; one that exactly fills the
    // request may be truncated. Only a cold index expands a truncated
    // listing until it is exhaustive — warm passes trust the persisted
    // pending backlog and stay on the first, bounded request.
    let requested = limit
    let listed = yield* api.list(prefix, requested)
    const exhaustive = (objects: ReadonlyArray<BucketObject>, wanted: number) => objects.length !== wanted
    while (index.seen.length === 0 && !exhaustive(listed, requested)) {
      requested *= 4
      const next = yield* api.list(prefix, requested)
      if (next.length === listed.length) {
        listed = next
        break
      }
      listed = next
    }

    const receipted = yield* receiptedNames(sourceName)
    const isReceipted = (item: T) => {
      const { key, version } = identity(item)
      return receipted.has(receiptName(sourceName, key, version))
    }

    // Merge into the seen set (keyed by object key; a re-upload replaces).
    // An exhaustive listing replaces the seen set outright, so objects
    // that left the bucket leave the index; a truncated one merges, so
    // the pending backlog below the newest window survives.
    const seenByKey = new Map<string, BucketObject>()
    if (!exhaustive(listed, requested)) {
      for (const object of index.seen) seenByKey.set(object.key, object)
    }
    for (const object of listed) seenByKey.set(object.key, object)
    const seen = topNewest([...seenByKey.values()], Number.MAX_SAFE_INTEGER)

    // Receipted objects leave the index; the rest is the pending backlog,
    // newest-first, from which this pass takes its window.
    const pending = toObjects(seen).filter((item) => !isReceipted(item))
    const fresh: Array<T> = []
    for (const item of pending) {
      if (fresh.length >= limit) break
      if (!ingestable(item)) continue
      fresh.push(item)
    }

    // Persist what is still pending (as bucket objects, so the caller's
    // mapping is re-applied next pass) plus the newest-seen cursor.
    const pendingIdentities = new Set(pending.map((item) => identity(item).key))
    const kept = seen.filter((object) => pendingIdentities.has(object.key))
    const cursor = seen.reduce<string | null>(
      (max, object) => (object.lastModified !== null && (max === null || object.lastModified > max) ? object.lastModified : max),
      index.cursor
    )
    yield* Files.writeJson(indexPath, new DiscoveryIndex({
      version: DISCOVERY_INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      cursor,
      seen: kept.map((object) => new SeenObject({
        key: object.key,
        size: object.size,
        etag: object.etag,
        lastModified: object.lastModified
      }))
    })).pipe(Effect.ignore)

    return fresh
  })
