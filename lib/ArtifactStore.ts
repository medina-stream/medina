/** Filesystem-backed artifact addressing.
 *
 * Medina modules exchange relative artifact keys. This module is the one
 * boundary that turns those keys into host paths and rejects path traversal.
 * The Effect service is useful to embedders; `artifactPath` keeps the current
 * file-format modules source-compatible while they migrate to the service.
 */
import { isAbsolute, join, normalize } from "node:path"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Files from "./Files.ts"

export type ArtifactKey = string & { readonly ArtifactKey: unique symbol }

export const key = (value: string): ArtifactKey => {
  const normalized = normalize(value).replace(/^\.\//, "")
  if (!value || isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`invalid artifact key: ${value}`)
  }
  return normalized as ArtifactKey
}

export const artifactPath = (root: string, value: string): string => join(root, key(value))

export class ArtifactStore extends Context.Service<ArtifactStore, {
  readonly root: string
  readonly path: (value: string) => string
  readonly exists: (value: string) => Effect.Effect<boolean, Error>
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<string>, Error>
  readonly readJson: <S extends Schema.Codec<any, any>>(
    schema: S,
    value: string
  ) => ReturnType<typeof Files.readJson<S>>
  readonly writeJson: (value: string, body: unknown) => Effect.Effect<void, Error>
}>()("medina/ArtifactStore") {}

export const layer = (root: string): Layer.Layer<ArtifactStore, never, FileSystem.FileSystem> =>
  Layer.effect(ArtifactStore)(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = (value: string) => artifactPath(root, value)
    return {
      root,
      path,
      exists: (value) => fs.exists(path(value)).pipe(
        Effect.mapError((cause) => new Error(String(cause)))
      ),
      list: (prefix) => Files.listFiles(path(prefix)).pipe(
        Effect.provideService(FileSystem.FileSystem, fs)
      ),
      readJson: (schema, value) => Files.readJson(schema, path(value)).pipe(
        Effect.provideService(FileSystem.FileSystem, fs)
      ),
      writeJson: (value, body) => Files.writeJson(path(value), body).pipe(
        Effect.provideService(FileSystem.FileSystem, fs)
      )
    }
  }))

export const layerFromConfig = Layer.unwrap(
  Effect.map(Config.string("DATA_DIR").pipe(Config.withDefault("data/artifacts")), layer)
)
