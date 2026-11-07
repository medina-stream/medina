# Medina on Cloudflare: migration plan

Status: milestone 4 in progress (§4.3) — milestones 1–3 done,
milestone 3's fresh-capture follow-up closed Oct 30 (§4.2);
milestone 4 step 1 (journal serving on the Worker) done Oct 30,
pipeline-stage cutovers next, each gated on its Secrets Store /
index-token prerequisites (§4.3).
Milestone 1 (plan + scaffold + policy-serving proof) completed
Oct 27, 2026.
Decision (Scott, Oct 27): Medina leaves exe.dev. Development stays on the
`effect-rethink` branch; deployment target is Cloudflare, **Workers-native**,
infra declared with **Alchemy** on the standard path (the hskping pattern:
`alchemy.run.ts`, local state, version island alchemy 2.0.0-beta.83 /
effect 4.0.5). **Archil is dropped entirely** — R2 is the only storage in
the target architecture.

This document inventories what runs today (from the code, not from memory),
maps each piece to its Workers-native home, and sequences the move so the
live system is never at risk.

## 1. What exists today

### 1.1 The bun server (`example-lifelog/main.ts`, medina-dev)

One Effect process on medina-dev (bun, port 8000) serves everything,
behind the exe.dev login gate — which is why the phone can only reach it
over the tailnet, and why the public device routes already live elsewhere
(the medina-index Worker, §1.4).

HTTP surface (Effect `HttpRouter`, no framework):

| Route group | Routes | Notes |
| --- | --- | --- |
| Journal UI | `/`, `/devices`, `/journal/:day`, `/movement/:day`, `/gps/:day`, `/api/days/:day/gps`, `/stays/:day`, `/stars/:day`, `/star/:id`, `/location`, `/status`, `/events` | Server-rendered pages (`lib/lifelog/Pages.tsx`, `Views.ts`) + a bundled browser client (`public/app.js`). Auth-gated. |
| Auth / agents | `/auth.md`, `/auth/requests`, `/auth/approve/:id`, `/auth/delegations`, `/oauth2/token`, `/oauth2/revoke`, `/.well-known/oauth-*`, `POST /rpc` (typed journal RPC), `/cli/*` (CLI bundle + skill doc) | Medina's own OAuth-flavored delegation scheme (`lib/lifelog/Auth.ts`, `JournalRpc.ts`). MCP bridge reads through this host today. |
| HTTP ingest | `POST /in` | Push ingest: a posted body (e.g. GPS batches) becomes a capture, archived to the bucket before responding (`lib/capture/HttpIngest.ts`). |
| Capture policy | `GET /api/capture-policy/:token`, token admin (`POST/GET /api/capture-policy/tokens`, revoke), `PUT /api/capture-policy` | §1.3. Public on the server too, but unreachable by phones through the gate. |
| APK downloads | `GET /bucket-capture/:name` | Streams a published recorder APK from the bucket (`lib/capture/CaptureApk.ts`). |

### 1.2 The pipeline loops (`lib/Pipeline.ts`, `runPipeline`)

Four scheduled loops, each receipt-guarded and idempotent, passes spaced
from completion so they never overlap:

| Loop | Cadence | Contents |
| --- | --- | --- |
| `ingest` | 1 min | Sources: `audio-drive` (Drive folder audio), `drive-allow` (allowlisted Drive files), `notes-git` (notes repo), `bucket-audio` (recordings in the archive bucket). Stages, in order: `archive` sweep → `media-normalize` (Transloadit) → `media-transcribe` (AssemblyAI) → `gps-compact` → `gps-stays`. Resources: attribution, day-index, transcript-search, movement, notes, journal, stars. A warm pass takes ~1 h; a cold pass ran 2 h+ (Oct 27). |
| `capture` | 1 min | Sources only, no stages/resources: `local-transcripts`, `device-events`, `capture-bucket` — all read the capture source bucket (`sco-lifelog-in`) through the read-only `SourceBucket` API and write ingest receipts. Split out Oct 27 (commit `047d2fc`) so phone segments land in minutes regardless of the main pass. |
| `inventory` | 1 h | `drive-inventory`: full Drive metadata re-crawl; nothing downstream reads it in real time. |
| star detector | 90 s | Re-scans recent transcripts for spoken "star …" commands, files voice stars, runs the retention sweep (`lib/lifelog/StarDetector.ts`). |

Stage semantics that any port must preserve:

- **Receipts are the state.** Every source/stage item is identified by
  (key, version); a receipt file means "done", and passes only work on
  un-receipted items (`lib/capture/Discover.ts`: receipt filter *before*
  the work window — the fix for the Sep 18 starvation modes).
- **Submit-then-poll for paid providers.** Transloadit and AssemblyAI
  stages submit signed R2 URLs and write a durable *job receipt*; later
  passes poll the receipt instead of resubmitting (`media-transcribe`
  discovered 15 / submitted 4 in the Oct 28 01:37 pass — the rest were
  polls). This is what makes a duplicate submission a bug, not a race.
- **Settle markers for permanent failure.** Media chunks missing from
  both R2 and local storage are dead-lettered via settle markers
  (`normalize-settled/…`, transcript settled markers) so they cost one
  stat per pass instead of ~13 min of failures (Oct 27, `047d2fc`).
- **Durable workflows for LLM work.** Journal materialization already
  runs as Effect Cluster workflows with Activities per LLM call
  (`lib/runtime/Cluster.ts`, SingleRunner + SQL mailbox today), so a
  crash resumes past paid LLM calls.

### 1.3 Capture policy + tokens (`lib/capture/CapturePolicy.ts`)

- The policy document (`CapturePolicy` schema: `version`, `updatedAt`,
  `audio{enabled,codec,channels,sampleRateHz,bitrateBps,segmentSeconds}`,
  `gps{…}`, `upload{endpoint,bucket,region,prefix,credentials,
  unmeteredOnly}`, optional `apk{stamp,url,sha256,sizeBytes,publishedAt,
  notes}`) is **canonical in the bucket** at `capture-policy/policy.json`
  in `sco-lifelog`. The server reads through it (etag-revalidated); the
  publish script (`scripts/capture-apk-publish.ts`) writes APK object
  first, policy second — the policy never points at a missing build.
- Tokens are per-device capability tokens (`cpol_…`); only SHA-256
  hashes are stored. The registry lives on the server's disk and is
  **mirrored to `capture-policy/tokens.json`** in the bucket on every
  write (hashes only, `revokedAt` included) purely so a public edge can
  verify tokens without reaching the server.
- The app contract is just this: fetch the policy URL, obey the document,
  PUT audio to the bucket with the embedded scoped credentials, offer the
  `apk` update after hash verification. **The app does not change in
  this migration** — only the policy URL it is given.

### 1.4 The medina-index Worker (already on Cloudflare)

`workers/medina-index` (Wrangler-managed, `medina-index.alignlabs.workers.dev`):
a Durable Object (SQLite) artifact index (`objects`, `latest` tables) the
server writes through on every artifact put/delete, plus the two public
device routes reading its `sco-lifelog` R2 binding:

- `GET /api/capture-policy/<token>` — verify against the mirrored
  registry, return the canonical policy; unknown/revoked → 404.
- `GET /bucket-capture/<stamp>.apk` — stream `bucket-capture/<stamp>.apk`.

This worker is the proof the edge pattern works; the migration absorbs
its jobs into the Alchemy stack rather than leaving a second,
hand-managed worker. (Milestone 1 does not touch it — the new proof
Worker duplicates its two public routes additively, §4.)

### 1.5 Storage

