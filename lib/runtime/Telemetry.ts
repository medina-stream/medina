/**
 * Request-path observability.
 *
 * Handlers and expensive derivations are annotated with `Effect.withSpan`
 * (see `JournalRpc.ts`, `Views.ts`, `Journal.ts`, `Movement.ts`). This
 * module provides the `Tracer` those spans report to, selected by
 * `TELEMETRY`:
 *
 * - `log` (default): one line per finished span (name, duration,
 *   attributes) in the service logs. No dependencies, no backend.
 * - `otlp`: OTLP/HTTP export via `@effect/opentelemetry` to the configured
 *   collector. The annotations are standard spans, so nothing else changes.
 * - `off`: the silent default tracer.
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Tracer from "effect/Tracer"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"

const formatAttributes = (attributes: ReadonlyMap<string, unknown>) =>
  [...attributes].map(([key, value]) => `${key}=${String(value)}`).join(" ")

const LogTracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options)
    const finish = span.end.bind(span)
    span.end = (endTime, exit) => {
      finish(endTime, exit)
      const ms = Number(endTime - span.startTime) / 1_000_000
      const outcome = Exit.isSuccess(exit) ? "ok" : "fail"
      const attributes = formatAttributes(span.attributes)
      Effect.runSync(
        Effect.log(
          `span name=${span.name} durationMs=${ms.toFixed(1)} status=${outcome}${
            attributes ? ` ${attributes}` : ""
          }`
        )
      )
    }
    return span
  }
})

export const TelemetryLive = Layer.unwrap(
  Effect.gen(function*() {
    const mode = yield* Config.String("TELEMETRY").pipe(Config.withDefault("log"))
    // Off provides nothing, so consumers fall back to the silent default.
    if (mode === "off") return Layer.empty
    if (mode === "otlp") {
      const processor = new BatchSpanProcessor(new OTLPTraceExporter())
      // The official exporter reads OTEL_EXPORTER_OTLP_* env natively, so
      // no endpoint plumbing here — just the service name and processor.
      return NodeSdk.layer(() => ({
        resource: { serviceName: "medina" },
        spanProcessor: processor
      }))
    }
    return Layer.succeed(Tracer.Tracer, LogTracer)
  })
)
