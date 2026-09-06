/** Reusable source construction for independently ingestible discovered items. */
import * as Effect from "effect/Effect"
import type { Source, SourceReport } from "./Resource.ts"

export type ItemOutcome = "ingested" | "cached" | "skipped"

export interface ItemSourceOptions<Item, R> {
  readonly name: string
  readonly discover: Effect.Effect<ReadonlyArray<Item>, Error, R>
  readonly ingest: (item: Item) => Effect.Effect<ItemOutcome, Error, R>
  readonly label: (item: Item) => string
  readonly concurrency?: number
}

/** Build a source with bounded concurrency and per-item failure isolation. */
export const makeItemSource = <Item, R>(options: ItemSourceOptions<Item, R>): Source<R> => ({
  name: options.name,
  ingest: Effect.gen(function*() {
    const items = yield* options.discover
    const failures: Array<{ item: string; error: string }> = []
    const outcomes = yield* Effect.forEach(items, (item) =>
      options.ingest(item).pipe(
        Effect.catchCause((cause) => {
          const label = options.label(item)
          return Effect.logError(`ingest failed for ${label}`, cause).pipe(
            Effect.tap(() => Effect.sync(() => failures.push({ item: label, error: String(cause).slice(0, 500) }))),
            Effect.as("failed" as const)
          )
        })
      ), { concurrency: options.concurrency ?? 1 })
    const count = (outcome: ItemOutcome) => outcomes.filter((entry) => entry === outcome).length
    return {
      discovered: items.length,
      ingested: count("ingested"),
      cached: count("cached"),
      skipped: count("skipped"),
      failures
    } satisfies SourceReport
  })
})
