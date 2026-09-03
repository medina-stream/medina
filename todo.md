# Medina — review findings & remaining work

## Current Effect assessment

Medina is a **well-designed Effect application with a pragmatic Bun core**.
The architecture is sound and does not need a redesign: services and layers
provide dependency injection, `Schema` provides durable data shapes, and
`Workflow`/`Activity` handles expensive LLM work durably. The content-addressed
resource model also makes freshness deterministic and pipeline passes
idempotent.

The application is not yet fully Effect-native. A small number of imperative
or Node.js escape hatches remain—direct wall-clock and environment reads, raw
child processes and crypto, mutable memoization/accumulation, manual temporary
directory cleanup, and `Effect.orDie` in HTTP handlers. These are primarily
consistency, testability, and failure-handling improvements, not architectural
problems.

`bun run typecheck` currently passes. Prioritize the Effect cleanup below in
this order:

1. Use `Clock`/`DateTime` and `Config` consistently.
2. Make temporary directories scoped and replace raw child-process wrappers.
3. Let HTTP errors remain typed instead of converting them to defects.
4. Replace mutable caches and duplicated crypto with Effect services.

From the code review of `lib/` and `example-lifelog/`. Several correctness fixes already
landed (`7ea6ab0` stripPort, `d95c004` GPS hardening); everything below is outstanding.

## Likely worth doing next

- [x] **Journal re-derivation cascade** (`Movement.ts`, `Journal.ts`)
  **Fixed:** The movement basis is now per-day. `movementDayBasisHash(day)` covers
  only the stay partitions that can overlap the local day (at most 3, since the longest
  observed stay is < 24h) and the point partitions for that day's UTC days — not the
  global stays basis. So one new GPS point on day D stales only D and its adjacent days
  (D-1, D+1), not all 49. The batch `movementDayBasisHashes` reads all partitions once
  and composes per-day hashes, so eager enumeration stays cheap.

  **Also fixed:** Notes are now their own resource (`notes-llm-v1`), keyed by the
  transcript set hash alone (no movement, no written note). The journal workflow reads
  cached notes instead of re-running the notes LLM pass, so a movement change re-journals
  paying only the report call. The incremental-generation approach (keeping the last
  generation and paying for a delta) is no longer needed — the cascade is bounded and
  the notes are cached, so the steady-state cost of a new GPS point is ~1-3 report calls
  instead of 31 notes calls + 23 report calls.

- [x] **Notes are derived data that gets thrown away** (`Journal.ts`)
  **Fixed:** The notes pass is now a separate `NotesWorkflow` that writes
  `notes/notes-llm-v1/<day>/<hash>.json`, keyed by the transcript set hash. The journal
  workflow reads `notesForDay(day)` instead of re-running N notes LLM calls. A day whose
  transcripts didn't change never re-runs the notes pass, whatever else moved.

- [x] **Drive tokens minted per request** (`lib/Drive.ts`)
  `authorized()` re-ran the token POST on every call, so each `list`/`download` paid a
  token round trip. Now cached with `Effect.cachedWithTTL("50 minutes")` — a plain
  `Effect.cached` would pin the first token for the process lifetime. Covered by
  `lib/Drive.test.ts` (3 calls → 1 mint).

- [ ] **Request-path LLM spend** (`Journal.ts`, `Movement.ts`, `main.ts`)
  First `GET /journal/:day` on a stale day materializes synchronously — now just the
  report LLM call (notes are cached), but still blocks the request. `GET /movement/:day`
  on a stale day runs the LLM `narrative()` plus Nominatim geocoding in-process; editing
  `places.json` now stales only days whose movement window includes the changed places
  (via the per-day basis), but still triggers eager rematerialization for those days.
  Consider deferring LLM work to the hourly pass and serving a "writing…" placeholder
  for stale days.

- [x] **Audio ingest buffers whole files in memory** (`Audio.ts`)
  Chunks were concatenated to compute the sha256 before writing. Now streamed:
  `hashStreamToFile` taps the download stream into an incremental hash while
  `fs.sink` writes a same-filesystem temp file, renamed into the contenthash
  blob path afterwards (existing blob ⇒ temp dropped; stream failure ⇒ temp
  removed). Covered by `example-lifelog/Audio.test.ts` plus a throwaway
  end-to-end probe (fresh ingest byte-exact, receipt-cached rerun, receipt-loss
  re-ingest, failing download → `failures`, empty `tmp/` throughout).

- [ ] **Effect cleanup** (see `example-lifelog/EFFECT-REVIEW.md`)
  The architecture is sound, but the remaining implementation is hybrid rather than
  fully Effect-native. Prioritize the review's service-boundary cleanup: use
  `Clock`/`DateTime` and `Config`, scope temporary directories, use structured
  `ChildProcess` services, preserve typed HTTP errors, and replace mutable caches and
  duplicated crypto with Effect equivalents. These are consistency and testability
  improvements, not a redesign.

