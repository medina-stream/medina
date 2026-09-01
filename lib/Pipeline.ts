/**
 * The pipeline: run every source's ingest, then materialize every stale
 * resource instance. The filesystem is the only state; a resource instance's
 * file exists ⇔ it is current, so a pass is idempotent and does no LLM or
 * vendor work for anything already materialized.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as FileSystem from "effect/FileSystem"
import * as Files from "./Files.ts"
import type { Resource, Source, SourceReport } from "./Resource.ts"

export class RunReport extends Schema.Class<RunReport>("RunReport")({
  startedAt: Schema.String,
  finishedAt: Schema.String,
  sources: Schema.Array(Schema.Struct({
    name: Schema.String,
    discovered: Schema.Number,
    ingested: Schema.Number,
    cached: Schema.Number,
    skipped: Schema.Number
  })),
  materialized: Schema.Array(Schema.Struct({ resource: Schema.String, label: Schema.String })),
  failures: Schema.Array(Schema.Struct({ stage: Schema.String, item: Schema.String, error: Schema.String }))
}) {}

export const RUN_REPORT_KEY = "runs/latest.json"

export const runPipeline = <R>(
  sources: ReadonlyArray<Source<R>>,
  resources: ReadonlyArray<Resource<R>>,
  dataPath: (key: string) => string
) =>
  Effect.gen(function*() {
    const startedAt = new Date().toISOString()
    const failures: Array<{ stage: string; item: string; error: string }> = []
    const fail = (stage: string, item: string) => (cause: unknown) => {
      failures.push({ stage, item, error: String(cause).slice(0, 500) })
      return Effect.logError(`${stage} failed for ${item}`, cause)
    }

    const sourceReports: Array<{ name: string } & Omit<SourceReport, "failures">> = []
    for (const source of sources) {
      const report = yield* source.ingest.pipe(
        Effect.catchCause((cause) =>
          fail("ingest", source.name)(cause).pipe(
            Effect.as({ discovered: 0, ingested: 0, cached: 0, skipped: 0, failures: [] })
          )
        )
      )
      failures.push(...report.failures.map((failure) => ({ stage: `ingest:${source.name}`, ...failure })))
      const { failures: _, ...counts } = report
      sourceReports.push({ name: source.name, ...counts })
    }

    const fs = yield* FileSystem.FileSystem
    const materialized: Array<{ resource: string; label: string }> = []
    for (const resource of resources) {
      const instances = yield* resource.instances.pipe(
        Effect.catchCause((cause) => fail("instances", resource.name)(cause).pipe(Effect.as([])))
      )
      for (const instance of instances) {
        if (yield* fs.exists(dataPath(instance.key))) continue
        yield* Effect.log(`materializing ${resource.name}/${instance.label}`)
        yield* instance.materialize.pipe(
          Effect.tap(() => Effect.sync(() => materialized.push({ resource: resource.name, label: instance.label }))),
          Effect.catchCause(fail(resource.name, instance.label))
        )
      }
    }

    yield* Files.writeJson(
      dataPath(RUN_REPORT_KEY),
      new RunReport({
        startedAt,
        finishedAt: new Date().toISOString(),
        sources: sourceReports,
        materialized,
        failures
      })
    )
  })
