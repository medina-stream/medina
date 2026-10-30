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
| `media-transcribe` | `ASSEMBLYAI_API_KEY` | `ASSEMBLYAI_API_URL` → `https://api.assemblyai.com` |
| `media-normalize` | `TRANSLOADIT_API_KEY`, `TRANSLOADIT_AUTH_SECRET` | none (public API today) |
| `notes` + `journal` (LLM) | the journal LLM's API key (name TBD with the endpoint) | `JOURNAL_LLM_API_URL` → the provider's public OpenAI-compatible endpoint; `META_MODEL_API_KEY` already exists in the store — whether it is this credential is Scott's to confirm |
| Drive sources + `inventory` | Google service-account material (shape TBD) | `GOOGLE_TOKEN_URL` broker replaced by Worker-side token exchange |
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
6. **`media-transcribe`** (AssemblyAI) — same handover shape, after
   normalize (its inputs are normalize's outputs).
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

What remains of milestone 4, in the recorded order: capture loop
(gated on an `INDEX_API_TOKEN` secret for index registration),
star detector, archive, media-normalize and media-transcribe
(gated on their provider secrets in the Secrets Store — none
exist yet), gps stages, the resource-layer redesign, notes +
journal generation, Drive sources, `/in`, the write surface, and
finally phone cutover + medina-dev retirement. medina-dev remains
the serving fallback and the sole pipeline runner until each
stage's cutover is proven.

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
