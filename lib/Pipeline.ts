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
import { publishEvent } from "./RuntimeEvents.ts"
import type { Resource, Source, SourceReport } from "./Resource.ts"

export class RunReport extends Schema.Class<RunReport>("RunReport")({
  startedAt: Schema.String,
  finishedAt: Schema.String,
  sources: Schema.Array(Schema.Struct({
    name: Schema.String,
    status: Schema.Literals(["disabled", "healthy", "empty", "degraded", "failing"]),
    message: Schema.NullOr(Schema.String),
    discovered: Schema.Number,
    ingested: Schema.Number,
    cached: Schema.Number,
    skipped: Schema.Number
  })),
  stages: Schema.Array(Schema.Struct({
    name: Schema.String,
    status: Schema.Literals(["healthy", "empty", "degraded", "failing"]),
    message: Schema.NullOr(Schema.String),
    discovered: Schema.Number,
    ingested: Schema.Number,
    cached: Schema.Number,
    skipped: Schema.Number
  })),
  resources: Schema.Array(Schema.Struct({
    name: Schema.String,
    discovered: Schema.Number,
    materialized: Schema.Number,
    failed: Schema.Number
  })),
  materialized: Schema.Array(Schema.Struct({ resource: Schema.String, label: Schema.String })),
  failures: Schema.Array(Schema.Struct({ stage: Schema.String, item: Schema.String, error: Schema.String }))
}) {}

export interface PipelineSource<R> {
  readonly name: string
  readonly source: Source<R> | undefined
  readonly disabledReason?: string
}

export const RUN_REPORT_KEY = "runs/latest.json"

/** Process-local state complements the durable last-run report. */
export const pipelineRuntime: {
  readonly processStartedAt: string
  running: boolean
  currentStartedAt: string | null
  lastFinishedAt: string | null
  nextRunAt: string | null
} = {
  processStartedAt: new Date().toISOString(),
  running: false,
  currentStartedAt: null,
  lastFinishedAt: null,
  nextRunAt: null
}

