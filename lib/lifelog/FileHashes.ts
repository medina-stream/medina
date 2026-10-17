/**
 * Content hashes for corpus files (parquet partitions, notes), cached in
 * one manifest keyed by (path, size, mtime) — the archive-receipt pattern
 * (`lib/capture/Archive.ts`) applied to hashing: a settled corpus costs one
 * stat per file per pass, not a full read + SHA-256. The manifest lives at
 * `hashes/file-hashes-v1.json` in the data dir and is read once per process;
 * entries whose size or mtime no longer match are re-read and re-hashed.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Files from "../Files.ts"
import { sha256 } from "../Hash.ts"
import { dataPath } from "./Resources.ts"

export const FILE_HASH_MANIFEST_KEY = "hashes/file-hashes-v1.json"

export class HashEntry extends Schema.Class<HashEntry>("HashEntry")({
  size: Schema.Number,
  mtimeMs: Schema.Number,
  hash: Schema.String
}) {}

export class FileHashManifest extends Schema.Class<FileHashManifest>("FileHashManifest")({
  version: Schema.String,
  entries: Schema.Record(Schema.String, HashEntry)
}) {}

export const FILE_HASH_MANIFEST_VERSION = "file-hashes-v1"

/** Pure cache lookup: a hit requires path, size, and mtime to all match. */
export const manifestHash = (
  manifest: FileHashManifest,
  path: string,
  size: number,
  mtimeMs: number
): string | null => {
  const entry = manifest.entries[path]
  return entry !== undefined && entry.size === size && entry.mtimeMs === mtimeMs ? entry.hash : null
}

let loaded: FileHashManifest | null = null
let dirty = false

const loadManifest = Effect.gen(function*() {
  if (loaded !== null) return loaded
  const existing = yield* Files.readJson(FileHashManifest, dataPath(FILE_HASH_MANIFEST_KEY)).pipe(
    Effect.orElseSucceed(() => Option.none<FileHashManifest>())
  )
  loaded = Option.isSome(existing)
    ? existing.value
    : new FileHashManifest({ version: FILE_HASH_MANIFEST_VERSION, entries: {} })
  return loaded
})

/** Persist accumulated hash entries, if any were computed since last flush. */
export const flushFileHashes = Effect.gen(function*() {
  if (!dirty || loaded === null) return
  const manifest = loaded
  dirty = false
  yield* Files.writeJson(dataPath(FILE_HASH_MANIFEST_KEY), manifest).pipe(Effect.ignore)
})

const statKey = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(path)
    return {
      size: Number(info.size),
      mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (date: Date) => date.getTime() })
    }
  })

/**
 * The SHA-256 of a file's bytes, from the manifest when (size, mtime) say
 * the bytes have not changed. Only a miss reads the file.
 */
export const cachedFileHash = (path: string): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const manifest = yield* loadManifest
    const { size, mtimeMs } = yield* statKey(path)
    const hit = manifestHash(manifest, path, size, mtimeMs)
    if (hit !== null) return hit
    const fs = yield* FileSystem.FileSystem
    const hash = sha256(yield* fs.readFile(path))
    loaded = new FileHashManifest({
      version: FILE_HASH_MANIFEST_VERSION,
      entries: { ...manifest.entries, [path]: new HashEntry({ size, mtimeMs, hash }) }
    })
    dirty = true
    return hash
  }).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))))

/** Batch form: concurrent lookups, one manifest flush for the whole pass. */
export const cachedFileHashes = (
  paths: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<string>, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const hashes = yield* Effect.forEach(paths, (path) => cachedFileHash(path), { concurrency: 8 })
    yield* flushFileHashes
    return hashes
  })

/** Test/reset hook: forget the in-process manifest (the file stays). */
export const resetFileHashCacheForTest = () => {
  loaded = null
  dirty = false
}
