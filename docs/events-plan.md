# Device events plan

A super-lightweight, general **event** primitive: any emitter (the Android
capture app, the server itself, future clients) volunteers small facts about
itself; the server herds each event to the right destination. The motivating
use is the server knowing what the phone is doing in real-ish time — e.g.
"currently recording" — without ever peering into client state.

This is deliberately *not* synced SQLite (Litestream-style). Realms stay
separate: the client emits facts, the server interprets them. An event is a
hint with an identity, not a replica of a database.

## Non-goals

- **Not a replacement for `lib/RuntimeEvents.ts`.** That stays the ephemeral,
  in-process progress feed (sliding `PubSub`, never blocks the pipeline). This
  plan is the durable, cross-realm counterpart: events that arrive from
  outside the process and survive restarts.
- **Not a command channel.** Events flow emitter → server. Nothing here lets
  the server reach into a device or tell it what to do; the capture policy
  remains the only server→device direction.
- **Not exactly-once.** At-least-once with idempotent handling. Emitters are
  on flaky networks; duplicates are normal.

## The primitive

One envelope, typed by a literal union, decoded with Effect Schema at the
boundary like everything else that crosses into the pipeline:

```ts
export class DeviceEvent extends Schema.Class<DeviceEvent>("DeviceEvent")({
  /** Client-generated UUID. The dedupe key: re-PUTs are normal. */
  id: Schema.UUID,
  /** Which emitter this came from (install id, hostname, …). */
  device: Schema.String,
  /** Monotonic per-device sequence; best-effort ordering alongside `at`. */
  seq: Schema.Number,
  /** ISO-8601 instant the emitter recorded the event. */
  at: Schema.String,
  type: DeviceEventType,
  /** Per-type payload; each type gets its own Schema class. */
  payload: Schema.Unknown,
}) {}
```

`DeviceEventType` starts small and grows by adding literals — the router (below)
is a registry, so new types don't touch existing handling:

```ts
export const DeviceEventType = Schema.Literals([
  "app.started",        // { version, policyVersion }
  "recording.started",  // { segmentId, at }
  "recording.sealed",   // { segmentId, durationMs, bytes }
  "upload.completed",   // { segmentId, bytes, millis }
  "upload.failed",      // { segmentId, error, attempt }
  "policy.refreshed",   // { policyVersion }
])
```

Keep the initial vocabulary to the recording/upload lifecycle. The shape must
stay general enough that a future emitter (browser extension, CLI) can use it
without phone-specific fields leaking into the envelope.

## Transport: tiny objects in the bucket

The emitter PUTs each event as one small JSON object:

```text
events/<install-id>/YYYY/MM/DD/<utc>-<uuid>.json
```

Why the bucket and not a direct POST to the server:

- The emitter already has write credentials and a working PUT path (policy
  upload config). No new auth, no new endpoint, no new failure mode.
- It survives server outages by construction — events just queue in the bucket
  until the next ingest pass. A POST would need a client-side spool and retry
  story we don't have.
- Latency is the ingest poll interval (~1 minute). That is "real-ish time
  usually," which matches the stated need. Sub-second can come later as an
  optional POST fast-path without changing the envelope or router.

The `events/` top-level prefix keeps event objects out of the install-id
capture listing and makes the source listing trivial. Raw event objects are
tiny (<1KB, a few hundred per device per day); no retention policy yet —
revisit if a fleet of emitters ever makes the listing expensive. Unlike
`capture/` evidence, events are *not* immutable archive material; once
materialized they are disposable.

## Server ingest: a new source

A new `event-bucket` pipeline source, shaped like `capture-bucket`:

- Lists `events/` (oldest-first — see the ingest-starvation fix; the same
  newest-first trap applies here).
- Downloads each object, decodes with `Schema.decodeUnknown(DeviceEvent)`.
  Decode failures are quarantined (logged, receipted, never retried forever).
- Receipt-guarded per object key, so re-listing never reprocesses; dedupe on
  `DeviceEvent.id` covers the re-PUT case where the key itself is new.
