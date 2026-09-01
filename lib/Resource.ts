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
import type * as Effect from "effect/Effect"

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
