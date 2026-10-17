/**
 * Small filesystem helpers used by pipeline code: schema-decoded JSON reads,
 * atomic JSON writes (tmp + rename, so readers — and network-mount
 * propagation — never see partial files), and a recursive file listing that
 * avoids per-entry stats.
 *
 * These helpers are also the artifact-store seam. When an `ArtifactStore`
 * service is in context (the app provides one, selected by the
 * ARTIFACT_STORE config) and the path names an artifact under the store's
 * root, the operation routes through the store — a local directory today,
 * the bucket+index pair in production — with no call-site changes. With no
 * store in context (unit tests, one-shot tools), behavior is exactly the
 * plain filesystem behavior it has always been.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { dirname } from "node:path"
import { ArtifactStore, type ArtifactStoreApi } from "./ArtifactStore.ts"

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))

/** Route through the in-context ArtifactStore when `file` is one of its
 * artifacts; otherwise run the filesystem fallback. */
const withStore = <A, E, R>(
  file: string,
  use: (store: ArtifactStoreApi, key: string) => Effect.Effect<A, E, R>,
  fallback: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(ArtifactStore), (option) => {
    if (Option.isSome(option)) {
      const key = option.value.keyForPath(file)
      if (key !== null) return use(option.value, key)
    }
    return fallback
  })

export const readJson = <S extends Schema.Codec<any, any>>(
  schema: S,
  file: string
): Effect.Effect<Option.Option<S["Type"]>, Error, FileSystem.FileSystem> =>
  withStore(
    file,
    (store, key) => store.readJson(schema, key),
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      if (!(yield* fs.exists(file))) return Option.none()
      const text = yield* fs.readFileString(file)
      return Option.some(yield* Schema.decodeUnknownEffect(schema)(JSON.parse(text)))
    }).pipe(Effect.mapError(asError))
  )

export const writeJson = (
  file: string,
  value: unknown
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  withStore(
    file,
    (store, key) => store.writeJson(key, value),
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
      yield* fs.makeDirectory(dirname(file), { recursive: true })
      yield* fs.writeFileString(tmp, JSON.stringify(value, null, 2))
      yield* fs.rename(tmp, file)
    }).pipe(Effect.mapError(asError))
  )

/** The file's text, or none when it does not exist. */
export const readText = (
  file: string
): Effect.Effect<Option.Option<string>, Error, FileSystem.FileSystem> =>
  withStore(
    file,
    (store, key) => store.getText(key),
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      if (!(yield* fs.exists(file))) return Option.none()
      return Option.some(yield* fs.readFileString(file))
    }).pipe(Effect.mapError(asError))
  )

export const exists = (
  file: string
): Effect.Effect<boolean, Error, FileSystem.FileSystem> =>
  withStore(
    file,
    (store, key) => store.exists(key),
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* fs.exists(file)
    }).pipe(Effect.mapError(asError))
  )

/** Delete the file; deleting an absent file succeeds (object-store
 * semantics, and the freshness model only ever asks "is it gone"). */
export const remove = (
  file: string
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  withStore(
    file,
    (store, key) => store.delete(key),
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(file, { force: true })
    }).pipe(Effect.mapError(asError))
  )

/** Every file under `dir` (recursively), as paths relative to `dir`.
 * Directories are inferred from the listing instead of stat-ed, and
 * in-flight `.tmp-*` writes are excluded. */
export const listFiles = (
  dir: string
): Effect.Effect<ReadonlyArray<string>, Error, FileSystem.FileSystem> =>
  withStore(
    dir,
    (store, key) =>
      Effect.map(store.list(key), (keys) =>
        keys
          .flatMap((listed) =>
            listed === key
              ? []
              : key === ""
                ? [listed]
                : listed.startsWith(`${key}/`)
                  ? [listed.slice(key.length + 1)]
                  : []
          )
          .filter((entry) => !/\.tmp-[^/]*$/.test(entry))
          .sort()
      ),
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
  )
