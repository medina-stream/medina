# Effect v4 Review — Medina

## Status

This review confirms that Medina's overall architecture is sound and does not
need a redesign. It is a well-designed Effect application with a pragmatic Bun
core: layers/services, schemas, durable workflows, and content-addressed
resources are all used in the right places.

The findings below describe the remaining gap between that architecture and a
fully Effect-native implementation. They are incremental improvements for
consistency, testability, resource safety, and typed failure handling—not a
judgment that the application is fundamentally unidiomatic. The companion
`todo.md` records the same conclusion and prioritizes the work.

Reviewed against `../effect` (v4.0.0-rc.112 source). The codebase already
uses Effect well in the big picture: `Context.Service` tags, layered
construction, `Workflow`/`Activity` for durable LLM work, `Schema.Class` for
data shapes, `Config` for most settings, `Effect.fn` for traceable functions,
and `Effect.cached` for the day-index memo. The notes below are about going
further — replacing escape hatches with service-mediated equivalents, and
using Effect v4's richer APIs to remove hand-rolled machinery.

Findings are ordered by impact. Each has a concrete change.

---

## 1. Use the Clock service instead of `new Date()` / `Date.now()`

~25 call sites use `new Date().toISOString()` or `Date.now()` directly. The
Effect Way is `DateTime.now` (an `Effect`) or `Clock.currentTimeMillis`.
`DateTime.now` is already used in `Journal.ts`, `Notes.ts`, and `Time.ts` —
the rest of the codebase is inconsistent.

**Why it matters:** in a workflow/durable context, wall-clock time should flow
through the ambient `Clock` so it can be controlled in tests and recorded in
traces. The geocode rate-limiter in `Movement.ts` uses `Date.now()` for
timing, which breaks under a test clock.

**Change:** introduce a `nowIso` helper:

```ts
import * as DateTime from "effect/DateTime"
const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
```

Replace `new Date().toISOString()` in `Attribution.ts`, `Audio.ts`,
`DayIndex.ts`, `Gps.ts` (`locationSummary`), `HttpIngest.ts`, `Movement.ts`
(`materializeMovement`, `movementResource`), `Stays.ts`, `Pipeline.ts` with
`yield* nowIso`. Replace `Date.now()` in the geocode rate-limiter with
`Clock.currentTimeMillis`.

---

## 2. Replace manual `let` memos with `Cache` / `Effect.cachedWithTTL`

Two module-level mutable variables serve as caches:

- `dayIndexMemo` (`DayIndex.ts`) — already wraps `Effect.cached`, but guards it
  with a manual `let` keyed on `inputHash`. The manual guard can race if the
  input hash changes between the guard check and the cache swap.
- `movementDaysMemo` (`Movement.ts`) — a pure hand-rolled memo with `let`,
  no `Effect.cached`, so concurrent misses both scan parquet.

The geocode rate-limiter (`lastGeocodeAt`) is a third piece of mutable
module state used for 1 req/s throttling.

**Change:**

- `movementDays`: use `Cache.make` with a lookup keyed on the stays basis hash
  + zone. This gives concurrent-miss dedup for free (same as `dayIndexMemo`
  gets from `Effect.cached`).
- `lastGeocodeAt`: replace with a `Semaphore` (1-per-second) or a
  `Schedule.spaced("1 second")` retry — the Effect Way to rate-limit. At
  minimum, use `Clock.currentTimeMillis` instead of `Date.now()`.

```ts
import * as Cache from "effect/Cache"
const movementDaysCache = Cache.make({
  capacity: 1,
  lookup: (key: string) => /* the duckdb scan, keyed on basis hash+zone */
})
```

---

## 3. Use `ChildProcess` instead of `Effect.callback` + raw `spawn`/`execFile`

`Git.ts` correctly uses `ChildProcessSpawner`. But:

- `Gps.ts` `duckdb()` — raw `node:child_process` `spawn` inside
  `Effect.callback`, with manual settled-flag, stderr buffering, and temp-file
  lifecycle.
