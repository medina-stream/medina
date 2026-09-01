/**
 * The Medina model: sources ingest captures into the bucket; resources are
 * software-defined data that should exist in the bucket. A resource instance's
 * key bakes in a hash of its dependencies, so key existence is the freshness
 * check: missing key ⇒ stale ⇒ materialize.
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
  /** Materialization target in the bucket. */
  readonly key: string
  /** Human handle for the instance (the day, for a journal). */
  readonly label: string
  /** Bucket keys this instance is derived from; their hash is baked into `key`. */
  readonly dependencies: ReadonlyArray<string>
  readonly materialize: Effect.Effect<void, Error, R>
}

export interface Resource<R> {
  readonly name: string
  readonly instances: Effect.Effect<ReadonlyArray<ResourceInstance<R>>, Error, R>
}