- **Archil mount** (`/mnt/archil/medina`, the server's `DATA_DIR`):
  the working artifact tree — `capture/`, `ingest/<source>/` receipts,
  `journal/`, `index/` (day-index snapshots), `media/`, `normalize/`,
  `discovery/<source>/index-v1.json`, `runs/` (per-loop reports),
  transcripts, attribution, notes, GPS parquet. Artifact keys are the
  contract (`docs/storage-layout.md`); most namespaces are local-only
  today, with capture originals mirrored to the bucket.
- **ArtifactStore seam** (`lib/ArtifactStore.ts`): `ARTIFACT_STORE=local`
  (current) vs `=bucket` — a bucket backend over S3 (`sco-lifelog`) plus
  the medina-index DO as its listing/latest-pointer index already
  exists, with a one-shot migration tool (`lib/MigrateArtifacts.ts`,
  `scripts/migrate-artifacts-to-bucket.ts`) that copies the tree
  key-for-key, registers every artifact, and hash-verifies a sample.
- **Buckets**: `sco-lifelog-in` — the app uploads here; the server reads
  it through a physically read-only API (`lib/Bucket.ts` `SourceBucket`).
  `sco-lifelog` — canonical artifact bucket (capture archive, normalized
  media chunks, policy, APKs). `sco-lifelog-public` — public artifacts.
- **The DayIndex tax** (`lib/lifelog/DayIndex.ts`): `currentDayIndex`
  re-decodes all ~2,400 canonical transcripts (~500 MB over the FUSE
  mount) to compute a freshness hash on *every* call; journal renders
  pay it (>110 s on a cold mount). Transcript search has the same shape.
  This is the single biggest reason journal reads are slow, and it is a
  *storage* problem, not a compute problem.

## 2. Target architecture (Workers-native)

One Alchemy stack, **Medina** (`cloudflare/alchemy.run.ts`), local state
like hskping. Everything below is a Worker, a Cron Trigger, a Queue, a
Workflow, or a Durable Object — no containers, no VMs, no mounted
filesystems. Development continues in this repo on `effect-rethink`;
the bun server remains the running production until cutover (§3).

| Today | Workers-native home |
| --- | --- |
| HTTP routes (journal UI, auth, `/rpc`, `/in`, `/status`, policy admin) | The Medina **Worker** (Effect `HttpRouter`, same as today — no Hono, per the hskping precedent). Pages render server-side as now; the browser bundle ships as Worker assets. |
| Public device routes (policy fetch, APK) | Same Worker, public paths ahead of the auth gate — exactly the medina-index split, absorbed. Milestone 1 proves these two routes (§4). |
| `capture` loop (1 min) | **Cron Trigger (1 min)** on the Worker → discovery against `sco-lifelog-in` via R2 binding → receipts + discovery state in the **index Durable Object** (SQLite). No S3 client needed; bindings replace signed requests. |
| `ingest` loop stages | **Queues + Workflows.** Each stage becomes per-item queue messages; the Transloadit/AssemblyAI submit-then-poll pattern becomes a **Workflow** per capture (submit step, durable wait/poll steps on the job receipt) — the workflow instance *is* the job receipt, which removes the poll-on-later-pass machinery. GPS compaction/stays and the archive sweep are queue consumers with DO/R2 state. |
| Resources (day-index, transcript-search, attribution, movement, notes, journal, stars) | **Durable Objects with SQLite** hold the derived *indexes* (day index, transcript search, discovery state, run reports). Derivations run as queue/workflow steps that update the DO incrementally per capture — a day index entry changes when its day's inputs change, keyed by content hash, so nothing ever re-decodes the corpus to check freshness. This is the change that retires the DayIndex tax and the >110 s journal render. Journal *documents* still materialize as artifacts in R2; journal *reads* hit the DO index + R2, not a corpus scan. |
| Star detector (90 s) | Cron Trigger (1 min is the finest cron grain; the detector's period becomes 60 s — harmless, it's idempotent) or a step in the capture cron. |
| Drive sources + inventory crawl | A scheduled Worker (Cron, hourly for inventory; the Drive sources join the ingest queues). Drive API calls are plain HTTPS — no bun dependency. The Drive *byte* path (Transloadit reads originals from R2 directly) is unchanged. |
| ArtifactStore (local dir) | R2 bindings + the DO index. The bucket backend and index client already exist server-side; in the Worker they collapse into native bindings (no S3 signing, no HTTPS index client). |
| Provider keys (AssemblyAI, Transloadit, model APIs), session secrets | **Secrets Store** bindings attached out-of-band, read via `.get()` — the hskping Path B precedent. Values never enter Alchemy state or this repo. |
| Cluster workflows (SQLite mailbox on the VM) | **Cloudflare Workflows** — same programming model (durable steps, Activities ≈ steps), platform-hosted state. |
| MCP bridge / CLI | The MCP server and CLI become clients of the Worker's `/rpc` + auth routes over HTTPS — they stop depending on the tailnet name. |

Buckets stay exactly as they are: `sco-lifelog-in` remains the app's
upload target and the pipeline's read-only source (binding-level
read-only is by code discipline in the Worker; the binding itself is
scoped to that bucket), `sco-lifelog` canonical, `sco-lifelog-public`
for public artifacts.

Domain: workers.dev to start (`medina-dev.<account>.workers.dev` for the
milestone-1 proof). A custom domain is a cutover-time decision, not a
scaffold decision.

## 3. Sequencing

Each phase is independently safe; medina-dev keeps serving throughout
phases 0–3, and every phase can be abandoned without unwinding the last.

0. **Scaffold + policy proof (this milestone).** Alchemy stack, proof
   Worker on its own name/stage serving `/health`, the policy route,
   and APK downloads from the bucket. Read-only against `sco-lifelog`;
   nothing live points at it.
1. **Shadow ingest.** The Cloudflare capture path runs in
   **discover-only mode**: it lists `sco-lifelog-in`, computes what it
   *would* ingest, and records that in its own DO — but writes no
   receipts the old pipeline can see and **submits nothing to any paid
   provider**. Compare shadow output against medina-dev's capture
   receipts daily; they must agree exactly (same keys, same versions).
2. **Data migration.** Run the existing artifact migration
   (key-for-key copy + index registration + sampled hash verification)
   from the Archil tree into `sco-lifelog`, then keep both stores
   converging: medina-dev flips to `ARTIFACT_STORE=bucket` (a config
   change on the old host, its own step, reversible) so any artifact
   written after the bulk copy lands in the bucket by construction.
   Verify: per-namespace object counts and the tool's hash sample, plus
   a journal-render diff on a sample of days.
3. **Stage cutover, one stage at a time**, in pipeline order (archive →
   normalize → transcribe → GPS → resources). The rule that keeps paid
   transcription safe: **a capture has exactly one submitter at any
   moment.** Because job receipts are durable and keyed by capture, the
   handover per stage is: old loop stops submitting that stage (config
   flag), in-flight job receipts are copied/registered, new loop starts
   *polling those receipts* before it is allowed to submit new work.
   Polling is idempotent and free; submitting is the only paid,
   non-idempotent step, and it is gated on "no receipt exists", checked
   against the same receipt set both sides wrote.
4. **Phone cutover.** Publish a policy whose routes point at the Worker
   — concretely, hand the app the new policy URL (the Worker host) the
   same way the Oct 27 worker-URL swap was done. The app contract is
   unchanged; the old routes keep working, so a phone that hasn't
   refreshed yet is unaffected. The policy *document* does not change
   shape or location (canonical in the bucket throughout).
5. **Read cutover.** Journal UI + `/rpc` + MCP read from the Worker.
   medina-dev becomes a cold standby.
6. **Retire medina-dev.** Stop the old loops last (they are the safety
   net through phase 5), then the host. The medina-index Worker's index
   job is by then either absorbed or redundant — delete it only after
   the DO index in the new stack has served a full cycle.

## 4. Milestone 1 (done in this pass)

- This plan.
- `cloudflare/` scaffold: `alchemy.run.ts` (stack **Medina**, local
  state, `Cloudflare.R2.Bucket` adopted-not-owned for `sco-lifelog`,
  one Worker), `src/worker.ts` (Effect-structured fetch handler),
  `package.json` on the hskping island (alchemy 2.0.0-beta.83,
  effect 4.0.5).
- Proof Worker deployed to stage `dev`, serving on workers.dev:
  `GET /health`, `GET /api/capture-policy/<token>` (verify against the
  bucket-mirrored hash registry, return the canonical policy;
  unknown/revoked → 404), `GET /bucket-capture/<stamp>.apk` (stream
  from the bucket). Verified live from the public internet, including a
  hash/size check of the current APK and a structural check of the
  policy (no credential material printed or committed).
  Deployed as `medina-api-dev-jqvywelf7ukj6sms` at
  https://medina-api-dev-jqvywelf7ukj6sms.alignlabs.workers.dev
  (Alchemy-derived name; the suffix is stable per stack state).

Explicitly *not* in this pass: ingest implementation, data migration,
any change to medina-dev, the medina-index Worker, the canonical policy,
or the phone's configured URL.

## 4.1 Milestone 2 — shadow ingest (done in this pass)

§3 phase 1, on the same Worker and stage:

- **Stack additions**: the `sco-lifelog-in` bucket adopted for a read
  binding (`CAPTURE_IN`), a minutely Cron Trigger (`* * * * *`) on the
  Worker, and the `ShadowDiscovery` Durable Object (SQLite-backed,
  Alchemy `new_sqlite_classes` migration).
