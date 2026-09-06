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
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base"
import type * as Otel from "@effect/opentelemetry"

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

/**
 * The OTLP backend is an optional peer (`@effect/opentelemetry` on the
 * 4.0.0-rc line plus `@opentelemetry/exporter-trace-otlp-http`). The
 * specifier is hidden from tsc behind a plain string so log/off modes —
 * and the typecheck — never need those packages installed. Shapes below
 * use only types from packages that are always present.
 */
const loadModule = (name: string): Promise<unknown> => import(name)

const loadOtlp = Effect.tryPromise({
  try: () =>
    Promise.all([
      loadModule("@effect/opentelemetry"),
      loadModule("@opentelemetry/sdk-trace-base"),
      loadModule("@opentelemetry/exporter-trace-otlp-http")
    ]),
  catch: (cause) =>
    new Error(
      `TELEMETRY=otlp needs @effect/opentelemetry@4.0.0-rc.112 and ` +
      `@opentelemetry/exporter-trace-otlp-http installed: ${cause}`
    )
}).pipe(
  // Fail fast at startup with the message above: an explicitly requested
  // backend must not boot silently untraced.
  Effect.orDie,
  Effect.map((modules) => {
    const [otel, traceBase, exporterHttp] = modules as unknown as readonly [
      typeof Otel,
      { BatchSpanProcessor: new (exporter: SpanProcessor) => SpanProcessor },
      { OTLPTraceExporter: new (config?: Record<string, unknown>) => SpanProcessor }
    ]
    return {
      otel,
      BatchSpanProcessor: traceBase.BatchSpanProcessor,
      OTLPTraceExporter: exporterHttp.OTLPTraceExporter
    }
  })
)

export const TelemetryLive = Layer.unwrap(
  Effect.gen(function*() {
    const mode = yield* Config.string("TELEMETRY").pipe(Config.withDefault("log"))
    // Off provides nothing, so consumers fall back to the silent default.
    if (mode === "off") return Layer.empty as Layer.Layer<Tracer.Tracer>
    if (mode === "otlp") {
      const { otel, BatchSpanProcessor, OTLPTraceExporter } = yield* loadOtlp
      const processor = new BatchSpanProcessor(new OTLPTraceExporter())
      // The official exporter reads OTEL_EXPORTER_OTLP_* env natively, so
      // no endpoint plumbing here — just the service name and processor.
      //
      // The RC's d.ts imports `./Resource.ts` (a path that ships no file),
      // forking the Resource identity in two: tsc cannot see NodeSdk
      // satisfying layerGlobal and leaks a phantom requirement. At runtime
      // both sides carry the same tag and mergeAll wires correctly; the
      // branch works through global provider registration rather than
      // provided services, so its type is erased here — and only here.
      return Layer.mergeAll(
        otel.NodeSdk.layer(() => ({
          resource: { serviceName: "medina" },
          spanProcessor: processor
        })),
        otel.OtelTracer.layerGlobal
      ) as unknown as Layer.Layer<never, never, never>
    }
    return Layer.succeed(Tracer.Tracer, LogTracer)
  })
)
