# Medina on Cloudflare: migration plan

Status: milestone 1 (plan + scaffold + policy-serving proof), Oct 27, 2026.
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
