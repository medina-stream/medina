/**
 * Bucket: a keyed JSON/blob store on a directory. The directory *is* the
 * bucket — self-hosted Medina points it at a local disk, serverless Medina
 * at a mounted filesystem (e.g. an Archil disk). Writes are atomic
 * (tmp + rename) and reads avoid per-key stats, so the same code behaves on
 * both local disks and network-backed mounts.
 *
 * Keys keep the shape of the previous implementation (`transcript/...`,
 * `journal/...`), so objects exported from it are readable without
 * migration.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

export class Bucket extends Context.Service<Bucket, {
  readonly readJson: <S extends Schema.Codec<any, any>>(
    schema: S,
    key: string
  ) => Effect.Effect<Option.Option<S["Type"]>, Error>
  readonly writeJson: (key: string, value: unknown) => Effect.Effect<void, Error>
  readonly exists: (key: string) => Effect.Effect<boolean, Error>
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<string>, Error>
}>()("medina/Bucket") {}

export const layer = (
  root: string
): Layer.Layer<Bucket, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Bucket)(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const resolve = (key: string) => path.join(root, key)
      const mapError = (cause: unknown) => new Error(`bucket failure`, { cause })

      return {
        readJson: (schema, key) =>
          Effect.gen(function*() {
            const file = resolve(key)
            if (!(yield* fs.exists(file))) return Option.none()
            const text = yield* fs.readFileString(file)
            return Option.some(yield* Schema.decodeUnknownEffect(schema)(JSON.parse(text)))
          }).pipe(Effect.mapError(mapError)),

        // Atomic: readers (and mount propagation) never see partial JSON.
        writeJson: (key, value) =>
          Effect.gen(function*() {
            const file = resolve(key)
            const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
            yield* fs.makeDirectory(path.dirname(file), { recursive: true })
            yield* fs.writeFileString(tmp, JSON.stringify(value, null, 2))
            yield* fs.rename(tmp, file)
          }).pipe(Effect.mapError(mapError)),

        exists: (key) => fs.exists(resolve(key)).pipe(Effect.mapError(mapError)),

        // One recursive listing, no per-key stat: cheap on network mounts.
        // Directories are inferred (every parent of an entry is one) — the
        // bucket never holds empty directories. In-flight tmp files are not
        // keys.
        list: (prefix) =>
          Effect.gen(function*() {
            const dir = resolve(prefix)
            if (!(yield* fs.exists(dir))) return []
            const entries = yield* fs.readDirectory(dir, { recursive: true })
            const directories = new Set<string>()
            for (const entry of entries) {
              const parent = path.dirname(entry)
              if (parent !== ".") directories.add(parent)
            }
            return entries
              .filter((entry) => !directories.has(entry) && !/\.tmp-[^/]*$/.test(entry))
              .map((entry) => path.join(prefix, entry))
              .sort()
          }).pipe(Effect.mapError(mapError))
      }
    })
  )