## Scale horizons (fine for now)

- [ ] **`staysSource` re-hashes the whole corpus hourly** (`Stays.ts`)
  `staysBasisHash` sha256s every points parquet every pass, and `pointPartitions` runs
  twice when materializing. O(corpus) I/O per hour forever; fine at months of scale.

- [ ] **`detectStays` is O(n²)** (`Stays.ts`)
  The median over the growing member set is recomputed (with a sort) for every point.
  An 8-hour stay at 1 Hz ≈ 29k points ≈ a noticeable single-threaded stall in the
  pipeline pass. Incremental median or chunked recompute would flatten it.

- [ ] **Query results held in memory per request** (`Gps.ts`)
  `gpsDay`/`staysDay`/`staysOverlapping` round-trip results through a JSON string →
  parse, whole result per request. The temp-file plumbing added to the `duckdb` helper
  in `d95c004` makes a parquet-result path easy if days get big.

## Small stuff

- [ ] **`EAGER_WINDOW_DAYS` is set in dev** (`.env`, `Time.ts`)
  Currently `7`, so the pipeline pre-generates only the last week. Lazy dereference is
  unaffected (any day still materializes on request), but it must be unset before this
  is treated as production, or older days never refresh on their own. Same for the
  cheap dev models: `JOURNAL_LLM_MODEL=gpt-5.4-mini`, `JOURNAL_LLM_NOTES_MODEL=nano`.

- [ ] **`note/notes-day-v1` has no eviction** (`Notes.ts`)
  Notes ingest is windowed to `NOTE_WINDOW_DAYS` (90), but notes already written stay
  forever. Harmless (they're small, and a day's note is a journal input for as long as
  the day exists) — noting it so the window isn't mistaken for a bound on the data.

- [ ] **`batches()` chunking** (`Journal.ts`) — can split a UTF-16 surrogate pair at a
  chunk boundary, and repeats the `--- recording … ---` label for each part of a
  multi-part transcript. Harmless for LLM input but sloppy.

- [ ] **`locationSummary`** (`Gps.ts`) — uses `new Date()` directly (elsewhere the
  ambient Clock is used) and spawns 1–2 DuckDB subprocesses per `/location` request
  with no memo.

- [ ] **`materializeStays` tmpdir leak** (`Stays.ts`) — the local `work/` directory is
  left behind when DuckDB fails mid-run.

- [ ] **Empty journals from lazy derefs** (`Journal.ts`) — in-range but input-less days
  fetched via `/journal/<day>` persist an empty journal file (sha256("") key); the
  "no noise" guard only covers pre-epoch/future days. Bots probing dates will write
  files. Confirmed live: one `GET /journal/2011-03-05` created
  `journal/journal-v5/2011-03-05/e3b0c442…json` (removed again by hand). Cheap fix is
  to return the empty journal without persisting it when a day has no inputs.

- [ ] **`PORT` env read** (`main.ts`) — uses `process.env.PORT` directly instead of
  `Config`, the only env read outside `Cluster.ts`'s `CLUSTER_DB`.

- [ ] **AssemblyAI retries** (`lib/AssemblyAI.ts`) — only `Pending` is retried; a
  transient 5xx on upload/submit fails the whole file until the next hourly pass
  re-uploads it. A cheap retry around upload/submit would help.

## Fixed in this round (for reference)

- `currentJournals` picked a day's journal by sorting keys, which sorts by input hash
  — arbitrary. Three days on disk have several journals, so the homepage could show an
  older one with no way to tell. Now found by splitting the key path, newest chosen by
  `generatedAt`, and a lagging journal is marked in the page — `385cec4`.
- `readCorrection` did one `exists()` per capture, twice per pass, against the network
  mount: 51 round trips (3.3s) to learn that `correction/` is empty. One listing
  answers for the whole corpus (222ms) — `385cec4`.
- `dayIndexMemo` cached a value, so two concurrent misses both materialized. It now
  caches the in-flight Effect — `385cec4`.
- The notes source ingested every markdown file in the checkout (4534, a `git log`
  subprocess each) and nothing read the result. Now scoped to `Journal/<day>.md` in a
  90-day window, keyed by day, and actually feeding the journal — `385cec4`. The inert
  `note/notes-git-v1` files (4521) have been deleted from the data dir.

- `stripPort` mangled bare IPv6 (`::1` → `":"`), rejecting tailscale-serve requests
  arriving over IPv6 loopback — `7ea6ab0`.
- `isoOrNull` read fractional epoch seconds as millis (string-length heuristic) —
  `d95c004`.
- `gpsInboxWrite` wasn't atomic; a reader could catch a half-written NDJSON file and
  fail the whole DuckDB scan — `d95c004`.
- `duckdb` results crossed exec stdout under a 256 MB MAXBUFFER cap, which killed the
  subprocess (and the query) on big results; now temp-file based with stderr
  preserved — `d95c004`.
