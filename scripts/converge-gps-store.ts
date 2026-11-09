/**
 * One-shot converge of the GPS points store into the bucket store.
 *
 * Until the Nov 9, 2026 seam fix, the GPS subtree (inbox, points
 * partitions, stays partitions + basis) lived only on medina-dev's
 * local disk — raw filesystem calls that never consulted the artifact
 * store — while the bucket held a frozen copy from the milestone-3
 * bulk copy (Oct 28). Before the seam-fixed stages may run (they read
 * and write the store), the live disk state must replace the frozen
 * bucket state, or the first bucket-side compaction would merge
 * against week-old partitions and strand the points compacted since.
 *
 * Unlike scripts/migrate-artifacts-to-bucket.ts this does NOT skip on
 * size match: the bucket copies are known-stale, so every file is
 * uploaded unconditionally and then hash-verified by reading it back
 * through the bucket store. The GPS tree is ~8 MB, so full
 * verification costs nothing.
 *
 * Run it ON medina-dev, with the service stopped (so no compaction
 * pass can interleave), with the service environment:
 *
 *   bun scripts/converge-gps-store.ts
 *
 * Idempotent: re-running uploads the same bytes again and verifies.
 * Exits non-zero on any failure or hash mismatch.
 */
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { bucketFromConfig } from "../lib/ArtifactStore.ts"

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** The GPS store files on local disk, as artifact keys. Inbox temp
 * files (`.ndjson.tmp-*`, interrupted writes) are not artifacts and
 * are never copied. */
const localKeys = async (dataDir: string): Promise<Array<{ key: string; path: string }>> => {
  const out: Array<{ key: string; path: string }> = []
  const walk = async (keyDir: string, keep: (name: string) => boolean) => {
    const entries = await readdir(join(dataDir, keyDir), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const key = `${keyDir}/${entry.name}`
      if (entry.isDirectory()) await walk(key, keep)
      else if (entry.isFile() && keep(entry.name)) out.push({ key, path: join(dataDir, key) })
    }
  }
  await walk("gps/points-v1", (name) => name === "points.parquet")
  await walk("gps/stays-v1", (name) => name === "stays.parquet" || name === "basis.json")
  await walk("gps/inbox", (name) => name.endsWith(".ndjson"))
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

const program = Effect.gen(function*() {
  const dataDir = process.env.DATA_DIR ?? "data/artifacts"
  const { store: bucket } = yield* bucketFromConfig
  const files = yield* Effect.promise(() => localKeys(dataDir))
  console.log(`converging ${files.length} GPS store files from ${dataDir}`)
  let uploaded = 0
  let done = 0
  const failures: Array<string> = []
  const convergeOne = ({ key, path }: { key: string; path: string }) =>
    Effect.gen(function*() {
      const localBytes = yield* Effect.tryPromise(() => readFile(path))
      yield* bucket.putFile(key, path)
      const stored = yield* bucket.getBytes(key)
      if (Option.isNone(stored) || sha256(stored.value) !== sha256(localBytes)) {
        return yield* Effect.fail(new Error(`${key}: hash mismatch after upload`))
      }
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          uploaded++
          if (++done % 500 === 0) console.log(`  ${done}/${files.length}`)
        })
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          failures.push(String(cause).slice(0, 300))
          if (++done % 500 === 0) console.log(`  ${done}/${files.length}`)
        })
      )
    )
  // The store round trips (object PUT, index registration, read-back)
  // run ~1.5 s per file from medina-dev; sequential, the 8k-file inbox
  // would take hours, so converge with bounded concurrency. Uploads of
  // identical bytes commute, and verification is per file.
  yield* Effect.forEach(files, convergeOne, { concurrency: 16, discard: true })
  console.log(JSON.stringify({ files: files.length, uploaded, failures: failures.slice(0, 20), failureCount: failures.length }, null, 2))
  if (failures.length > 0) process.exitCode = 1
})

Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer))).catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
