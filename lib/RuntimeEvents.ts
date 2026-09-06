/**
 * Live progress feed: what the pipeline is doing, as it happens.
 *
 * These events are *hints*, not data. A receiver reacts by re-fetching
 * through the RPC, so caches and staleness rules stay in one place (see
 * `DayEvents.ts` for the same rule applied to day updates). That is why the
 * payload is deliberately thin: a name, a status, and a line of prose.
 *
 * The shape is a Schema rather than a bare interface because it crosses to
 * the browser. Everything else on that boundary is schema-defined and
 * decoded; an interface here would mean the one stream the UI cannot
 * validate, which is exactly where a silent drift would hide.
 */
import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"
import * as Schema from "effect/Schema"

/** What produced an event. `day` is emitted by the journal workflow. */
export const EventKind = Schema.Literals(["pipeline", "source", "stage", "resource", "day"])
export type EventKind = typeof EventKind["Type"]

/**
 * Progress, not health: `running`/`complete` describe one step of a pass,
 * while `/status` reports the settled per-source health. `disabled` appears
 * here only as the reason a source was skipped.
 */
export const EventStatus = Schema.Literals([
  "running",
  "complete",
  "degraded",
  "failing",
  "disabled"
])
export type EventStatus = typeof EventStatus["Type"]

export class RuntimeEvent extends Schema.Class<RuntimeEvent>("RuntimeEvent")({
  /** ISO-8601 instant the event was published. */
  at: Schema.String,
  type: EventKind,
  message: Schema.String,
  /** The source/stage/resource this concerns; absent for pipeline-wide events. */
  name: Schema.NullOr(Schema.String),
  status: Schema.NullOr(EventStatus),
  /** Set on `day` events: the civil day whose journal was rewritten. */
  day: Schema.NullOr(Schema.String)
}) {}

export const eventHub = Effect.runSync(
  PubSub.sliding<RuntimeEvent>({ capacity: 256, replay: 64 })
)

/** Fields a publisher supplies; `at` and the absent optionals are filled in. */
export interface PublishEvent {
  readonly type: EventKind
  readonly message: string
  readonly name?: string
  readonly status?: EventStatus
  readonly day?: string
}

/** Publish a progress event. Sliding buffer: never blocks the pipeline. */
export const publishEvent = (event: PublishEvent) =>
  Effect.asVoid(PubSub.publish(
    eventHub,
    new RuntimeEvent({
      at: new Date().toISOString(),
      type: event.type,
      message: event.message,
      name: event.name ?? null,
      status: event.status ?? null,
      day: event.day ?? null
    })
  ))

/** A day update as an ordinary event. Shared by the RPC stream and SSE so
 * both feeds describe the same thing. */
export const dayEvent = (day: string) =>
  new RuntimeEvent({
    at: new Date().toISOString(),
    type: "day",
    message: `Journal updated for ${day}`,
    name: null,
    status: null,
    day
  })
