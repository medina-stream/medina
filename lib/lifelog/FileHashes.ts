/**
 * Content hashes for corpus files (parquet partitions, notes), cached in
 * one manifest keyed by (path, size, freshness token) — the archive-receipt
 * pattern (`lib/capture/Archive.ts`) applied to hashing: a settled corpus
 * costs one head per file per pass, not a full read + SHA-256. The manifest
 * lives at `hashes/file-hashes-v1.json` in the data dir and is read once
 * per process; entries whose size or token no longer match are re-read
 * (through the artifact-store seam, so the bytes hashed are the artifact's
 * bytes wherever it lives) and re-hashed.
 *
 * The freshness token is the store's etag when the governing store reports
 * one (the bucket store does), else the file's mtime on the plain
 * filesystem. A path names an artifact or a local file depending on the
 * store in context; keying freshness on a local stat of a path that only
 * names a bucket artifact would happily match the frozen on-disk copy
 * forever — the split the GPS store seam fix (Nov 9, 2026) removed.
 */
import { tmpdir } from "node:os"
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
  /** Filesystem mtime token; 0 when the entry was keyed by etag. */
  mtimeMs: Schema.Number,
  /** Store etag token; null when the entry was keyed by mtime. */
  etag: Schema.NullOr(Schema.String),
  hash: Schema.String
}) {}

export class FileHashManifest extends Schema.Class<FileHashManifest>("FileHashManifest")({
  version: Schema.String,
  entries: Schema.Record(Schema.String, HashEntry)
}) {}

export const FILE_HASH_MANIFEST_VERSION = "file-hashes-v1"

/** Pure cache lookup: a hit requires path and size to match, plus the
 * freshness token both sides share — etag when both carry one, else
 * mtime. A token-kind change (a store flip) therefore misses and
 * re-hashes rather than trusting the other kind's token. */
export const manifestHash = (
  manifest: FileHashManifest,
  path: string,
  size: number,
  mtimeMs: number,
  etag: string | null
): string | null => {
  const entry = manifest.entries[path]
  if (entry === undefined || entry.size !== size) return null
  if (etag !== null && entry.etag !== null) return entry.etag === etag ? entry.hash : null
  return entry.mtimeMs === mtimeMs ? entry.hash : null
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

/** The freshness facts for a path, from whichever store governs it:
 * `Files.head` routes to the artifact store when one is in context (the
 * bucket store reports an etag), and to a filesystem stat otherwise
 * (etag null; the mtime then comes from a direct stat). A path no store
 * knows fails, exactly as a stat of a missing file always did. */
const statKey = (path: string) =>
  Effect.gen(function*() {
    const head = yield* Files.head(path)
    if (Option.isNone(head) || head.value.size === null) {
      return yield* Effect.fail(new Error(`file hash: no such file: ${path}`))
    }
    if (head.value.etag !== null) {
      return { size: head.value.size, mtimeMs: 0, etag: head.value.etag }
    }
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(path)
    return {
      size: Number(info.size),
      mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (date: Date) => date.getTime() }),
      etag: null as string | null
    }
  })

/** A compact freshness token for a path (`size:etag-or-mtime`), for
 * callers that fingerprint files into their own basis hashes. */
export const fileStatToken = (path: string): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.map(statKey(path), ({ size, mtimeMs, etag }) => `${size}:${etag ?? mtimeMs}`)

/**
 * The SHA-256 of a file's bytes, from the manifest when (size, token) say
 * the bytes have not changed. Only a miss reads the file — through the
 * store seam (`Files.getFile` to a scratch path), so the bytes hashed
 * are the artifact's, wherever the artifact lives.
 */
export const cachedFileHash = (path: string): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const manifest = yield* loadManifest
    const { size, mtimeMs, etag } = yield* statKey(path)
    const hit = manifestHash(manifest, path, size, mtimeMs, etag)
    if (hit !== null) return hit
    const fs = yield* FileSystem.FileSystem
    const scratch = `${tmpdir()}/medina-filehash-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const got = yield* Files.getFile(path, scratch)
    if (!got) return yield* Effect.fail(new Error(`file hash: no such file: ${path}`))
    const hash = sha256(yield* fs.readFile(scratch))
    yield* fs.remove(scratch, { force: true }).pipe(Effect.ignore)
    loaded = new FileHashManifest({
      version: FILE_HASH_MANIFEST_VERSION,
      entries: { ...manifest.entries, [path]: new HashEntry({ size, mtimeMs, etag, hash }) }
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
