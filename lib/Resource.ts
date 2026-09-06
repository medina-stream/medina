/**
 * The Medina model: sources ingest captures into the data dir; resources are
 * software-defined data that should exist there. A resource instance's key
 * (its path relative to the data dir) bakes in a hash of its dependencies, so
 * file existence is the freshness check: missing file ⇒ stale ⇒ materialize.
 *
 * Resources are eager, lazy, or both. `instances` enumerates what should
 * exist ahead of demand (the pipeline materializes these each pass);
 * `instance` dereferences one label on demand, so an API user can ask for an
 * instance nobody pre-generated — the journal for 2525-01-01 is a valid,
 * instantly-computable (empty) resource, not a 404.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Files from "./Files.ts"

export interface SourceReport {
  readonly discovered: number
  readonly ingested: number
  readonly cached: number
  readonly skipped: number
  readonly failures: ReadonlyArray<{ readonly item: string; readonly error: string }>
}

export interface Source<R> {
  readonly name: string
  readonly ingest: Effect.Effect<SourceReport, Error, R>
}

export interface ResourceInstance<R> {
  /** Materialization target: a path relative to the data dir. */
  readonly key: string
  /** Human handle for the instance (the day, for a journal). */
  readonly label: string
  /** Keys this instance is derived from; their hash is baked into `key`. */
  readonly dependencies: ReadonlyArray<string>
  readonly materialize: Effect.Effect<void, Error, R>
}

export interface Resource<R> {
  readonly name: string
  /** Eager: instances that should exist ahead of demand. */
  readonly instances: Effect.Effect<ReadonlyArray<ResourceInstance<R>>, Error, R>
  /** Lazy: dereference one instance by label, on demand. */
  readonly instance?: (label: string) => Effect.Effect<ResourceInstance<R>, Error, R>
}

/** Read an already-materialized instance without doing derivative work. */
export const readCachedInstance = <S extends Schema.Codec<any, any>, R>(
  schema: S,
  instance: ResourceInstance<R>,
  path: (key: string) => string
) => Files.readJson(schema, path(instance.key))

/** Read an instance, materializing exactly the selected basis on a miss. */
export const readInstance = <S extends Schema.Codec<any, any>, R>(
  schema: S,
  instance: ResourceInstance<R>,
  path: (key: string) => string
): Effect.Effect<S["Type"], Error, R | FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const existing = yield* Files.readJson(schema, path(instance.key))
    if (Option.isSome(existing)) return existing.value
    yield* instance.materialize
    const written = yield* Files.readJson(schema, path(instance.key))
    if (Option.isNone(written)) {
      return yield* Effect.fail(new Error(`resource materializer did not write ${instance.key}`))
    }
    return written.value
  })
