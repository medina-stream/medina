# Medina — review findings & remaining work

From the code review of `lib/` and `example-lifelog/`. Four correctness fixes already
landed (`42cca11` stripPort, `ed17b06` GPS hardening); everything below is outstanding.

## Likely worth doing next

- [ ] **Drive tokens minted per request** (`lib/Drive.ts`)
  `authorized()` re-runs the token POST on every call, so each `list`/`download` pays a
  token round trip. Cache the token (`Effect.cached`, or cache with expiry off the
  response).

- [ ] **Request-path LLM spend** (`Journal.ts`, `Movement.ts`, `main.ts`)
  First `GET /journal/:day` on a stale day materializes synchronously — notes batches +
  report LLM calls block the request. `GET /movement/:day` on a stale day runs the LLM
  `narrative()` plus Nominatim geocoding in-process; editing `places.json` changes the
  shared movement basis → 14 eager rematerializations → up to 14 LLM calls + geocode
  burst + journal-restale cascade. Consider deferring LLM work to the hourly pass and
  serving a "writing…" placeholder for stale days.

- [ ] **Audio ingest buffers whole files in memory** (`Audio.ts`)
  Chunks are concatenated to compute the sha256 before writing; hours-long recordings
  can be hundreds of MB. Stream the hash + stream the write to disk instead.

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
  in `ed17b06` makes a parquet-result path easy if days get big.

## Small stuff

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
  files.

- [ ] **`PORT` env read** (`main.ts`) — uses `process.env.PORT` directly instead of
  `Config`, the only env read outside `Cluster.ts`'s `CLUSTER_DB`.

- [ ] **AssemblyAI retries** (`lib/AssemblyAI.ts`) — only `Pending` is retried; a
  transient 5xx on upload/submit fails the whole file until the next hourly pass
  re-uploads it. A cheap retry around upload/submit would help.

## Fixed in this round (for reference)

- `stripPort` mangled bare IPv6 (`::1` → `":"`), rejecting tailscale-serve requests
  arriving over IPv6 loopback — `42cca11`.
- `isoOrNull` read fractional epoch seconds as millis (string-length heuristic) —
  `ed17b06`.
- `gpsInboxWrite` wasn't atomic; a reader could catch a half-written NDJSON file and
  fail the whole DuckDB scan — `ed17b06`.
- `duckdb` results crossed exec stdout under a 256 MB MAXBUFFER cap, which killed the
  subprocess (and the query) on big results; now temp-file based with stderr
  preserved — `ed17b06`.
