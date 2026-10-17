import { describe, expect, test } from "bun:test"
import { utimes } from "node:fs/promises"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { BunFileSystem } from "@effect/platform-bun"
import { cachedFileHash, flushFileHashes, manifestHash, resetFileHashCacheForTest, FileHashManifest, HashEntry } from "./FileHashes.ts"
import { dataPath } from "./Resources.ts"
import { sha256 } from "../Hash.ts"

const live = BunFileSystem.layer
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(live)) as Effect.Effect<A, E, never>)

describe("manifestHash", () => {
  test("hits only when path, size, and mtime all match", () => {
    const manifest = new FileHashManifest({
      version: "file-hashes-v1",
      entries: { "/x": new HashEntry({ size: 3, mtimeMs: 42, hash: "abc" }) }
    })
    expect(manifestHash(manifest, "/x", 3, 42)).toBe("abc")
    expect(manifestHash(manifest, "/x", 4, 42)).toBeNull()
    expect(manifestHash(manifest, "/x", 3, 43)).toBeNull()
    expect(manifestHash(manifest, "/y", 3, 42)).toBeNull()
  })
})

describe("cachedFileHash", () => {
  test("serves an unchanged (size, mtime) file from the manifest without re-reading", async () => {
    resetFileHashCacheForTest()
    const path = dataPath("hashes-test/sample.bin")
    await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(dataPath("hashes-test"), { recursive: true })
      yield* fs.writeFile(path, new TextEncoder().encode("aaaa"))
    }))
    const first = await run(cachedFileHash(path))
    expect(first).toBe(sha256("aaaa"))
    await run(flushFileHashes)

    // Same size, same mtime, different bytes: the manifest key says the
    // file is unchanged, so the cached hash must be served (no re-read).
    const stat = await Bun.file(path).stat()
    await Bun.write(path, "bbbb")
    await utimes(path, stat.atime, stat.mtime)
    resetFileHashCacheForTest()
    expect(await run(cachedFileHash(path))).toBe(first)

    // A new mtime busts the cache and the new bytes are hashed.
    await utimes(path, stat.atime, new Date(stat.mtime.getTime() + 60_000))
    expect(await run(cachedFileHash(path))).toBe(sha256("bbbb"))
  })
})