- `Tailscale.ts` `whois()` — raw `execFile` inside `Effect.callback`.

**Why it matters:** the `ChildProcess` abstraction gives scoped cleanup,
structured stdout/stderr streams, exit-code handling, and cancellation for
free. The duckdb helper's 30-line callback can shrink to a `ChildProcess.make`
+ `Stream.mkString` + `handle.exitCode` pattern, matching what `Git.ts`
already does.

**Change:** rewrite `duckdb()` using `ChildProcess.make("duckdb", ["-json"])`
+ `ChildProcessSpawner`. The temp-file-output trick can stay (it's a duckdb
limitation), but the process lifecycle, stdin write, and exit handling become
structured. Same for `whois()`.

---

## 4. Use `Crypto.Crypto` instead of raw `node:crypto` `createHash`

Three modules each define their own `sha256`:
- `Hash.ts` — `createHash("sha256").update(value).digest("hex")`
- `Stays.ts` — same, local copy
- `Movement.ts` — same, local copy

`BunServices.layer` already provides `Crypto.Crypto` (via `BunCrypto.layer`).

**Change:** consolidate into one `sha256` in `Hash.ts` that uses the `Crypto`
service:

```ts
import * as Crypto from "effect/Crypto"
import * as Encoding from "effect/Encoding"
export const sha256 = (value: string | Uint8Array) =>
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
    const digest = yield* crypto.digest("SHA-256", bytes)
    return Encoding.hex(digest)
  })
```

This makes `sha256` an `Effect` (it currently is sync), which ripples to
callers — but the callers are already in `Effect.gen` blocks. The benefit is
testability (injectable crypto) and removing the triple-duplicated function.

**Caveat:** the `Crypto` service digests a full `Uint8Array` at once (no
streaming). For the audio-ingest streaming-hash case (todo.md item), you'd
still need `node:crypto`'s `createHash` with incremental `.update()`. That's
a separate, larger change.

---

## 5. Move remaining `process.env` reads into `Config`

Four reads bypass `Config`:
- `DATA_DIR` (`Resources.ts`) — used everywhere; load-bearing
- `STAY_RADIUS_M` (`Stays.ts`) — read via `Number(process.env...)` with a
  manual `throw`
- `CLUSTER_DB` (`Cluster.ts`)
- `PORT` (`main.ts`) — already noted in todo.md

**Change:** define `Config` values and read them in the layer construction
(where `Config` is already available). For `DATA_DIR`, which is used by
`dataPath()` in pure-function contexts, read it once in the layer and provide
it as a `Context.Service`:

```ts
export class DataDir extends Context.Service<DataDir, { readonly path: string }>()("medina/DataDir") {}
```

Then `dataPath` becomes an `Effect` that reads `DataDir`, or — simpler —
keep `dataPath` as a function that takes the resolved path, and pass it down
from the layer. The current `dataPath(DATA_DIR)` pattern already accepts a
string; the issue is just that `DATA_DIR` is read from `process.env` at
module load time.

---

## 6. Use `HttpRouter.addAll` + `HttpRouter.route` for declarative routing

The current `Routes` uses `HttpRouter.use((router) => Effect.gen(...))` with
imperative `router.add(...)` calls. Effect v4's declarative form is:

```ts
const Routes = HttpRouter.addAll([
  HttpRouter.route("GET", "/", currentJournals.pipe(...)),
  HttpRouter.route("GET", "/journal/:day", Effect.gen(function*() { ... })),
  ...
])
```

This is more composable (routes are data, not side effects) and lets you
split routes into groups that merge with `Layer.mergeAll`. The behavior is
identical; it's a readability/maintainability win.

