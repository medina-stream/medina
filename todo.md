# Medina — remaining work

Architecture is sound and needs no redesign: services/layers for DI, `Schema`
for durable shapes, `Workflow`/`Activity` for expensive LLM work, and the
content-addressed resource model (key bakes in dependency hashes, so file
existence is the freshness check). What's left is incremental: serving
behavior, Effect-native consistency, scale headroom, and small hygiene items.

Baseline: `bun test` 41 pass, `bun run typecheck` clean.

## Next

- [ ] **Durable speaker identity** (`lib/lifelog/Resources.ts`, `lib/lifelog/Journal.ts`, UI)
  Store per-capture mappings from AssemblyAI's local diarization labels to a
  person, with human confirmation outranking inference. Seed the three known
  mappings: `source-574… A = Scott`, `source-eac… A = Scott`, and
  `source-940… C = Scott`. Feed confirmed `Scott:` turns as first-person
  evidence and retain other speakers as conversational context. Add a small
  confirmation UI for unmapped recordings. Universal-3.5 Pro Speaker
  Identification was tested on the seven-speaker `source-eac…` recording with
  Scott Raymond as a known value, but declined to identify anyone (its mapping
  remained A→A through G→G), so it is not a substitute for confirmed mappings.
- [ ] **Backfill lossless AssemblyAI artifacts** (`lib/AssemblyAI.ts`)
  New `.assemblyai.json` files preserve the complete provider response while
  normalized transcripts remain Medina's stable contract. The three original
  artifacts predate that fix and were schema-stripped; refetch their completed
  transcript IDs (no retranscription required) if their word-level and other
  provider fields are wanted. The separate speaker experiment already retains
  one complete response under `experiments/` in the local data dir.

- [x] **Request-path LLM spend** (`lib/lifelog/Journal.ts`, `lib/lifelog/Movement.ts`, `example-lifelog/main.ts`)
  Done: `GET /journal/:day` and `GET /movement/:day` serve via read-only
  `journalCachedForDay` / `movementCachedForDay` and return a 202
  "writing…" placeholder on a stale/missing day; the hourly pass remains the
  sole materializer.
- [ ] **Clock, not wall time** (25 sites across `lib/Pipeline.ts`,
  `lib/capture/`, `lib/lifelog/`, and `lib/Files.ts`)
  Replace `new Date().toISOString()` with a `nowIso` helper over
  `DateTime.now`, and the geocode rate-limiter's `Date.now()` with
  `Clock.currentTimeMillis` (it breaks under a test clock).
- [ ] **Typed HTTP errors, not `orDie`** (`example-lifelog/main.ts` ×10,
  `lib/lifelog/Journal.ts` ×9)
  `orDie` in handlers turns materialization failures into fiber aborts; let
  them propagate so the server returns proper 500/503s and the error type
  stays visible in signatures.
- [ ] **Kill the hand-rolled memos** (`lib/lifelog/Movement.ts`, `lib/lifelog/DayIndex.ts`)
  `movementDaysMemo` (plain `let`, concurrent misses both scan parquet),
  `dayIndexMemo` (manual guard around `Effect.cached` can race), and
  `lastGeocodeAt` (rate-limit state). Use `Cache.make` keyed on basis
  hash+zone, and a `Semaphore` or `Schedule.spaced` for the 1 req/s geocode
  limit.
- [ ] **Scoped temp dirs** (`lib/lifelog/Stays.ts`, `lib/lifelog/Gps.ts`)
  `makeTempDirectoryScoped` in an `Effect.scoped` block instead of
  `${tmpdir()}/medina-…` + manual `remove`. Fixes the `materializeStays`
  `work/` leak when DuckDB fails mid-run. (`Audio.ts` already streams to a
  same-filesystem temp + renames; `Files.writeJson` tmpfiles are fine.)
- [ ] **Structured child processes** (`lib/connectors/DuckDB.ts`, `lib/Tailscale.ts`
  `whois()`)
  Rewrite the raw `spawn`/`execFile`-in-`Effect.callback` helpers with
  `ChildProcess` + `ChildProcessSpawner` as `Git.ts` already does. Keeps the
  duckdb temp-file-output trick; lifecycle/stdin/exit handling becomes
  scoped and cancellable.
- [ ] **One `sha256`, one config path**
  `Movement.ts` and `Stays.ts` now use `lib/Hash.ts`; `Gps.ts` and audio
  capture legitimately need incremental hashing, so keep `node:crypto`
  there. Move the remaining `process.env` reads behind config services.
  `ArtifactStore` now owns safe key-to-path resolution, but lifelog modules
  still use compatibility `dataPath()` calls while they migrate to the
  service.
- [x] **Empty journals from lazy derefs** (`lib/lifelog/Journal.ts`)
  Done: `journalResource.instance` fails with `no inputs for <day>` when a
  day has no transcripts, movement, or note; `journalForDay` /
  `journalCachedForDay` answer those days with a transient empty journal and
  never touch the filesystem. Pinned by `hasJournalInputs` truth-table tests
  in `lib/lifelog/Lifelog.test.ts`.
- [ ] **Small readability pass**
  Declarative `HttpRouter.addAll` + `route` instead of imperative
  `router.add` in `example-lifelog/main.ts`; functional accumulation in `Pipeline.ts`
  instead of `Effect.sync(() => …push…)`; rename `batches()`' shadowed inner
  `entry`, and stop it splitting UTF-16 surrogate pairs at chunk boundaries;
  memoize `locationSummary` (`lib/lifelog/Gps.ts`), which spawns 1–2 DuckDB subprocesses
  per `/location` request.

## Later (fine at months-of-data scale)

- [ ] **`staysSource` re-hashes the corpus hourly** (`lib/lifelog/Stays.ts`) — every
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
  `lib/capture/Audio.test.ts`, `lib/AssemblyAI.test.ts`); tests pin
  config via `ConfigProvider.fromEnv({ env })` since `process.env` mutation
  leaks across files in one Bun process.
- Earlier: day-index memo races, notes-source scoping (4534 files → 90-day
  window), `currentJournals` newest-by-`generatedAt`, IPv6 `stripPort`, GPS
  hardening (atomic inbox writes, temp-file DuckDB transport). See git log.
