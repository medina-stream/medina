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
  const failures: Array<string> = []
  for (const { key, path } of files) {
    const localBytes = yield* Effect.tryPromise(() => readFile(path)).pipe(
      Effect.catchCause((cause) => Effect.sync(() => {
        failures.push(`${key}: local read failed: ${String(cause).slice(0, 300)}`)
        return null
      }))
    )
    if (localBytes === null) continue
    const stored = yield* Effect.flatMap(bucket.putFile(key, path), () => bucket.getBytes(key)).pipe(
      Effect.catchCause((cause) => Effect.sync(() => {
        failures.push(`${key}: ${String(cause).slice(0, 300)}`)
        return Option.none<Uint8Array>()
      }))
    )
    if (Option.isNone(stored)) {
      if (!failures.some((failure) => failure.startsWith(key))) failures.push(`${key}: missing after upload`)
      continue
    }
    if (sha256(stored.value) !== sha256(localBytes)) {
      failures.push(`${key}: hash mismatch after upload`)
      continue
    }
    uploaded++
  }
  console.log(JSON.stringify({ files: files.length, uploaded, failures }, null, 2))
  if (failures.length > 0) process.exitCode = 1
})

Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer))).catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