**Going further — `HttpApi`:** the endpoints could be declared as an
`HttpApi` with `HttpApiGroup` + `HttpApiEndpoint.get(...)`. This would replace
the manual `day` regex validation with `Schema.TemplateLiteral` or
`Schema.isPattern` params, give automatic JSON encoding/decoding, and generate
an OpenAPI spec. This is the most "Effect Way" option but also the largest
refactor. For a personal app, `addAll` + `route` is the pragmatic step;
`HttpApi` is worth it if you want a typed client or API docs.

---

## 7. Use `FileSystem.makeTempDirectoryScoped` for temp dirs

`Stays.ts` and `Gps.ts` create temp dirs with `${tmpdir()}/medina-...-${Date.now()}-${Math.random()...}`
and clean up manually with `fs.remove(work, { recursive: true }).pipe(Effect.ignore)`.
The todo.md notes a tmpdir leak in `Stays.ts` when DuckDB fails mid-run.

**Change:** use `FileSystem.makeTempDirectoryScoped` inside an
`Effect.scoped` block — the directory is automatically removed when the scope
closes, success or failure. No manual cleanup, no leak.

---

## 8. Let HTTP errors flow instead of `Effect.orDie` in handlers

16 `Effect.orDie` calls in route handlers convert typed errors to defects
(aborts). The `HttpServer.serve` machinery already converts causes to HTTP
500 responses via `causeResponse`. Using `Effect.orDie` means a stale
journal materialization failure crashes the fiber rather than producing a
clean 503.

**Change:** remove `Effect.orDie` from handlers and let errors propagate.
For expected failures (stale materialization, missing day), return explicit
HTTP error responses. For unexpected failures, let the server's built-in
error handling produce the 500. This also makes the error type visible in
the handler's `Effect` signature.

---

## 9. Functional accumulation in `Pipeline.ts` instead of `Effect.sync(() => array.push(...))`

The pipeline accumulates `materialized` and `failures` via
`Effect.sync(() => materialized.push(...))`. The Effect Way is to collect
results from `Effect.forEach` and aggregate functionally:

```ts
const results = yield* Effect.forEach(instances, (instance) =>
  instance.materialize.pipe(
    Effect.as({ resource: resource.name, label: instance.label }),
    Effect.catchCause((cause) => fail(resource.name, instance.label)(cause).pipe(Effect.as(null)))
  )
)
const materialized = results.filter((r): r is {...} => r !== null)
```

This is a wash on line count but removes mutable state from a concurrent
context, which is the Effect Way.

---

## 10. Minor: `batches()` variable shadowing

`Journal.ts` `batches()`: the inner `const entry = ...` shadows the
destructured `entry` from `for (const { entry, transcript } of inputs)`.
Rename the inner one to `chunk` or `partEntry`.

---

## Summary: highest-leverage changes

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 1 | `DateTime.now` / `Clock` for all timestamps | small | consistency, testability |
| 2 | `Cache` for `movementDays`, `Semaphore` for geocode | small | correctness (concurrent-miss), removes mutable state |
| 3 | `ChildProcess` for duckdb + whois | medium | removes 2 `Effect.callback` escape hatches, scoped cleanup |
| 7 | `makeTempDirectoryScoped` for temp dirs | small | fixes Stays.ts leak, removes manual cleanup |
| 5 | `Config` for `DATA_DIR` / `STAY_RADIUS_M` | small | consistency, validation |
| 6 | `HttpRouter.addAll` + `route` | small | readability |
| 8 | Remove `Effect.orDie` in handlers | small | proper HTTP error responses |
| 4 | `Crypto` service for `sha256` | small | removes 3x duplication |
| 9 | Functional pipeline accumulation | small | removes mutable state |
| 10 | Rename shadowed `entry` | trivial | clarity |

The architecture — sources → resources → key-bakes-hash → filesystem-is-state —
is sound and idiomatic. The durable workflow for journaling is exactly right.
The main theme of these findings is: replace the remaining Node.js escape
hatches (`node:crypto`, `node:child_process`, `new Date()`, `process.env`,
manual memos) with the Effect service equivalents that are already provided
by `BunServices`.
