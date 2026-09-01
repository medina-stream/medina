/**
 * Artifact store: a content-addressed-by-key JSON/blob store on the local
 * filesystem, playing the role R2 played in the Cloudflare implementation.
 * Keys keep the same shape (`transcript/...`, `journal/...`), so artifacts
 * exported from the old bucket are readable without migration.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

export class Artifacts extends Context.Service<Artifacts, {
  readonly readJson: <S extends Schema.Codec<any, any>>(
    schema: S,
    key: string
  ) => Effect.Effect<Option.Option<S["Type"]>, Error>
  readonly writeJson: (key: string, value: unknown) => Effect.Effect<void, Error>
  readonly exists: (key: string) => Effect.Effect<boolean, Error>
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<string>, Error>
}>()("medina/Artifacts") {}

export const layer = (
  root: string
): Layer.Layer<Artifacts, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Artifacts)(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const resolve = (key: string) => path.join(root, key)
      const mapError = (cause: unknown) => new Error(`artifact store failure`, { cause })

      return {
        readJson: (schema, key) =>
          Effect.gen(function*() {
            const file = resolve(key)
            if (!(yield* fs.exists(file))) return Option.none()
            const text = yield* fs.readFileString(file)
            return Option.some(yield* Schema.decodeUnknownEffect(schema)(JSON.parse(text)))
          }).pipe(Effect.mapError(mapError)),

        writeJson: (key, value) =>
          Effect.gen(function*() {
            const file = resolve(key)
            yield* fs.makeDirectory(path.dirname(file), { recursive: true })
            yield* fs.writeFileString(file, JSON.stringify(value, null, 2))
          }).pipe(Effect.mapError(mapError)),

        exists: (key) => fs.exists(resolve(key)).pipe(Effect.mapError(mapError)),

        list: (prefix) =>
          Effect.gen(function*() {
            const dir = resolve(prefix)
            if (!(yield* fs.exists(dir))) return []
            const entries = yield* fs.readDirectory(dir, { recursive: true })
            const keys: Array<string> = []
            for (const entry of entries) {
              const stat = yield* fs.stat(path.join(dir, entry))
              if (stat.type === "File") keys.push(path.join(prefix, entry))
            }
            return keys.sort()
          }).pipe(Effect.mapError(mapError))
      }
    })
  )