export const runPipeline = <R>(
  sources: ReadonlyArray<PipelineSource<R>>,
  stages: ReadonlyArray<Source<R>>,
  resources: ReadonlyArray<Resource<R>>,
  dataPath: (key: string) => string
) =>
  Effect.gen(function*() {
    const startedAt = new Date().toISOString()
    pipelineRuntime.running = true
    pipelineRuntime.currentStartedAt = startedAt
    yield* publishEvent({ type: "pipeline", status: "running", message: "Pipeline pass started" })
    const failures: Array<{ stage: string; item: string; error: string }> = []
    const fail = (stage: string, item: string) => (cause: unknown) => {
      failures.push({ stage, item, error: String(cause).slice(0, 500) })
      return Effect.logError(`${stage} failed for ${item}`, cause)
    }

    const sourceReports: Array<{
      name: string
      status: "disabled" | "healthy" | "empty" | "degraded" | "failing"
      message: string | null
    } & Omit<SourceReport, "failures">> = []
    for (const configured of sources) {
      if (configured.source === undefined) {
        sourceReports.push({
          name: configured.name,
          status: "disabled",
          message: configured.disabledReason ?? "not configured",
          discovered: 0,
          ingested: 0,
          cached: 0,
          skipped: 0
        })
        yield* publishEvent({
          type: "source",
          name: configured.name,
          status: "disabled",
          message: `${configured.name} disabled: ${configured.disabledReason ?? "not configured"}`
        })
        continue
      }
      const source = configured.source
      yield* publishEvent({ type: "source", name: source.name, status: "running", message: `Reading ${source.name}` })
      let sourceFailed = false
      let sourceFailureMessage: string | null = null
      const report = yield* source.ingest.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            sourceFailed = true
            sourceFailureMessage = String(cause).slice(0, 500)
          }).pipe(
            Effect.andThen(fail("ingest", source.name)(cause)),
            Effect.as({ discovered: 0, ingested: 0, cached: 0, skipped: 0, failures: [] })
          )
        )
      )
      failures.push(...report.failures.map((failure) => ({ stage: `ingest:${source.name}`, ...failure })))
      const { failures: _, ...counts } = report
      const status = sourceFailed
        ? "failing" as const
        : report.failures.length > 0
          ? "degraded" as const
          : report.discovered === 0
            ? "empty" as const
            : "healthy" as const
      sourceReports.push({
        name: source.name,
        status,
        message: sourceFailed ? sourceFailureMessage : report.failures[0]?.error ?? null,
        ...counts
      })
      yield* publishEvent({
        type: "source",
        name: source.name,
        status,
        message: `${source.name}: ${report.ingested} new, ${report.cached} cached, ${report.discovered} found`
      })
    }

    const stageReports: Array<{
      name: string
      status: "healthy" | "empty" | "degraded" | "failing"
      message: string | null
    } & Omit<SourceReport, "failures">> = []
    for (const stage of stages) {
      yield* publishEvent({ type: "stage", name: stage.name, status: "running", message: `Running ${stage.name}` })
      let stageFailure: string | null = null
      const report = yield* stage.ingest.pipe(
        Effect.catchCause((cause) => {
          stageFailure = String(cause).slice(0, 500)
          return fail("stage", stage.name)(cause).pipe(
            Effect.as({ discovered: 0, ingested: 0, cached: 0, skipped: 0, failures: [] })
          )
        })
      )
      failures.push(...report.failures.map((failure) => ({ stage: `stage:${stage.name}`, ...failure })))
      const { failures: _, ...counts } = report
      stageReports.push({
        name: stage.name,
        status: stageFailure !== null
          ? "failing"
          : report.failures.length > 0
            ? "degraded"
            : report.discovered === 0
              ? "empty"
              : "healthy",
        message: stageFailure ?? report.failures[0]?.error ?? null,
        ...counts
      })
      yield* publishEvent({
        type: "stage",
        name: stage.name,
        status: stageFailure !== null ? "failing" : report.failures.length > 0 ? "degraded" : "complete",
        message: `${stage.name}: ${report.ingested} changed, ${report.cached} cached`
      })
    }

    const fs = yield* FileSystem.FileSystem
    const materialized: Array<{ resource: string; label: string }> = []
    const resourceReports: Array<{ name: string; discovered: number; materialized: number; failed: number }> = []
    for (const resource of resources) {
      let enumerationFailed = false
      const instances = yield* resource.instances.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => { enumerationFailed = true }).pipe(
            Effect.andThen(fail("instances", resource.name)(cause)),
            Effect.as([])
          )
        )
      )
      let made = 0
      let failed = enumerationFailed ? 1 : 0
      for (const instance of instances) {
        if (yield* fs.exists(dataPath(instance.key))) continue
        yield* Effect.log(`materializing ${resource.name}/${instance.label}`)
        yield* publishEvent({
          type: "resource",
          name: resource.name,
          status: "running",
          message: `Materializing ${resource.name}/${instance.label}`
        })
        yield* instance.materialize.pipe(
          Effect.tap(() => Effect.sync(() => {
            made++
            materialized.push({ resource: resource.name, label: instance.label })
          }).pipe(Effect.andThen(publishEvent({
            type: "resource",
            name: resource.name,
            status: "complete",
            message: `Materialized ${resource.name}/${instance.label}`
          })))),
          Effect.catchCause((cause) => Effect.sync(() => { failed++ }).pipe(
            Effect.andThen(publishEvent({
              type: "resource",
              name: resource.name,
              status: "failing",
              message: `${resource.name}/${instance.label} failed`
            })),
            Effect.andThen(fail(resource.name, instance.label)(cause))
          ))
        )
      }
      resourceReports.push({ name: resource.name, discovered: instances.length, materialized: made, failed })
    }

    const finishedAt = new Date().toISOString()
    yield* Files.writeJson(
      dataPath(RUN_REPORT_KEY),
      new RunReport({
        startedAt,
        finishedAt,
        sources: sourceReports,
        stages: stageReports,
        resources: resourceReports,
        materialized,
        failures
      })
    )
    pipelineRuntime.lastFinishedAt = finishedAt
    pipelineRuntime.nextRunAt = new Date(Date.parse(finishedAt) + 60 * 60 * 1000).toISOString()
    yield* publishEvent({
      type: "pipeline",
      status: failures.length === 0 ? "complete" : "degraded",
      message: `Pipeline pass finished with ${failures.length} failure${failures.length === 1 ? "" : "s"}`
    })
  }).pipe(
    Effect.ensuring(Effect.sync(() => {
      pipelineRuntime.running = false
      pipelineRuntime.currentStartedAt = null
    }))
  )