- **Shadow pass** (the Worker's `scheduled` handler): paginate the
  whole source prefix (6,422 objects at first pass), sort newest-first
  by lastModified, classify with the server's exact filters
  (capture-bucket .m4a / device-events `/events/` .json /
  local-transcripts `/transcript/` .json, `probe/` dropped), and hand
  the classified set to the DO, which records per object key: source,
  size, etag, bucket lastModified, and `firstSeenAt` (the pass's
  scheduled start). Bookkeeping (run count, last run) is written
  *before* the batch inserts, so an interrupted pass still leaves a
  trace. `GET /shadow/status` and a manual `POST /shadow/run` sit
  behind the same device-token gate as the policy route.
- **Census parity**: the first (cold) pass classified 6,296 objects —
  capture-bucket 2,124, device-events 3,140, local-transcripts 1,032 —
  matching an independent S3 census of the bucket exactly; the 126
  unclassified objects are the location JSONs and probe objects the
  server likewise skips.
- **Fresh-segment parity** (the window after the cold pass, Oct 28
  06:30–06:37 UTC): three new audio segments uploaded; the shadow saw
  all three, and medina-dev held ingest receipts for all three — no
  misses. The 06:15 segment's 262 s shadow latency is entirely the
  new Cron Trigger's warm-up (created 06:25 UTC, first fire ~06:34);
  the two 06:30/06:36 segments were seen by the pass that started
  within seconds of their upload (their small negative raw latencies
  are the pass-start timestamp artifact: an object uploaded mid-pass
  is listed moments later in that same pass; true latency ≤ the
  ~8 s pass duration — one cron tick, like-for-like with the
  medina-dev loop).
- **Discover-only, verified by construction**: the cron path calls
  only `list` on the source binding and `fetch` on its own DO; there
  is no object `get`, no bucket write, and no provider submission
  anywhere in the shadow code path.

Friction noted for later phases: the shadow tracks *keys*, the server
tracks *(key, version)* — they coincide for immutable capture objects,
but `.live.json` transcript partials are overwritten in place, so the
shadow records their first sighting only, not their updates (the DO
keeps the original etag/lastModified). If live partials matter to a
future phase, the DO schema grows a version column. Also: each pass
ships the full classified set (~6.3k rows) to the DO; fine at this
bucket size, but a windowed listing (the server's warm-pass bound) is
the obvious optimization when the bucket grows.

## 4.2 Milestone 3 — Archil → R2 data migration (copy verified; flip attempted and rolled back)

§3 phase 2, executed Oct 28, 2026 (bulk copy ~07:12–11:05 UTC, flip
11:29 UTC, rollback 11:35 UTC):

- **Seam check first**: ingest receipts and pipeline state are written
  through `lib/Files.ts`, which routes through the in-context
  `ArtifactStore` — so receipts, discovery indexes, and run reports
  migrate with the artifacts key-for-key. No separate receipt
  migration exists or is needed, and the flip cannot cause mass
  re-submission on receipt grounds.
- **Bulk copy** (the repo's `scripts/migrate-artifacts-to-bucket.ts`,
  run per top-level prefix in four parallel workers; the tool is
  sequential per key — local stat + bucket head + put + index
  registration — and the medina-index DO's serialized registration is
  the throughput ceiling, ~2–11 keys/s aggregate):
  **51,753 keys scanned, 67.37 GB total; 43,347 uploaded
  (21.34 GB), 8,406 skipped as already present with matching size
  (8,259 capture originals, 145 media chunks, the 2 capture-policy
  objects); 0 failures.** Per-prefix counts and byte totals in the
  bucket afterwards match the local scan exactly, prefix for prefix
  (media holds 413 additional bucket-only Transloadit chunk objects
  that were never part of the local tree). Verification: 776
  full-content sample hashes matched, 15 more size-verified (files
  over the 64 MiB hash cap), **0 mismatches**. The one prefix the
  tool cannot target is a bare top-level *file* key (`places.json` —
  its `list(prefix)` treats the prefix as a directory); it and the
  writes the live pipeline made during the ~4 h copy window were
  converged afterwards by an explicit-key copy (528 keys listed,
  276 copied, 252 already matching, 0 failures; plus a final
  24-key mini-converge immediately before the flip). One prefix,
  `normalize-settled/` (tonight's dead-letter markers), was created
  after the initial inventory and copied separately (11 keys,
  hash-verified). The Archil copy is untouched throughout and
  remains the cold backup. Tooling note: `du` over the Archil FUSE
  mount badly underreports (the `search/` tree is 15.66 GB by stat,
  not the 1.9 GB `du` claimed) — trust stat-based totals.
- **The flip**: `ARTIFACT_STORE` was unset (default `local`); the
  flip appended `ARTIFACT_STORE=bucket` to `/home/exedev/medina/.env`
  (the systemd unit sets no artifact env) and restarted the service
  once (new MainPID 968610 at 11:29:40 UTC). The bucket-store path
  itself worked immediately: the first capture pass ran entirely
  against the bucket and wrote its report there (started 11:29:42,
  finished 11:30:24 UTC, all sources clean).
- **Why it was rolled back**: a seam leak in the file-ingest paths.
  `ingestAudioFile` (`lib/capture/Audio.ts`, and the twin in
  `lib/capture/HttpIngest.ts`) streams each blob to a local tmp
  file and `fs.rename`s it into `capture/<captureId>/` with direct
  filesystem calls — by design from when the store *was* the disk —
  while provenance and receipts go through the `Files` seam. With
  the store flipped, every newly ingested capture split: provenance
  and receipt in the bucket, blob bytes stranded on Archil, never
  registered in the index. The archive sweep
  (`lib/capture/Archive.ts` `archiveCapture`) then discovers the
  capture from the bucket index, lists `provenance.json`, and
  `fs.stat`s it on the local path — NotFound — failing that capture
  on every pass. The signature (`FileSystem.stat …/provenance.json`)
  occurred 0 times in the 9 days before the flip and 18 times
  (18 distinct captures) in the ~5 minutes after it. That is a
  half-flipped system for new data, so the flip was reverted rather
  than left in place: `.env` restored (previous value: unset),
  one controlled restart (MainPID 968844 at 11:35:13 UTC), and
  health confirmed on the local store (capture pass completed
  11:35:14–11:37:35 UTC, zero error lines after the restart). The
  18 split captures self-heal on the next main pass (their ingest
  receipts exist only in the bucket, so the file sources re-ingest
  them locally; the blob is already on disk, and provenance and
  receipt are rewritten locally). The ~15 minutes of bucket-side
  writes from the flipped window remain in the bucket, harmless;
  the local store is authoritative again.
- **Fix required before re-flipping** (code change, its own step):
  land ingested blobs through the store — stream to the local tmp
  file as today, then `putFile` it into the bucket store (which
  registers it) instead of `fs.rename` into the capture dir — in
  `Audio.ts` and `HttpIngest.ts`; and make `archiveCapture`
  store-consistent (list and size/hash through the store, not
  direct `fs.stat` on local paths; `Media.ts`'s capture-dir reads
  deserve the same audit). Re-run the converge pass, then flip
  again with the same procedure.

### Re-flip (Oct 28, evening) — seam fixed, converged, flip held

- **The seam fix** (commit `fca8222`, "capture: land blobs and
  receipts through the artifact store seam"). `Files` gains
  `putBytes` / `putFile` / `size` over the store (with a no-store
  fallback that reproduces the old local behavior), and the local
  store's `putFile` streams instead of buffering whole blobs.
  `ingestAudioFile` (Audio.ts) and `HttpIngest.ts` now land blobs
  through the seam, so blob, provenance, and receipt live in the
  same store; `archiveCapture` sizes files through the seam
  (`Files.size`, store head) and its bucket uploads stream local
  bytes or pull through the store when the blob is bucket-only
  (`putArtifactToBucket`). The Media.ts audit found the same
  disease in chunk landing, manifest-chunk upload, settle markers,
  and transcript checks — all routed through the seam; receipt and
  marker existence checks in LocalTranscripts / DeviceEvents /
  TransloaditNormalize likewise. `CapturePolicy.ts`'s direct fs
  use is its own server-local token registry, not a store path —
  left alone deliberately. Regression tests ingest against an
  in-memory non-local store and assert blob + provenance + receipt
  land together with nothing on local disk. Suite: 348 pass / 1
  fail (the same pre-existing failure as the 346/1 baseline);
  typecheck clean. Deployed and verified healthy on the LOCAL
  store first (capture passes clean, fresh segment ingested via
  the fixed path, zero error lines).
- **Converge** (explicit-key sweeps in the first run's pattern;
  the repo tool's per-key Durable Object cost makes a full re-run
  ~4 h): round 1 — 2,777 keys scanned, 1,606 uploaded
  (201,165,702 bytes), 1,171 already OK, 0 failures; round 2 —
  2,885 scanned, 111 uploaded, 2,773 OK, 1 transient failure
  (retried clean in a 134-key touch-up: 0 uploaded, 0 failures).
  Every sampled hash mismatch was the same benign class, verified
  by direct comparison: a provenance/receipt written during the
  first flipped window and rewritten by the post-rollback
  re-ingest — identical facts, differing only in a timestamp, same
  size. Nothing deleted anywhere.
- **A second seam the copy exposed** (commit `fcfa631`):
  `bucket-audio` lists the archive bucket and mapped everything
  outside `capture/ archive/ media/ normalize/` to a recording.
  Safe while the bucket held only drops; since the copy it holds
  the whole artifact namespace, and the source began ingesting
  its own run reports and receipts as captures. Its discovery is
  now a positive filter over the bucket's real drop zones
  (`gps/inbox/`, plus root-level files other than the store's
  `places.json`). The junk captures created between the copy and
  this fix are inert (non-media, no transcripts) and were left in
  place — nothing was deleted.
- **Flip**: `ARTIFACT_STORE=bucket` appended to `.env` at
  2026-10-28T21:33:31Z (fresh backup
  `/home/exedev/env-pre-m3-reflip.bak`), one controlled restart
  (MainPID 976736); a second restart at ~21:47Z deployed `fcfa631`
  (MainPID 977269) with the flip continuously in effect. Rollback
  was not needed and the backup is retained.
- **Verification (~60 minutes of flipped operation)**: capture
  passes cycle against the bucket and write their reports into
  it (394 pass reports by 22:13Z; recent passes all sources
  empty/healthy, 0 failures). The split signature
  (`FileSystem.stat … NotFound`) occurred **0 times** since the
  flip. Fresh captures verified whole in the bucket — blob,
  provenance, and receipt for the same capture id: the 16
  GPS-inbox captures of the 21:12–21:14Z batch, audio segment
  `20261028T214500Z` (ingested 22:00:12Z through the fixed
  `ingestAudioFile` path), and a live `POST /in` (200 at
  21:43:07Z) through the fixed HttpIngest path. Archive receipts
  exist in the bucket for flipped-window captures (2,253 total).
  `GET /` returns 200 (110 s cold under the DayIndex tax, 0.03 s
  warm); `GET /status` 200. No mass re-submission to providers:
  receipts migrated with the store, and the first flipped main
  pass reproduced the local store's behavior exactly (including
  its two pre-existing Transloadit chunk-validation failures,
  captures `414fe3fa` / `4b380c0a`, unchanged). One transient AWS
  SDK `UnknownError` from R2 failed a single pipeline run at
  22:24Z; every loop kept cycling and it did not recur in the
  window.
- **Known limitations after the re-flip**: (1) Device-events
  ingest throttles under burst: every `location.fix` rewrites
  the same per-device latest-location object, which R2 rate-
  limits (`ServiceUnavailable: Reduce your concurrent request
  rate`) when a backlog lands at once. 26 event files failed in
  bursts at 21:51–21:55Z, retried on later passes, and the
  backlog drained fully by ~22:03Z — no data loss (source
  objects are immutable, receipts only on success), but the
  latest-location write wants serializing or debouncing.
  (2) `Media.ts` `blobPathFor` still only returns a path for
  blobs readable on local disk (by design, so a remote-only blob
  never gets a cached failed probe): while flipped, a brand-new
  capture's local probing/transcoding waits — pre-existing
  captures with cached probe records transcribe normally via
  signed R2 URLs. Follow-up: probe via presigned URL or bounded
  materialization. **Closed Oct 30 — see "Fresh-capture probing
  fix" below.**

### Fresh-capture probing fix (Oct 30) — limitation (2) closed

- **Design** (commit `04675ca`): a `blobAccessFor` resolver in
  `Media.ts` gives probing and the local transcode fallback a
  readable input wherever the blob lives. On local disk, the
  plain path — behavior unchanged. Store-only and ≤ 512 MiB:
  materialized through the store seam (new `Files.getFile`) into
  a `tmp/probe-<id>-<ts>/` scratch file, removed after use; the
  download is byte-exact, so the ffprobe verdict caches forever
  exactly like a local probe. Store-only and larger: probed in
  place through a presigned R2 URL (1 h TTL), and the record
  caches only on probe success — a failed URL probe may have
  failed on the fetch rather than the bytes, so the capture
  waits and retries instead of caching a wrong verdict.
  `normalizeCapture` consumes the same resolution. Settle /
  dead-letter semantics and the receipt guards are untouched;
  nothing syncs the store back to local disk wholesale.
- **Tests**: `lib/capture/MediaProbeRemote.test.ts` — 4 tests
  (remote probe + store-side caching + scratch cleanup,
  non-media probe, remote normalize, and a recorder-shaped
  capture end to end through normalize + transcribe against an
  in-memory store with vendor fakes, asserting no duplicate
  submission). Suite 352 pass / 1 fail — the baseline 348/1 plus
  the 4 new tests; the one failure is the same pre-existing
  `currentDayIndex` failure. Typecheck clean.
- **Deployed** 2026-10-30T03:25:39Z (bundle-courier, build, one
  controlled restart; `ARTIFACT_STORE=bucket` unchanged).
- **Backlog, counted pre-deploy** (03:23Z; method: every capture
  whose provenance's earliest `fetchedAt` is at/after the
  re-flip instant 2026-10-28T21:33:31Z and whose provenance
  mime/filename looked like media): **200 captures — 0 probed,
  0 manifested, 0 transcribed.** Probing reclassified the
  cohort: 114 of the 200 are GPS ndjson batches (bucket-audio
  labels them `audio/application`; verdict media=false, nothing
  to transcribe by design), so the true media backlog was 86.
- **Drain** (same 200, by 05:05Z): probed 200/200; manifested
  86/86 media; AssemblyAI job receipts 86/86; canonical
  transcripts 85/86 — the last, `a664ddd0`, was delayed by the
  index wobble below, then probed/manifested/submitted and
  awaits its next poll. Segments recorded during the window
  flowed through the same path (the proof segment below is one).
- **End-to-end proof**: segment `20261030T033000Z` (recorded
  03:30Z, after the deploy; bucket-only blob) → capture
  `6ec3fe368b96a1c35f226dc2866cdc408c3810b57ae1c2663b4c83eb25aa8ac5`:
  probe record 03:50:30Z (media=true), direct-path manifest
  03:50:31Z (899.4 s), AssemblyAI job
  `801eb9bb-5529-410f-82b5-cfc9f210d169` submitted 04:09:50Z,
  canonical transcript at
  `transcript/assemblyai-u35p-v1/6ec3fe368b96….json` completed
  04:55:31Z. That segment is silent (empty text); other drained
  captures carry real speech (e.g. 562 chars / 4 utterances).
- **Error census**, first ~100 min post-restart: split
  signature (`FileSystem.stat` … NotFound) 0; "no blob on disk"
  0; panics 0. The two pre-existing Transloadit validation
  failures (`414fe3fa`, `4b380c0a`) recurred identically in both
  passes — unchanged. One 1-second index-500 burst at 03:49:39Z
  failed 3 normalize items (`09525b61`, `09e62ef5`, `a664ddd0`);
  all recovered on the next pass (two are GPS; `a664ddd0` is
  the in-flight transcript above). The Oct 29 02:20Z index-500
  pair (`ec6521e3…`, `1425f78e…` — both GPS captures) likewise
  recovered: probe records written 03:50:17/23Z, and the
  post-fix pass's sources all reported healthy. **Residual
  risk, unchanged by this fix:** `media-normalize` discovery
  still depends on per-capture index lists, so a stage-level
  index failure degrades the whole stage for that pass (as in
  the pre-fix 02:39Z pass) — hardening that is a separate
  follow-up.

## 4.3 Milestone 4 — move the app (in progress, Oct 30)

§3 phases 3–6. Scott's go (Oct 29) with the scope limit: **this
affects medina-dev only** — Graze, Immich, and everything else on
exe.dev stay untouched. The transcription fix (§4.2) is landed, so
fresh captures flow end to end on the bucket store before any stage
moves.

### Live inventory (from the code and the host's environment, Oct 30)

Loops on medina-dev (one bun process, `ARTIFACT_STORE=bucket`):

| Loop | Cadence | Contents |
| --- | --- | --- |
| `ingest` | 1 min (passes run long) | Sources: `audio-drive`, `drive-allow`, `notes-git`, `bucket-audio`. Stages: `archive` → `media-normalize` (Transloadit) → `media-transcribe` (AssemblyAI) → `gps-compact` → `gps-stays`. Resources: `attribution`, `day-index`, `transcript-search`, `movement`, `notes` (LLM), `journal` (LLM, Effect Cluster workflows), `stars`. |
| `capture` | 1 min | Sources only: `local-transcripts`, `device-events`, `capture-bucket` (all read `sco-lifelog-in` via the read-only SourceBucket API). |
| `inventory` | 1 h | `drive-inventory` (metadata-only Drive crawl; nothing downstream reads it in real time). |
| star detector | 90 s | Re-scans recent transcripts for spoken "star …" commands; retention sweep. |

HTTP surface: journal SPA (`/` + `/app.js`, data via `POST /rpc`),
`/journal/:day`, `/movement/:day`, `/gps/:day`, `/api/days/:day/gps`,
`/stays/:day`, `/stars/:day`, `/star/:id`, `/location`, `/status`,
`/events` (SSE), the auth/delegation routes, `POST /in`, the
capture-policy routes, `/bucket-capture/:name`, `/devices`.

### The provider-access finding (changes the shape of every stage move)

medina-dev holds almost no raw provider keys. Its `.env` points the
provider clients at **exe.dev internal proxy hosts**: AssemblyAI via
`assemblyai.int.exe.xyz`, the journal LLM via `openai.int.exe.xyz`
(OpenAI-compatible; the key never leaves the proxy), and Google via a
token broker at `googlesa-*.int.exe.xyz` (`GOOGLE_TOKEN_URL`). Only
Transloadit has raw keys in the server environment. Those
`int.exe.xyz` hosts are exe.dev-platform internals — a Worker cannot
use them — so **every provider stage's move includes re-homing its
credential**, exactly Scott's direction: the key lands in the
Cloudflare Secrets Store (account `default_secrets_store`) under the
name the code already reads, attached to the Worker out-of-band, and
the client points at the provider's public endpoint. Creating those
secrets is Scott's action (values never transit the repo, the stack,
or this plan). Needed, by stage:

| Stage | Secrets Store entries to create | Endpoint change |
| --- | --- | --- |
| `media-transcribe` | `ASSEMBLYAI_API_KEY` — created by Scott Nov 2 ✓; bound to the Worker Nov 3 out-of-band against the existing store secret (Alchemy would reconcile-overwrite the stored value if declared; `scripts/reattach-secrets.ts` keeps the binding across deploys) and verified live from the Worker (transcript list, HTTP 200). The stage still needs the shared `ARTIFACTS_S3` keypair to presign chunk URLs — see §4.3 step 6. | `ASSEMBLYAI_API_URL` → `https://api.assemblyai.com` |
| `media-normalize` | `TRANSLOADIT_API_KEY` only — created by Scott Nov 2 (scoped key "cloudflare": assemblies read+write). `TRANSLOADIT_AUTH_SECRET` NOT needed: the workspace has Signature Authentication "Not required", verified Nov 2 by an unsigned create+status test from medina-dev (assembly completed). The Worker port authenticates key-only. Bound to the Worker Nov 3 the same out-of-band way as AssemblyAI and verified live from the Worker (empty test assembly completed). The stage also needs the `ARTIFACTS_S3` keypair for presigning/minting — still open, see §4.3 step 6. | none (public API today) |
| `notes` + `journal` (LLM) | the OpenAI provider key, stored in the **AI Gateway** config (Scott sets it once in the dashboard; Worker code never holds it). Decided Nov 2 (Scott): skip the custom Meta Model API integration; route the journal LLM through **Cloudflare AI Gateway** to the same model used today, `gpt-5.5` (Workers AI proper is Cloudflare-hosted open-weight models only — not a proxy — and does not carry it). `META_MODEL_API_KEY` stays hskping's, unused by Medina. | `JOURNAL_LLM_API_URL` → the AI Gateway's OpenAI-compatible endpoint for the account gateway |
| Drive sources + `inventory` | DONE Nov 2 (Scott): new dedicated service account `medina-drive-reader@medina-492522.iam.gserviceaccount.com` (no project roles; access via folder sharing); `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` in the Secrets Store. One folder shared so far — at cutover, parity-check what the new account sees (listAll) against what the broker credential sees, and flag any gap. | `GOOGLE_TOKEN_URL` broker replaced by Worker-side token exchange |
| capture-loop ingest (Worker writes) | `INDEX_API_TOKEN` (Medina-internal machine token) | none — `MEDINA_INDEX_URL` is already the public medina-index Worker |

Checked Oct 30: the store today holds only hskping's secrets plus
`META_MODEL_API_KEY` and Alchemy's state keys — **no Medina provider
secret exists yet**, so every provider stage is gated on Scott
creating the entries above. Stages that need no secrets (serving)
move first; nothing below blocks on anything else.

A second gate for every Worker *write* stage: new artifacts must be
registered in the medina-index DO, or medina-dev's bucket-store
listings cannot see them (the milestone-3 seam lesson). Until the
index is absorbed into this stack (a later move — its data is the
full artifact census), Worker writes go through the existing index
HTTP API with the token above.

### Cutover order (safest first; one submitter at every moment)

1. **Journal serving (reads)** — this pass. No provider contact, no
   writes; medina-dev keeps producing everything. Design below.
2. **Capture loop** (`capture-bucket`, `device-events`,
   `local-transcripts`) — ingest-only, receipt-guarded; the shadow
   already proves discovery parity. The device-events hardening
   (below) is built into the Worker version by construction: a pass
   writes the per-device latest-location object once, from the
   newest fix in the batch, instead of once per event. Cutover =
   Worker starts writing receipts; medina-dev's capture loop is
   disabled in the same change batch (its sources are individually
   excludable via `MEDINA_SOURCES`).
3. **Star detector** — reads transcripts, writes star records; rides
   the capture cron (60 s for 90 s is fine, idempotent).
4. **Archive sweep** — bucket-to-bucket, no provider; index
   registration is its only gate.
5. **`media-normalize`** (Transloadit) — submit-then-poll; handover
   per §3 phase 3: medina-dev stops submitting (stage flag), the
   Worker polls existing job receipts first, submits only where no
   receipt exists. The index-failure hardening (below) lands in the
   Worker version: per-capture list failures degrade that capture,
   never the whole pass.
   **Status Nov 3, 2026: built, deployed in shadow
   (`NORMALIZE_MODE`), rehearsed. The vendor key is bound to the
   Worker and verified live from it (below); the takeover itself
   is waiting only on the stage's R2 keypair (`ARTIFACTS_S3`).** The port
   (`cloudflare/src/normalize.ts`) mirrors lib's
   TransloaditNormalize: stored probe records stay authoritative;
   captures medina-dev never probed get a Worker-side container
   derivation (MP4/WAV/MP3/FLAC/Ogg-Opus headers by bounded range
   reads, cached in the stage's own notebook — never written back
   as ffprobe records). Probe agreement in rehearsal: the
   Worker's derivations matched medina-dev's ffprobe records on
   **791 of 791** captures checked across three census slices
   (800 captures total; zero disagreements). Two apparent
   disagreements early in the rehearsal were classification bugs
   in the rehearsal itself, both the same lesson as step 4's:
   stored artifacts from earlier pipeline generations (direct
   manifests from before the direct path existed; chunk grids
   from the 3,600 s segment era — the segment length is 14,400 s
   today) — medina-dev keeps an existing manifest as-is, so the
   shadow now judges stored manifests on the invariant the system
   itself holds (chunks present, sequential, contiguous coverage),
   while the strict grid stays enforced at creation. End-to-end
   chain proof (Nov 3, driven from medina-dev with the shipped
   builders because the Worker's own credential bindings are not
   attached yet): one real Transloadit assembly for a 3,961.856 s
   capture already normalized in production — presigned import →
   split → `/s3/store` with minted prefix-scoped credentials →
   the shipped manifest builder produced exactly the manifest
   medina-dev's current code plans (one chunk, [0, 3961.856]);
   the production manifest differs only by era (two chunks on the
   old 3,600 s grid). Paid usage for the proof: one completed
   assembly (a second may have been created by a rehearsal run
   whose connection died during target selection; it stored
   nothing). R2 access design note: the Worker presigns and mints
   temporary credentials locally (Cloudflare's documented HS256
   JWT mint) over a bucket-scoped S3 keypair — but see the
   credential gap below. One deliberate improvement over lib: a
   completed receipt whose manifest is missing gets its manifest
   rebuilt from the chunk listing instead of looping forever.
6. **`media-transcribe`** (AssemblyAI) — same handover shape, after
   normalize (its inputs are normalize's outputs).
   **Status Nov 3, 2026: built, deployed in shadow
   (`TRANSCRIBE_MODE`), rehearsed. The vendor key is bound to the
   Worker and verified live from it (below); the takeover itself
   is waiting only on the shared R2 keypair (`ARTIFACTS_S3`) the
   stage presigns chunk URLs with.** The port
   (`cloudflare/src/transcribe.ts`) calls `api.assemblyai.com`
   directly (the exe.dev proxy retires with this stage), keeps
   lib's durable jobs receipt (committed after every accepted
   job, so a second submitter can never re-buy a job), and
   produces byte-identical vendor/canonical/settled artifacts.
   Rehearsal: **500 manifests diffed across two slices — zero
   disagreements** (every manifest accounted for as done,
   in-flight, or settled, with receipt contents matching the
   manifest they belong to). End-to-end proof (Nov 3, driven from
   medina-dev through the key-injecting proxy because the
   Worker's own key binding is not attached yet): exactly **one**
   paid submission — a 899.6 s already-transcribed capture,
   presigned with the shipped code — and the resulting text
   matched the canonical transcript **byte for byte**. Live-mode
   pacing deliberately differs from the server's: 8 items per
   cron tick (the server's own concurrency bound, spread over
   minutes) instead of one warm hour-long pass.

   **The credential gap, and what Nov 3 settled.** In plain
   words: the two vendor keys are now attached to the Worker and
   proven working from it; the one thing still missing is a
   storage keypair for the bucket, which only Scott can create —
   until it exists, both stages keep rehearsing and the old
   server keeps doing both jobs. The detail:

   *Vendor keys — RESOLVED Nov 3.* Scott confirmed the stored
   keys by voice and said "flip it live". Alchemy's Secrets
   Store Secret resource reconciles the stored value FROM the
   deploy environment, so declaring either key would overwrite
   the value Scott placed in the store (the values are write-only
   — nobody can read them back to reconcile to); and Alchemy
   beta.83 has no binding-only declaration against a pre-existing
   store secret (`ReadSecret` still requires a Secret resource).
   So the keys are attached OUT-OF-BAND as `secrets_store_secret`
   bindings naming the existing store secrets — the hskping
   pattern — and `cloudflare/scripts/reattach-secrets.ts`
   re-attaches and asserts them as the second half of every
   `bun run deploy:dev` (a deploy strips undeclared bindings;
   the strip-and-restore cycle was exercised twice on Nov 3).
   Both keys were then verified live FROM the Worker through the
   new gated `GET /transcribe/verify` and `GET /normalize/verify`
   endpoints: the AssemblyAI key lists transcripts (HTTP 200);
   the Transloadit key creates and reads back an empty test
   assembly (ASSEMBLY_COMPLETED — the key-only handshake; the
   assemblies list endpoint demands a signature this workspace
   doesn't otherwise use, so it can't serve as the check).
   Scott's scoped Transloadit key works as placed.

   *The R2 keypair — still open, and it gates BOTH stages.*
   Both stages' working paths need `ARTIFACTS_S3`: normalize
   presigns the import URL and mints Transloadit's store
   credentials from it; transcribe presigns chunk URLs for
   AssemblyAI from it. The stack-minted form
   (`Cloudflare.R2.S3Credentials`) failed its deploy — the deploy
   credential cannot create account API tokens. The fallback —
   reuse a keypair medina-dev already holds — was inventoried
   Nov 3 and does not exist: the server's sco-lifelog access is
   edge-injected (endpoint `sco-lifelog.int.exe.xyz`, no keypair
   in its environment at all), and the one raw S3 keypair on the
   box (`SOURCE_BUCKET_*`, the capture source credential) is
   scoped to sco-lifelog-in only — an in-place probe from
   medina-dev got AccessDenied on sco-lifelog list and write.
   Flipping either mode to live without the keypair would make
   the Worker the sole submitter while unable to submit, so both
   modes stay `shadow` and medina-dev keeps both stages
   (`MEDINA_SOURCES` unchanged). Unblocks, either one (Scott):
   (a) create a bucket-scoped R2 API token for sco-lifelog and
   place its keypair in the Secrets Store — it is then declared
   in `alchemy.run.ts` like the index token and both stages flip
   the same day; or (b) grant the deploy credential API-token
   administration, after which the `S3Credentials` declaration
   returns as-is. The flip-day batch per stage, once the keypair
   lands: declare `ARTIFACTS_S3` → deploy (reattach runs) →
   proof one capture end to end → mode to `live` + the server's
   stage token removed from `MEDINA_SOURCES` + restart → watch
   real traffic. Rollback per stage is unchanged: mode back to
   shadow + the server token restored + restart.

   **Steps 5–6 FLIPPED LIVE Nov 6, 2026.** Scott took unblock
   (a): a bucket-scoped R2 API token for sco-lifelog (Account
   API, Object Read & Write), its keypair placed in the Secrets
   Store as `ARTIFACTS_S3_ACCESS_KEY_ID` /
   `ARTIFACTS_S3_SECRET_ACCESS_KEY`. The pair is attached
   out-of-band by `scripts/reattach-secrets.ts` like the vendor
   keys (a declared Secret resource would reconcile the stored
   value from the deploy environment), and `resolveArtifactsS3`
   in `src/worker.ts` composes the two store values into the
   `ARTIFACTS_S3` JSON the stages parse — no value transits a
   deploy or a log. Proofs before the flip, all from the Worker
   with its own bindings: both `/verify` endpoints green (vendor
   keys authenticate; a presigned GET against sco-lifelog
   returned HTTP 206); a normalize proof on a Nov 4 capture
   wrote its direct manifest under `normalize-proof/` with
   derivations agreeing; a transcribe proof submitted one paid
   AssemblyAI job and completed — its text differed from the
   canonical transcript in two spots (one word heard
   differently, one short phrase dropped), the vendor's own
   run-to-run variance on identical audio, not a pipeline
   difference. Flip batch, same day: modes to `live` + deploy;
   medina-dev's `MEDINA_SOURCES` dropped `normalize,transcribe`
   (backup `.env.bak-2026-11-06-steps56`) + restart. First live
   cron reports: transcribe checked 8 / completed 8, no errors;
   normalize checked 200 with 193/193 derivations agreeing and
   exactly one error — a legacy 2022-02-17 capture whose
   Transloadit chunks failed validation under medina-dev in
   September (receipt dated 2026-09-16, two prior assemblies);
   the stage declines to re-fire it, by design. Rollback
   unchanged.
7. **`gps-compact` / `gps-stays`** — pure derivations, but the points
   store is Parquet partitions; a Worker-side Parquet writer is a
   design item of its own, so these sit late deliberately.
8. **Resources** (`attribution`, `day-index`, `transcript-search`,
   `movement`) — the §2 incremental-DO redesign; the largest single
   work item (§5). The day-index *snapshot artifacts* the pipeline
   already writes are what the serving pass reads meanwhile.
9. **`notes` + `journal`** (LLM) — Cloudflare Workflows port of the
   cluster workflows; needs the LLM credential row above.
10. **Drive sources + `inventory`** — needs the Google credential
    row above.
11. **`POST /in`** — moves with the Access milestone (service tokens
    replace the tailnet-identity trust, per the addendum).
12. **Write surface** (`SavePlaces`, `/devices`, token admin) — stays
    on medina-dev until Access; the MCP bridge and CLI repoint at
    the read cutover (phase 5) without it.

Retirement (§3 phase 6) is last and conditional: medina-dev stops
only when every row above is verified on Cloudflare. Until then it
is the fallback and keeps running.

### Serving design (step 1, this pass)

- **Data**: reads only, all from the `ARTIFACTS` binding. The days
  list is the server's own persisted snapshot `views/days-v6.json`
  (the exact payload `ListDays` serves — the server refreshes it on
  a 10-min stale-while-revalidate cycle and after every pass, so
  the Worker inherits server-computed staleness with minutes of
  lag). Day pages resolve like `Views.currentJournals`' on-disk
  rule: list `journal/journal-v12/<day>/`, newest by `generatedAt`.
  `GetDayTranscripts` reads the newest day-index snapshot artifact
  (`index/days-v1/`, chosen by `builtAt` among the most recently
  uploaded) plus that day's transcript artifacts — bounded per-day
  reads; **the corpus is never re-decoded**, so the DayIndex tax is
  not recreated. `/status` is composed from the loops' run-report
  artifacts (`runs/…/latest.json`), the journal listing, and the
  day-index snapshot; process-local fields medina-dev fills from
  memory (`running`, `nextRunAt`) are reported as null/false by the
  Worker and marked as such.
- **Surface**: `GET /` (the SPA shell, markup ported from
  `Pages.tsx`), `GET /app.js`, `GET /inter.woff2`, the app-icon
  routes, `GET /journal/:day` (HTML + JSON, same selection rule),
  `GET /status`, and `POST /rpc` for the read RPCs the SPA needs —
  `ListDays`, `ListJournals`, `GetJournal`, `GetDayTranscripts`,
  `GetStatus` — via the repo's own `JournalsGroup` schemas
  (`lib/lifelog/JournalApi.ts`, imported with the bundler's `effect`
  alias pinned to this package's effect 4.0.5 so one copy ships).
  Not yet moved, answering a typed `ApiError` instead of drifting:
  `SearchTranscripts` (needs the search index), the places RPCs,
  `SavePlaces` (a write), `StreamEvents` (no live hub on the Worker
  yet). `/devices` is not served (its token-issuing APIs stay on
  medina-dev).
- **Client assets**: `/app.js` and the font/icons are build outputs,
  not artifacts the pipeline writes. A new repo script
  (`scripts/publish-client-assets.ts`, run on medina-dev where the
  build and the bucket credentials live) publishes them under
  `client/` keys in `sco-lifelog`; the Worker streams them from the
  binding. Content is unversioned for the transition (the server's
  own cache headers are mirrored); a hashed-asset scheme can come
  with the domain cutover.
- **Gate**: Access cannot apply to workers.dev (addendum), and the
  journal is private — so until the custom domain exists, every
  journal route sits behind the existing per-device capability
  token (the same registry the policy route verifies). A token
  presented once at `/?token=…` is exchanged for an HttpOnly cookie
  so the stock SPA (which knows nothing of tokens) works unchanged;
  `/rpc` also accepts the Bearer header. Fail-closed: no token, no
  journal — the routes 404 like the other gated routes.
- **Parity**: verified against medina-dev over the same artifacts —
  `ListDays` payload equality, sampled `/journal/:day` report-text
  equality, `GetDayTranscripts` turn equality for a sampled day,
  `/status` totals and last-run equality — using a dedicated,
  revocable check token, revoked when the pass ends.

### Step 1 result (Oct 30) — journal serving DONE

The Worker now serves the journal (shell, day pages, `/status`,
and the read RPCs) from the bucket with content parity against
medina-dev. Two defects had to be found and fixed first; both are
recorded here because they are exactly the failure shapes this
migration keeps producing.

- **Two-effect-copies bundle (the RPC defect).** As first built,
  `ListDays`/`ListJournals`/`GetStatus`/`GetDayTranscripts`
  answered every request with an RPC `Failure [Die]` while
  `GetJournal` worked. Root cause: the bundle silently contained
  **two copies of effect** — the lib modules' `effect` imports
  resolved to the repo-root install (4.0.0) while the Worker's own
  code used this package's 4.0.5 — because the pinning plugin had
  been passed as `build.input.plugins`, a slot Alchemy does not
  consume (it was ignored without a word). A 4.0.0 `DayRow`
  encodes as a defect through the 4.0.5 JSON codec (its Number
  fields demand `"Infinity" | "NaN"` literals); `Journal` has no
  Number fields, which is why `GetJournal` alone survived. Fix:
  the documented mechanism, `build.input.resolve.alias`
  (`{ "effect$": <dist>/index.js, effect: <dist> }`). Verified in
  the bundle's source map: 124 sources, zero root-copy effect
  modules (the earlier "single copy" reading of the analyzer
  output was wrong — its relative paths hid the second tree).
- **Selection and page-state parity.** The first read model
  picked each day's journal by R2 upload order — wrong twice
  over: the milestone-3 converge pass re-uploaded generations in
  key order (68 of 116 reports mismatched), and the server's
  day page / `GetJournal` follow `journalCachedForDay`, under
  which a stale day has *no* servable journal (RPC null, page
  202 pending). The read model now picks newest by the journal's
  own `generatedAt` (the `currentJournals` rule; every candidate
  is fetched, only the winner decoded), takes the stale signal
  from the server's own persisted snapshot, and mirrors the
  pending/empty-journal/cache-header shapes exactly. The page
  renderers were also re-ported byte-faithfully from the current
  `Pages.tsx` (the first port had drifted to an older design).
- **Parity evidence** (final harness run, 19 checks, dedicated
  token minted and revoked in-run): **17 pass** — `ListDays`
  full + window (116 rows, payload-equal), `ListJournals`
  reports 116/116 with 0 mismatches and 0 stale-flag mismatches,
  `GetJournal` on a stale day (both null), a settled recent day,
  and a 2021 day, `GetDayTranscripts` turn equality (523 turns;
  and 0/0), `ListPlaces`, shell **byte-identical** (18,527 B,
  same sha), a settled day page byte-identical in HTML and JSON,
  `/app.js` and the font byte-equal, gate fail-closed (anonymous
  and revoked-token 404s). **2 fail, one root cause, accepted
  divergence:** `GetStatus` totals. The server computes totals
  over `journalCachedInstances` against its *current day-index
  window* (stable at 8 days / 179 transcripts during these runs)
  using per-day instance keys derived from live movement/note
  basis hashes — not reproducible from bucket artifacts. The
  Worker's totals are corpus-wide over the server-persisted
  snapshot (116 days / 1,768 transcripts); the `lastRun` window
  matches to the millisecond in both checks. Unifying this is
  part of the step-8 resource redesign (§2), where status is
  recomputed incrementally rather than derived per request.
- **Cost note**: the `generatedAt` scan reads every journal
  candidate (~2,500 objects) once per read-model build (60 s
  isolate cache). Correctness first; the §2 index retires it.
  (Serving no longer pays this on requests — see the latency fix
  below; the scan now runs only in the background snapshot
  builder.)

### Step 1 latency fix (Oct 30) — persisted read-model snapshot

Step 1 verified content, never latency, and the defect shipped:
the read model was rebuilt from the bucket *per request* whenever
an isolate's 60 s memo was cold or expired — the ~2,500-object
journal scan plus the day-index decode, paid synchronously by
whichever request arrived first. Scott hit it in the browser the
same day (the SPA's `ListDays` never landed; "Could not load the
journal"). Measured from the sandbox against the live Worker
before the fix: `ListDays` (limit 40) **82.5 s and 83.0 s**,
`GetStatus` **94.5 s** — every hit, warm or cold, paid the build.

Fix, mirroring the server's own answer (process memo + persisted
snapshot, stale-while-revalidate): the gather and the decode are
split, and the *expensive* gathered inputs — the journal
selection and the day-index selection — are persisted as one
bucket artifact, **`views/worker-read-model-v1.json`** (~0.98 MB),
with a fingerprint of the journal + day-index listings in its R2
custom metadata. The minutely Cron Trigger (the milestone-2
handler) recomputes the fingerprint from listings only and
rebuilds the snapshot in the background only when it moves (a
rebuild measured ~50 s, entirely off the request path). Requests
decode the expensive half from the snapshot and read the cheap
artifacts (previews rows, the three run reports) fresh — four
small GETs — memoized 60 s per isolate as before; a live gather
remains only as the fallback for a missing/corrupt snapshot
(which also persists its result, so the next cold isolate starts
from the snapshot). A token-gated `POST /journal/refresh` runs
the same refresh synchronously for ops and seeding.
**First-cut flaw, caught and fixed the same day:** the original
fingerprint also covered the run reports and the previews
snapshot, which the pipeline rewrites every pass — two refresh
checks 65 s apart both rebuilt (distinct fingerprints, ~65 s per
rebuild), i.e. the scan would have re-run near-constantly in the
background. Serving latency was never affected (the previous
snapshot serves during a rebuild), but the churn defeated the
design; narrowing the fingerprint to the expensive inputs'
listings and reading the cheap artifacts fresh at load fixed
it — the +65 s check after the fix answers `rebuilt: false` on
a stable fingerprint.

After the fix, same vantage: `ListDays` limit 40 **1.4 s /
1.2 s**, and **1.2 s** on a hit after the isolate memo expired;
full window (116 rows) **1.2 s**; `GetStatus` **0.9 s**;
`ListJournals` **1.6 s**. Full browser-equivalent flow: token
exchange 302 in 0.9 s → shell 200 in 0.8 s → `/app.js` 200 in
1.6 s → `ListDays` (cookie) 1.1 s → `GetStatus` (cookie) 1.1 s;
anonymous `/rpc` still 404. Parity re-verified against
medina-dev (dedicated check token, minted and revoked through
the server's own endpoint): `ListDays` 116 rows payload-equal,
`ListJournals` **116/116 with 0 mismatches and 0 stale-flag
mismatches**, the settled day page (2026-10-28, HTML)
**byte-identical** (sha256 `0e0f84f9…`), and the SPA shell
byte-identical to the server's own capture. The accepted
`GetStatus`-totals divergence is untouched. (Re-measured after
the fingerprint fix: `ListDays` 1.1 s, `GetStatus` 0.9 s,
`ListJournals` 2.2 s, the day page still byte-identical.) Cron
liveness: the shadow's run count advanced across a 75 s
observation window — the refresh rides the same scheduled
handler — and the post-fix refresh check answered
`rebuilt: false` on a stable fingerprint. Freshness contract: a corpus change lands in serving
within a cron tick plus one background rebuild, the same order
as the server's own 10-minute previews cycle.

What remains of milestone 4, in the recorded order: capture loop
(flipped to the Worker Nov 2, next sections),
star detector, archive, media-normalize and media-transcribe
(their provider secrets landed in the Secrets Store Nov 2),
gps stages, the resource-layer redesign, notes +
journal generation, Drive sources, `/in`, the write surface, and
finally phone cutover + medina-dev retirement. medina-dev remains
the serving fallback and the sole pipeline runner until each
stage's cutover is proven.

### Step 2 shadow (Nov 2) — capture loop ported, parity proven, not flipped

The capture loop now exists on the Worker as a shadow
(`cloudflare/src/capture.ts`), built Effect-natively per Scott's
Nov 2 direction: the server's domain vocabulary on top (classify,
receipt identity, artifact keys, payload validation — ported check
for check from lib/capture/*), Effect services underneath (the
source bucket and artifact bucket as R2 bindings, the medina-index
HTTP API as a service, a `CaptureShadow` Durable Object as the
notebook). Each pass *plans* every item in its window — the receipt
that guards it, the artifact keys ingest writes, the index keys it
registers — and diffs the plan against medina-dev's receipts,
artifacts, and index rows. The Cron Trigger rides the existing
minutely cron with a trailing 75-minute window; `POST /capture/run`
and `GET /capture/status` (device-token gate) run and read it on
demand.

- **INDEX_API_TOKEN**: declared in the stack as a Secrets Store
  `Secret` resource bound to the Worker (nothing out-of-band). The
  value is the existing token medina-dev and medina-index already
  share — medina-index's own mechanism (its Worker secret) needed
  no change — supplied to the deploy through the environment as a
  Redacted; `alchemy.run.ts` throws if it is absent, so a deploy
  can never reconcile the secret to an empty value. The deploy
  created the entry in `default_secrets_store`; the binding
  authenticates against medina-index live (every pass's index
  probe answers 200). **Housekeeping caveat:** Alchemy persists
  the Redacted value in its local stack state
  (`.alchemy/state/Medina/dev/IndexApiToken.json`) — that file
  must not be committed as-is; how stack state is treated
  (gitignore vs encrypted remote state) is an open item.
- **Device-events hardening, by construction**: the plan reduces
  a batch's fixes to one latest-location write per device — the
  newest fix by the event's own timestamp, ties by sequence —
  instead of the server's write-per-event that R2 rate-limited in
  the Oct 28 burst. The shadow diffs that reduction against the
  believed position medina-dev currently holds.
- **Parity evidence** (check token minted for the run and revoked
  after): the trailing 8 h window — 41/41 items matched
  (capture-bucket 25, device-events 15, local-transcripts 1), the
  shadow's newest fix identical to medina-dev's believed position;
  the Oct 28 burst window (21:45–22:15Z) — 69/69 matched,
  including all 63 burst device-events (receipted after their
  retries, as §4.2 recorded; no loss), the latest-location verdict
  `dev-newer`, which is correct for a historical window; the last
  active evening window — 7/7 matched, latest-location match.
  Every receipt in every window (117 item checks) was found under
  the **etag** version derivation, none needed the lastModified
  fallback: the R2 binding's etag and the server's S3 etag agree,
  so receipt identity ports exactly. Cron passes record their
  reports in the notebook continuously.
- **Not flipped.** medina-dev remains the sole live pipeline.
  The cutover itself is unchanged from the step-2 row above:
  the Worker starts performing the plans (bucket writes +
  `/register` calls, already implemented in the index service)
  and medina-dev's capture loop is excluded via `MEDINA_SOURCES`
  in the same change batch. Steps 3–4 were assessed as riders and
  rejected: the star detector works a different surface
  (canonical transcripts, star records, a retention sweep) and
  the archive sweep performs bucket-to-bucket moves — neither is
  a small extension of this shadow; both stay sequenced steps.

### Step 2 cutover (Nov 2) — capture loop flipped to the Worker

Flipped Nov 2, 2026 (evening PT) under Scott's standing cutover
authorization. The performing pass is a mode of the same loop
(commit e69dad2): `CAPTURE_LOOP_MODE` in `alchemy.run.ts` —
`"live"` performs, anything else is shadow (the rollback
position). Per item the Worker writes artifacts first and the
receipt last, through the ArtifactStore seam semantics (bucket
write, then index registration; a failed registration fails the
write); every write is idempotent (content-addressed blobs,
append-guarded provenance, upsert registrations), so a crash
before the receipt simply re-performs on the next pass.

- **Switch order: medina-dev stands down first, then the Worker
  goes live.** `/register` is an upsert keyed by key (verified in
  the medina-index implementation), so an overlap would have
  been harmless — but the plan's rule is one submitter at every
  moment, and the minutes between the two halves are a pure gap
  of unreceipted uploads, which the receipt-driven loop drains
  on its first live pass. Server half: `MEDINA_SOURCES` set to
  `audio,notes,bucket,inventory,allow` in medina-dev's `.env`
  (backup `.env.bak-2026-11-02-step2`), restart at 02:57:55Z —
  clean boot, listening 02:58:00Z, non-capture sources
  unaffected. Worker half: `CAPTURE_LOOP_MODE: "live"` (commit
  598e981), deployed 03:01Z.
- **Post-flip verification.** First manual live pass over 24 h:
  60 items in window, all already receipted, 0 errors — the gap
  drained trivially because the phone was in a capture lull
  (last real upload 01:02Z, before either half of the flip).
  Because no natural traffic was arriving, performing was proven
  with a synthetic device-event probe uploaded to
  `sco-lifelog-in`: the Worker's live pass performed it
  (device-events performed 1, errors none), the same run's shadow
  diff verified it matched (classified 2, matched 2, 0
  mismatches), its receipt was confirmed in the index (newest
  device-events receipt, version = the probe's etag) and read
  back from the bucket with the probe's event id; the following
  cron tick (03:06:23Z) independently reported it matched.
  Probe, receipt, and index row were then removed. medina-dev
  logged zero capture-source activity and zero errors after the
  restart; `GET /status` on the Worker answered ready and
  `https://sco.medina.stream/health` 200. Cron passes since the
  flip: no mismatches, no errors. Check token minted for the
  cutover was revoked after (gate re-verified 404).
- **Rollback position**: set `CAPTURE_LOOP_MODE` back to
  `"shadow"` and redeploy; remove the `MEDINA_SOURCES` line (or
  restore the `.env` backup) and restart medina-dev. The
  server's discovery indexes go stale during the flip but stay
  valid — receipt state is rechecked against the actual receipt
  listing each pass.
- **Residual risk**: two overlapping Worker cron passes could
  interleave the latest-location read→write so an older fix
  lands last; the phone emits fixes continually, so the next
  fix's pass corrects it (the server's per-event writes were
  strictly worse). The shadow diff's `stale` verdict is the
  detection net. Natural-traffic proof (a real segment performed
  end-to-end by the Worker) lands with the phone's next active
  window; the probe proved the perform path, and every
  unreceipted real item will be performed by the same code path
  inside its 24 h live scan window.

### Step 3 (Nov 2) — star detector: shadow parity, then flipped

Built and flipped Nov 2, 2026 (evening PT) under Scott's standing
cutover authorization. The port is `cloudflare/src/stars.ts`: the
detector's grammar, rescan window (current and previous UTC days),
deterministic command ids, born-expired guard, and the retention
sweep with its content-free forget receipts are carried over check
for check from `lib/lifelog/StarDetector.ts` — no grammar change
(that stays Scott's separate open decision). The one platform
substitution: the server rebuilds the day index fresh from the
corpus every 90 s, while the Worker reads the newest persisted
day-index snapshot (`index/days-v1/`, the journal serving pass's
selection), riding the capture cron's minute. Server stand-down
needed a mechanism the detector didn't have — it was an
unconditional loop, not a `MEDINA_SOURCES` source — so the server
gained two excludable stage tokens, `stars` and `archive`, both in
the default source set (an unset deployment is unchanged; commit
86aac2c, deployed to medina-dev ahead of either flip with both
stages still server-run).

- **Shadow evidence.** The Worker's passes read the same window
  medina-dev's detector files from: 32 transcripts across the two
  UTC days, and found **no commands** — no voice-star traffic
  exists (the live census is 9 authored records, all
  `createdVia: "api"` voiceprint clips with effectively infinite
  retention, none near expiry), so filings, sweeps, and mismatches
  were all zero across manual and cron passes, with the parser
  itself covered by the server's own test vectors carried into
  `src/stars.test.ts`. The first live pass did catch a real bug in
  the port: the catalog lists by raw string prefix, so listing
  `star` also pulled in `stars/stars-v1/` day-view artifacts and
  failed decoding one as a record — the authored records live flat
  in `star/`; fixed by applying the directory boundary (commit
  a29ef7e) before any parity claim was made.
- **Switch order, as in step 2**: medina-dev stands down first
  (`MEDINA_SOURCES` without `stars`, backup
  `.env.bak-2026-11-03-step3`, restart 03:48Z, clean boot), then
  the Worker goes live (`STAR_DETECTOR_MODE: "live"`, commit
  05bce4f, deployed 03:49Z). Post-flip: a manual live pass ran the
  perform path and the diff together — filed 0, swept 0, no
  failure, no mismatches; cron passes since are clean and
  `https://sco.medina.stream/health` stays 200.
- **Rollback position**: `STAR_DETECTOR_MODE` back to `"shadow"`
  and redeploy; restore `stars` in medina-dev's `MEDINA_SOURCES`
  (or the `.env` backup) and restart. Filing ids are
  deterministic, so even an overlap could not double-file.
- **Residual risk**: the snapshot the Worker reads is refreshed
  by medina-dev's ingest passes until the day-index resource
  itself moves (step 8); voice stars live one hour from utterance
  end, so snapshot lag eats filing life — every report carries
  the snapshot's `builtAt`, making the lag visible rather than
  silent. The perform path's live proof on a real "star …"
  command lands with the first one Scott speaks; until then the
  plan diff plus the carried-over test vectors are the evidence.

### Step 4 (Nov 2) — archive sweep: shadow parity, then flipped

Built and flipped Nov 2, 2026 (evening PT), same authorization.
The port is `cloudflare/src/archive.ts`: `archiveCapture`'s
decisions carried over one for one — carry a receipt entry whose
size still matches the listing, head-verify a file whose size
moved or that has no entry, upload only what the archive bucket
cannot confirm, rewrite the receipt exactly when the server's
would rewrite (never for ghost entries alone — entries for
vanished files drop only on a rewrite, the server's quirk,
ported). The gate is the step-3 server change: the sweep was an
unconditional pipeline stage and is now excludable via the
`archive` token.

- **Shadow evidence**: a full-census diff over **all 2,923
  captures** — 2,922 settled matches plus one capture still
  settling inside the grace window, which matched on recheck;
  zero mismatches, zero ghost entries, zero uploads needed, zero
  errors. The zero-upload result is structural: medina-dev's
  archive bucket *is* the Worker's artifacts bucket
  (`BUCKET_NAME=sco-lifelog`, `ARTIFACT_STORE=bucket`), so every
  file settles by head check — the same reason the server's sweep
  copies nothing today.
- **Switch order**: medina-dev stands down first
  (`MEDINA_SOURCES` without `archive`, backup
  `.env.bak-2026-11-03-step4`, restart 03:50Z, clean boot), then
  the Worker goes live (`ARCHIVE_SWEEP_MODE: "live"`, commit
  10e2382, deployed 03:51Z). Performing was proven on natural
  traffic within minutes: 11 new captures arrived after the
  census (the phone active again), and the Worker's first live
  pass wrote **6 archive receipts itself** (0 copies — head-settled,
  as designed); the next cron pass reported the census fully
  settled, **2,934 captures / 2,934 receipts**, its verification
  slice matched, no errors. Live ordering is the server's safety
  order: copies first (each verified by the put's returned etag),
  the receipt last — an interrupted pass leaves at worst a
  receipt the next pass re-derives.
- **Rollback position**: `ARCHIVE_SWEEP_MODE` back to `"shadow"`
  and redeploy; restore `archive` in medina-dev's
  `MEDINA_SOURCES` (or the `.env` backup) and restart.
- **Residual risk**: the byte-copy path stays unexercised while
  the buckets stay aligned — a file larger than 128 MB that ever
  diverged would fail its item and retry rather than buffer in
  the Worker, which is the deliberate guard, not a silent skip.

### Journal stall (Oct 28 – Nov 6) — root cause found and fixed Nov 6

No journals were written after Oct 28, so the site's day list ended
at Oct 28 while capture, normalize, transcribe, and the day-index
all kept working. Diagnosis (Nov 6, from the server's own logs and
both stores' contents): the journal/notes **workflow executions ran
without the ArtifactStore service in context**. Files.* routes
through the in-context store and silently falls back to the plain
local filesystem when none is present; workflow executions run with
the context captured by their own layer (`WorkflowsLive` in
example-lifelog/main.ts), which provided only the LLM layer. So
from the Oct 28 `ARTIFACT_STORE=bucket` flip onward, executions
read the frozen local store on Archil (the pre-flip corpus) and
wrote their journals there: days after Oct 28 do not exist in that
store (every execution logged "0 transcripts" and finished in
seconds), and re-journals of older days landed where the bucket-side
pipeline never looks, so every affected day stayed stale forever
and the pass ground through the backlog (~4–8 min per day plus
full-corpus view recomputes) without ever converging. Proof: the
local store's journal directories carry mtimes matching the
execution log minute-for-minute, while the bucket holds no journal
artifacts after Oct 28. Fix: `WorkflowsLive` now also provides
`ArtifactStore.layerFromConfig` (commit pending below). The
general lesson for the remaining steps: any execution context that
isn't the main server's (workflows, one-shot tools, the Worker
port) must be checked for store provision — the fallback is silent
by design. Relatedly, the journal stage's move to the Worker
(step 9) removes this server-side split entirely.

### Access + domain (staged, one open decision)

Everything not needing the domain is prepared by the serving pass
(the gate above is the pre-Access placeholder, shaped to be deleted
when Access asserts identity). **Open decision (Scott): the custom
domain** for the Access application and the Worker's human-facing
routes. Nothing is bought or attached without it. Phone routes stay
outside Access regardless; `/in`'s service-token story waits for
the same milestone.

## 5. Risks and open questions

- **Workers CPU limits vs derivations.** Paid Workers allow 30 s CPU
  per request (5 min on Cron/Queue consumers with the right plan
  settings) — fine for per-capture work, but the *shape* matters: the
  old code's habit of corpus-wide derivations (day index, transcript
  search, attribution over 2,187 instances) cannot be ported as-is even
  ignoring CPU, because they assume a filesystem and minutes of wall
  time. The DO-incremental design (§2) is the answer, but it is a
  redesign of the resource layer, not a port. Largest single work item.
- **Long media through Workers.** Transloadit already works on signed
  R2 URLs, so normalize never streams bytes through Medina — good.
  Anything that *does* touch bytes (ffprobe-style timing probes,
  `lib/Mp4.ts` parsing) must be checked for streaming/chunked reads;
  multi-hundred-MB archive files cannot be buffered in a 128 MB
  isolate. Open question: which code paths read whole objects today?
- **Transloadit/AssemblyAI polling shape.** Workflows fit, but
  AssemblyAI job lifetimes (hours for archive files) mean Workflow
  instances live long; confirm Workflow retention/limits against the
  backlog profile before committing the design (fallback: Queue +
  DO-held job receipts, i.e. today's pattern with DO receipts).
- **Cron granularity.** Cloudflare cron's finest grain is 1 minute.
  The 90-second star detector becomes 60 s (fine). Nothing else is
  sub-minute.
- **The adopted bucket.** The stack binds `sco-lifelog` via an adopted
  `R2.Bucket` resource so the name resolves — the stack must never be
  destroyed against it. The bucket predates the stack and outlives it;
  the plan treats Alchemy state for the bucket as a binding convenience,
  not ownership.
- **Pre-existing `medina*` Workers.** The account already has workers
  named `medina`, `medina-main`, `medina-new`, `medina-container` of
  unknown provenance (not this stack, not medina-index). Nothing in
  this plan touches them; the scaffold deliberately uses an
  Alchemy-derived stage-scoped name. Somebody should identify them
  before a future stage claims the bare `medina` name.
- **Auth.** The journal's OAuth-flavored delegation scheme and the
  Tailscale-header trust on medina-dev (`/in` posts arrive with
  tailnet identity headers) do not transfer literally: there is no
  tailnet in front of a Worker. `/in` needs its own credential story
  (the posting apps are Scott's; a per-client token is the obvious
  shape) and the auth scheme needs a deliberate port, not a copy.
- **Drive credentials.** The Drive sources use a token endpoint
  (`GOOGLE_TOKEN_URL`) shaped for the VM; the Worker version needs the
  OAuth refresh flow re-homed into Secrets Store + Worker code.
- **Cost shape.** Per-request pricing favors this workload (bursty,
  small), but the Queue/Workflow volume during the transcription
  backlog drain should be estimated before phase 3, from the Oct 19
  drain numbers (~$5.52/day steady-state provider spend is separate
  and unchanged).

## Addendum (Oct 27, 2026): auth direction — Cloudflare Access

Scott has decided the auth answer for the human-facing surfaces,
resolving the §5 Auth open question: **Cloudflare Access (Zero
Trust)** is the analogue of the exe.dev login gate and the Tailscale
identity headers — it, not a port of the server-side scheme, is what
stands in front of the Worker.

- **Browser surfaces** (the journal UI, `/status`, and the other
  auth-gated pages) sit behind a Cloudflare Access application on a
  **real (custom) domain**, with Scott's identity provider as the
  login. Access supplies the identity; the Worker trusts the Access
  assertion the way the bun server trusts the tailnet headers today.
- **The phone's token routes stay outside Access.**
  `/api/capture-policy/*` and `/bucket-capture/*` are not part of the
  Access application and keep their existing per-device capability
  token auth — the app has no browser and no IdP login, and its
  contract does not change.
- **Machine posters to `/in`** authenticate with **Access service
  tokens** (the non-interactive Access credential), replacing the
  tailnet-identity trust those posts rely on today.
- **Access does not apply to workers.dev URLs.** The gated surface
  therefore needs a custom domain attached at the milestone that
  moves the browser UI — until then, the workers.dev deployment
  remains a token-routes-and-proofs surface only.

Direction only in this addendum: no Access application, domain, or
service token is created by the shadow-ingest milestone, and the
shadow scope is unchanged.
