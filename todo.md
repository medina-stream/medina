# Medina — remaining work

Architecture is sound and needs no redesign: services/layers for DI, `Schema`
for durable shapes, `Workflow`/`Activity` for expensive LLM work, and the
content-addressed resource model (key bakes in dependency hashes, so file
existence is the freshness check). What's left is incremental: serving
behavior, Effect-native consistency, scale headroom, and small hygiene items.

Baseline: `bun test` 22 pass, `bun run typecheck` clean.

## Next

- [x] **Request-path LLM spend** (`Journal.ts`, `Movement.ts`, `main.ts`)
  Done: `GET /journal/:day` and `GET /movement/:day` serve via read-only
  `journalCachedForDay` / `movementCachedForDay` and return a 202
  "writing…" placeholder on a stale/missing day; the hourly pass remains the
  sole materializer.
- [ ] **Clock, not wall time** (25 sites: `Pipeline.ts`, `Attribution.ts`,
  `Audio.ts`, `DayIndex.ts`, `Gps.ts`, `HttpIngest.ts`, `Journal.ts`,
  `Movement.ts`, `Notes.ts`, `Stays.ts`, `lib/Files.ts`)
  Replace `new Date().toISOString()` with a `nowIso` helper over
  `DateTime.now`, and the geocode rate-limiter's `Date.now()` with
  `Clock.currentTimeMillis` (it breaks under a test clock).
- [ ] **Typed HTTP errors, not `orDie`** (`main.ts` ×10, `Journal.ts` ×9)
  `orDie` in handlers turns materialization failures into fiber aborts; let
  them propagate so the server returns proper 500/503s and the error type
  stays visible in signatures.
- [ ] **Kill the hand-rolled memos** (`Movement.ts`, `DayIndex.ts`)
  `movementDaysMemo` (plain `let`, concurrent misses both scan parquet),
  `dayIndexMemo` (manual guard around `Effect.cached` can race), and
  `lastGeocodeAt` (rate-limit state). Use `Cache.make` keyed on basis
  hash+zone, and a `Semaphore` or `Schedule.spaced` for the 1 req/s geocode
  limit.
- [ ] **Scoped temp dirs** (`Stays.ts`, `Gps.ts`)
  `makeTempDirectoryScoped` in an `Effect.scoped` block instead of
  `${tmpdir()}/medina-…` + manual `remove`. Fixes the `materializeStays`
  `work/` leak when DuckDB fails mid-run. (`Audio.ts` already streams to a
  same-filesystem temp + renames; `Files.writeJson` tmpfiles are fine.)
- [ ] **Structured child processes** (`Gps.ts` `duckdb()`, `Tailscale.ts`
  `whois()`)
  Rewrite the raw `spawn`/`execFile`-in-`Effect.callback` helpers with
  `ChildProcess` + `ChildProcessSpawner` as `Git.ts` already does. Keeps the
  duckdb temp-file-output trick; lifecycle/stdin/exit handling becomes
  scoped and cancellable.
- [ ] **One `sha256`, one config path**
  `createHash` is copy-pasted in `Hash.ts`, `Movement.ts`, `Stays.ts`,
  `Gps.ts` — consolidate on `Hash.ts` (keep `node:crypto` there: the
  `Crypto` service can't stream, and audio ingest needs incremental
  `.update()`). Move the last `process.env` reads into `Config` (`DATA_DIR`,
  `CLUSTER_DB`, `PORT`, and `STAY_RADIUS_M` — currently read in *two*
  places, `Stays.ts` and `Movement.ts`); `DATA_DIR` wants a small
  `Context.Service` since `dataPath()` is called from pure functions.
- [x] **Empty journals from lazy derefs** (`Journal.ts`)
  Done: `journalResource.instance` fails with `no inputs for <day>` when a
  day has no transcripts, movement, or note; `journalForDay` /
  `journalCachedForDay` answer those days with a transient empty journal and
  never touch the filesystem. Pinned by `hasJournalInputs` truth-table tests
  in `Lifelog.test.ts`.
- [ ] **Small readability pass**
  Declarative `HttpRouter.addAll` + `route` instead of imperative
  `router.add` (×8 in `main.ts`); functional accumulation in `Pipeline.ts`
  instead of `Effect.sync(() => …push…)`; rename `batches()`' shadowed inner
  `entry`, and stop it splitting UTF-16 surrogate pairs at chunk boundaries;
  memoize `locationSummary` (`Gps.ts`), which spawns 1–2 DuckDB subprocesses
  per `/location` request.

## Later (fine at months-of-data scale)

- [ ] **`staysSource` re-hashes the corpus hourly** (`Stays.ts`) — every
  points parquet, every pass, plus `pointPartitions` running twice per
  materialization.
- [ ] **`detectStays` is O(n²)** (`Stays.ts`) — median re-sorted per point;
  an 8h stay at 1 Hz ≈ 29k points stalls the pipeline pass.
- [ ] **Query results cross as whole JSON strings** (`Gps.ts`) — the
  temp-file `duckdb` plumbing makes a parquet-result path easy if days grow.
- [ ] **Dev settings must not ship** (`.env`) — `EAGER_WINDOW_DAYS=7` and the
  cheap models (`gpt-5.4-mini`/`nano`) cap pre-generation; unset for prod.
- Note: `note/notes-day-v1` has no eviction (window is ingest-only, data is
  tiny) — recorded so the window isn't mistaken for a data bound.

## Done

- Journal re-derivation cascade: movement basis is per-day (≤3 partitions),
  steady-state cost of a new GPS point is ~1–3 report calls, not 31 notes +
  23 reports.
- Notes are their own resource (`notes-llm-v1`), keyed by transcript set;
  the journal reads them instead of re-running the notes pass.
- Drive mint token cached (`cachedWithTTL`, 50 min); audio ingest streams to
  disk while hashing; AssemblyAI upload/submit retry transport/5xx (1s ×3).
  Each covered by a colocated test (`lib/Drive.test.ts`,
  `example-lifelog/Audio.test.ts`, `lib/AssemblyAI.test.ts`); tests pin
  config via `ConfigProvider.fromEnv({ env })` since `process.env` mutation
  leaks across files in one Bun process.
- Earlier: day-index memo races, notes-source scoping (4534 files → 90-day
  window), `currentJournals` newest-by-`generatedAt`, IPv6 `stripPort`, GPS
  hardening (atomic inbox writes, temp-file DuckDB transport). See git log.
