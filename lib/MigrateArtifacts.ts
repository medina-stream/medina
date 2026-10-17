/**
 * One-shot migration of the artifact tree from a local data dir to the
 * bucket store: every artifact keeps its exact key (the key space is the
 * contract — see docs/storage-layout.md), lands in the bucket, and is
 * registered in the index.
 *
 * Idempotent and resumable by construction: an artifact whose bucket
 * object already exists with the local size is skipped (its index
 * registration is still refreshed — registration is the resumable part
 * after a crash between upload and register). Keys are content/basis
 * addressed, so same-key-different-bytes does not occur for derived
 * artifacts; the one mutable-in-place family, capture provenance, grows
 * monotonically and is caught by the size check when it changes. The
 * final verification pass re-fetches a deterministic sample of migrated
 * objects and hash-compares them against the source.
 *
 * Runnable on medina-dev, where the Archil mount is local; the CLI is
 * scripts/migrate-artifacts-to-bucket.ts. Nothing here runs on import.
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { ArtifactStoreApi, IndexClientApi } from "./ArtifactStore.ts"
import { sha256 } from "./Hash.ts"

export interface MigrationOptions {
  /** Only migrate keys under this prefix (directory-bounded). */
  readonly prefix?: string
  /** Report what would happen; write nothing, register nothing. */
  readonly dryRun?: boolean
  /** Sample size for the post-migration hash verification. Default 25. */
  readonly sampleSize?: number
  /** At or below this size, uploads go through memory; above it, the
   * store's streamed putFile path is used. Default 16 MiB. */
  readonly putFileThresholdBytes?: number
  /** Sampled objects larger than this are size-verified instead of
   * hash-verified, so verification never buffers a huge blob.
   * Default 64 MiB. */
  readonly hashVerifyMaxBytes?: number
  readonly log?: (line: string) => void
}

export interface MigrationSummary {
  readonly dryRun: boolean
  readonly scanned: number
  readonly uploaded: number
  readonly wouldUpload: number
  readonly skipped: number
  readonly failures: ReadonlyArray<{ readonly key: string; readonly error: string }>
  readonly bytesTotal: number
  readonly bytesUploaded: number
  readonly byPrefix: Record<string, { readonly count: number; readonly bytes: number }>
  readonly verification: {
    readonly sampled: number
    readonly hashMatched: number
    readonly sizeVerified: number
    readonly mismatches: ReadonlyArray<string>
  }
}

const DEFAULTS = {
  sampleSize: 25,
  putFileThresholdBytes: 16 * 1024 * 1024,
  hashVerifyMaxBytes: 64 * 1024 * 1024
}

/** Deterministic stride sample: stable across runs, spread over the
 * whole sorted key space rather than clustered at its head. */
const sampleOf = (keys: ReadonlyArray<string>, sampleSize: number): ReadonlyArray<string> => {
  if (keys.length <= sampleSize) return keys
  const step = keys.length / sampleSize
  const picked: Array<string> = []
  for (let i = 0; i < sampleSize; i++) picked.push(keys[Math.floor(i * step)]!)
  return picked
}

export const migrateArtifacts = (
  local: ArtifactStoreApi,
  bucket: ArtifactStoreApi,
  index: IndexClientApi,
  options: MigrationOptions = {}
): Effect.Effect<MigrationSummary, Error> =>
  Effect.gen(function*() {
    const dryRun = options.dryRun ?? false
    const sampleSize = options.sampleSize ?? DEFAULTS.sampleSize
    const threshold = options.putFileThresholdBytes ?? DEFAULTS.putFileThresholdBytes
    const hashMax = options.hashVerifyMaxBytes ?? DEFAULTS.hashVerifyMaxBytes
    const log = options.log ?? (() => {})
    const prefix = options.prefix ?? ""

    const keys = yield* local.list(prefix)
    const failures: Array<{ key: string; error: string }> = []
    const byPrefix = new Map<string, { count: number; bytes: number }>()
    let uploaded = 0
    let wouldUpload = 0
    let skipped = 0
    let bytesTotal = 0
    let bytesUploaded = 0

    let position = 0
    for (const key of keys) {
      position++
      if (position % 250 === 0) log(`… ${position}/${keys.length} keys`)
      const outcome = yield* Effect.exit(Effect.gen(function*() {
        const head = yield* local.head(key)
        if (Option.isNone(head) || head.value.size === null) {
          return yield* Effect.fail(new Error("source object vanished or has unknown size"))
        }
        const size = head.value.size
        const top = key.split("/")[0] ?? ""
        const bucket0 = byPrefix.get(top) ?? { count: 0, bytes: 0 }
        byPrefix.set(top, { count: bucket0.count + 1, bytes: bucket0.bytes + size })
        bytesTotal += size

        const existing = yield* bucket.head(key)
        if (Option.isSome(existing) && existing.value.size === size) {
          // Already there with the same size. Refresh the registration —
          // an earlier run may have died between upload and register.
          if (!dryRun) yield* index.register({ key, size })
          skipped++
          return
        }
        if (dryRun) {
          wouldUpload++
          return
        }
        if (size <= threshold) {
          const bytes = yield* local.getBytes(key)
          if (Option.isNone(bytes)) return yield* Effect.fail(new Error("source object vanished"))
          yield* bucket.putBytes(key, bytes.value)
        } else {
          yield* bucket.putFile(key, local.path(key))
        }
        uploaded++
        bytesUploaded += size
      }))
      if (outcome._tag === "Failure") {
        const error = Cause.squash(outcome.cause)
        failures.push({ key, error: String(error).slice(0, 300) })
        log(`FAILED ${key}: ${String(error).slice(0, 200)}`)
      }
    }

    // Verification: re-fetch a sample from the bucket and hash-compare
    // against the source, so the summary attests bytes, not intentions.
    const verification = { sampled: 0, hashMatched: 0, sizeVerified: 0, mismatches: [] as Array<string> }
    if (!dryRun) {
      for (const key of sampleOf(keys, sampleSize)) {
        verification.sampled++
        const localHead = yield* local.head(key)
        const size = Option.isSome(localHead) ? localHead.value.size : null
        if (size !== null && size <= hashMax) {
          const localBytes = yield* local.getBytes(key)
          const bucketBytes = yield* bucket.getBytes(key)
          const match = Option.isSome(localBytes) && Option.isSome(bucketBytes) &&
            sha256(localBytes.value) === sha256(bucketBytes.value)
          if (match) verification.hashMatched++
          else verification.mismatches.push(key)
        } else {
          const bucketHead = yield* bucket.head(key)
          if (size !== null && Option.isSome(bucketHead) && bucketHead.value.size === size) {
            verification.sizeVerified++
          } else {
            verification.mismatches.push(key)
          }
        }
      }
    }

    return {
      dryRun,
      scanned: keys.length,
      uploaded,
      wouldUpload,
      skipped,
      failures,
      bytesTotal,
      bytesUploaded,
      byPrefix: Object.fromEntries(byPrefix),
      verification
    }
  })
