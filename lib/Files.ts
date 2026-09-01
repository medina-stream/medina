/**
 * Small filesystem helpers used by pipeline code: schema-decoded JSON reads,
 * atomic JSON writes (tmp + rename, so readers — and network-mount
 * propagation — never see partial files), and a recursive file listing that
 * avoids per-entry stats.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { dirname } from "node:path"

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))

export const readJson = <S extends Schema.Codec<any, any>>(
  schema: S,
  file: string
): Effect.Effect<Option.Option<S["Type"]>, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(file))) return Option.none()
    const text = yield* fs.readFileString(file)
    return Option.some(yield* Schema.decodeUnknownEffect(schema)(JSON.parse(text)))
  }).pipe(Effect.mapError(asError))

export const writeJson = (
  file: string,
  value: unknown
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    yield* fs.makeDirectory(dirname(file), { recursive: true })
    yield* fs.writeFileString(tmp, JSON.stringify(value, null, 2))
    yield* fs.rename(tmp, file)
  }).pipe(Effect.mapError(asError))

/** Every file under `dir` (recursively), as paths relative to `dir`.
 * Directories are inferred from the listing instead of stat-ed, and
 * in-flight `.tmp-*` writes are excluded. */
export const listFiles = (
  dir: string
): Effect.Effect<ReadonlyArray<string>, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(dir))) return []
    const entries = yield* fs.readDirectory(dir, { recursive: true })
    const directories = new Set<string>()
    for (const entry of entries) {
      const parent = dirname(entry)
      if (parent !== ".") directories.add(parent)
    }
    return entries
      .filter((entry) => !directories.has(entry) && !/\.tmp-[^/]*$/.test(entry))
      .sort()
  }).pipe(Effect.mapError(asError))