- Ordering is best-effort by (`at`, `seq`). Handlers must tolerate
  out-of-order and late arrival — e.g. `recording.sealed` arriving before its
  `recording.started` just fills in the other half of the state.

`SourceBucket` stays read-only; the event source is ingest-only by the same
construction as `capture-bucket`.

## Routing: herded to the right destination

```ts
export interface EventHandler {
  readonly type: DeviceEventType
  readonly handle: (event: DeviceEvent) => Effect.Effect<void>
}

export class EventRouter extends Context.Tag("EventRouter")<
  EventRouter,
  { readonly route: (event: DeviceEvent) => Effect.Effect<void> }
>() {}
```

`EventRouterLive` is built by merging handler Layers — adding a destination
is adding a Layer, not editing a switch. The initial destinations:

1. **LiveState** — an `Effect.Ref<Map<string, DevicePresence>>` keyed by
   device: last event, current recording segment (if any), last upload
   error. This is what answers "what is the phone doing right now" and can
   back a status view over RPC/SSE.
2. **EventLog** — appends each event to a per-day JSONL
   (`events/log-v1/2026-09-18.jsonl`, local). Queryable history; the raw
   material for "recent error rates" without touching client state.
3. **Hub bridge** — republishes selected types into the existing in-process
   `RuntimeEvents` hub, so the live SSE feed and pipeline UI see device
   activity through the mechanism they already consume.

Later destinations that need no envelope change: alerting on `upload.failed`
bursts, per-device health rollups, feeding the journal's "what was happening"
context.

## Effect shape summary

| Piece | Shape |
| --- | --- |
| Envelope + per-type payloads | `Schema.Class`, decoded at the bucket boundary |
| Ingest | `Effect.Stream` from `SourceBucket.list`, `Stream.mapEffect` decode, `Stream.runForEach` route, existing receipt mechanism |
| Router | `Context.Tag` + `Layer`, handlers as merged Layers keyed by event type |
| Live presence | `Effect.Ref` (or `PubSub` if broadcast is needed) |
| History | Append-only per-day JSONL, local |

Failure posture follows the pipeline's: decode failure quarantines the
object; handler failure is isolated per event (one bad handler doesn't stall
the stream); everything is retried by re-listing, never by blocking.

## Android emitter

Best-effort, never in the way of capture:

- An `EventEmitter` writes each event JSON to a local outbox directory and
  enqueues a WorkManager PUT to `events/<install-id>/…` reusing the existing
  upload worker, credentials, and retry/backoff.
- Events are fire-and-forget: if the outbox grows, it is bounded (drop oldest
  `app.started`-class chatter first, never drop `upload.failed`).
- Clock: `at` is device time; the server treats it as advisory (see ordering).
- No new permissions, no new process, no sidecar binary — the Litestream shape
  doesn't fit Android's background execution model, and we don't need it.

## Phases

1. **Envelope + router + log.** `DeviceEvent` schema, `EventRouter` service,
   JSONL log, hub bridge. The server dogfoods it by emitting its own
   `policy.refreshed`-style events. No client changes.
2. **Bucket transport.** `event-bucket` source (list/decode/receipt/dedupe).
3. **Android emitter.** Recording/upload lifecycle events; LiveState backs a
   "now recording" presence the server can serve.
4. **Destinations.** Alerting, health rollups, journal context — as needed,
   each a new handler Layer.

## Open questions

- Retention/GC for raw `events/` objects once materialized (probably "leave
  them; revisit at fleet scale").
- Whether a direct-POST fast-path is ever worth it, and its auth story
  (likely the capability token already in the policy).
- Clock skew: device `at` vs ingest time for presence expiry ("recording"
  shown stale if the phone dies mid-segment — presence needs a TTL).
- Event types the server itself should emit in phase 1 (ingest lag? backlog
  depth?).

## Prior art

Scott has built this shape before in previous iterations; revisit those notes
before finalizing the envelope — particularly around type-vocabulary
discipline (what earned a first-class type vs payload field) and anything
learned about presence TTLs.
