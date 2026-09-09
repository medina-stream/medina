# Plan: Transloadit offload for media normalization

Status: all external dependencies verified live (2026-09-09, conversation
"assess-branch-divergence"). This file is the implementation brief; nothing
here is speculative — every integration claim below was probed end-to-end.

## Where this fits

The media pipeline (see `lib/capture/Media.ts`) is: capture (uninterpreted
bytes + provenance) → archive (blob → bucket, runs first) → **media-normalize**
(probe via lossless ffprobe.json beside blob; transcode anything with an
audio stream — audio or video — to canonical mono 16k Opus, 1-hour chunks +
manifest) → media-transcribe (chunks → one merged Transcript) → attribution
→ journal. After normalize, original blobs are never read again.

Today normalize runs local ffmpeg, concurrency 1, on a 2-vCPU VM. The
imminent workload is a 16-file / 35 GB backfill of 2021 WAVs (1.4–3 GB
each) already visible in the Drive inventory (`AudioRec Recordings` folder),
plus one video/mp4 — video counts as media, picture dropped at transcode.
Offloading the heavy decode/encode to Transloadit makes the backfill
parallel and cheap for the VM: the vendor emits ONE canonical opus per
capture (their /audio/encode is one-output-per-input; their segmented
outputs are HLS/DASH-shaped, wrong for us), and the VM finishes with a
cheap local `-c copy` segmentation of the ~10–100 MB opus. The VM never
reads a WAV.

## Security model (verified working — do not weaken)

- The archive bucket credential is edge-injected (`sco-lifelog.int.exe.xyz`);
  it signs nothing external and never leaves the VM.
- Per job, mint short-lived scoped creds via the Cloudflare API
  (`https://cloudflare.int.exe.xyz/client/v4/accounts/{R2_ACCOUNT_ID}/r2/temp-access-credentials`,
  edge-injected token, now has Workers R2 Storage: Edit):
  - read cred: `permission: object-read-only`, `objects: [<the one blob key>]`
  - write cred: `permission: object-read-write`, `prefixes: [media/<v>/<captureId>/]`
  - `parentAccessKeyId` = `R2_PARENT_ACCESS_KEY_ID` from .env (key ID only,
    not secret; parent is the `sco-lifelog-readwrite` R2 token)
  - ttlSeconds ~7200. Scope enforcement was probe-verified: granted object
    reads, AccessDenied elsewhere; granted prefix writes, AccessDenied outside.
- The VENDOR NEVER WRITES THE MANIFEST. We poll, we `head`-verify chunk
  bytes with our own edge creds, we write `media/<v>/<captureId>.json`
  ourselves. Manifest-written-last is both the crash-safety and the
  vendor-trust invariant.

## Transloadit specifics (all probe-verified)

- Auth: `TRANSLOADIT_API_KEY` in .env, no signature required. Account
  upgraded from demo (demo clipped audio to 5s — that cost an hour of
  debugging; sizes now come back exact).
- **`/s3/import` does NOT work with R2** (SignatureDoesNotMatch — their SDK
  vs R2 SigV4 incompatibility, tried host/no_vhost/bucket_region/session
  token permutations). **Use `/http/import` with a presigned GET URL**
  instead — sign locally with the minted read cred (aws4fetch `signQuery`,
  or the SDK presigner; both verified. Minted creds CAN presign — they
  include a secret; the edge-injected ones cannot).
- `/s3/store` DOES work with R2: params `bucket`, `bucket_region: "auto"`
  (required — omitting it causes a ListObjects permission probe that fails),
  `host: https://<acct>.r2.cloudflarestorage.com`, `no_vhost: true`, `key`,
  `secret`, `session_token` (temp creds), `path: media/<v>/<captureId>/canonical.ogg`.
- Encode step (exact verified params):
  `robot: /audio/encode, ffmpeg_stack: "v7", preset: "empty",
  ffmpeg: { "c:a": "libopus", "b:a": "24k", ar: 16000, ac: 1, f: "ogg", vn: true }`
  (`vn: ""` errors — must be `true`. `preset: "empty"` suppresses the mp3
  default.) Note: output reports 48000 sample rate — that is opus's internal
  rate, normal; `ar: 16000` still bounds the encoded band. Decide whether
  chunking after vendor encode keeps `MEDIA_VERSION=media-v1` (output is
  bit-different from local ffmpeg 6.1 but contract-identical) or bumps to
  media-v2 with vendor+stack+params folded into the version string.
  RECOMMENDATION: keep the version, treat encoder provenance as
  non-basis — transcripts don't care which encoder produced the chunk.
- Poll `assembly_ssl_url` from the create response; terminal when `ok` is
  not ASSEMBLY_UPLOADING/EXECUTING/REPLAYING. 78-min m4a executed in ~28s.
  Poll-only; no notify_url (loopback-bound server, by design).
- Errors seen in the wild: S3_IMPORT_ACCESS_DENIED (R2/s3-import, avoided),
  USER_COMMAND_ERROR (bad ffmpeg param), FILE_META_DATA_ERROR (their probe
  on weird bytes). Treat any terminal error as: log, count failed, re-fire
  next pass (new assembly, new creds).

## Implementation

1. `lib/R2TempCreds.ts` — EXISTS (written, uncommitted). Service with
   `mint(options)`. Add a `presignGet(key, ttl)` helper (aws4fetch is now a
   devDependency; move to dependencies) that mints a read cred and returns
   the signed URL. Config: `R2_ACCOUNT_ID`, `R2_PARENT_ACCESS_KEY_ID`
   (both in .env), `CLOUDFLARE_API_URL` default `https://cloudflare.int.exe.xyz`.
2. `lib/capture/TransloaditNormalize.ts` — the offload backend:
   - Receipt key: `normalize/transloadit/<captureId>.json` (schema: assemblyId,
     assemblySslUrl, createdAt, mediaVersion). Local-only coordination state,
     like ingest receipts; NOT archived, safe to lose (re-fires).
   - Flow per capture: manifest exists → done (cached). Receipt exists →
     poll; if completed → verify `media/<v>/<captureId>/canonical.ogg` in
     bucket via our own head → download opus → segment locally
     `ffmpeg -c copy -f segment -segment_time 3600 -reset_timestamps 1`
     → probe chunk durations (existing code path in Media.ts does exactly
     this) → write chunks + manifest → delete receipt (or keep as record).
     If failed/vanished → delete receipt, count failed (next pass re-fires).
     No receipt → blob in bucket? (archive stage runs first, so yes normally;
     if not, fall back to local or skip with failure) → mint + presign +
     create assembly → write receipt → return; completion is a later pass.
   - The blob's bucket key: `capture/<captureId>/<blobName>` — mirror of the
     local artifact key. blobName from `blobPathFor` (Media.ts).
3. Wire into `mediaNormalizeSource` (lib/capture/Media.ts): if TransloaditNormalize
   is configured (TRANSLOADIT_API_KEY + R2TempCreds.configured), use it;
   else local `normalizeCapture` (keep — offline fallback + tests).
   Since vendor flow spans passes, per-item outcomes map: fired → "ingested"
   (work happened), polled-still-running → "skipped", completed+chunked →
   "ingested", already-manifested → "cached".
4. Local `-c copy` segmentation helper: extract from `normalizeCapture` the
   segment+probe+manifest-write tail into a shared function
   `segmentToChunks(captureId, sourcePath)`, used by both local and vendor
   paths (vendor path feeds it the downloaded canonical.ogg; local path
   feeds the original blob through full re-encode as today). Note the
   canonical.ogg lands in the bucket under media/<v>/<captureId>/ — decide:
   keep it there (it's the durable normalized form; chunks become local
   derivations of it — ATTRACTIVE: bucket then holds capture + canonical,
   both permanent; chunks rebuildable by -c copy from canonical) or delete
   after chunking. RECOMMENDATION: keep canonical.ogg in bucket; do NOT
   archive local chunks (rebuildable in seconds).
5. Tests (`lib/capture/TransloaditNormalize.test.ts`): mock the Transloadit
   API + R2TempCreds with in-memory layers; real tests for receipt lifecycle,
   poll state machine, verify-before-manifest, re-fire on failure. The
   `-c copy` segmentation gets a real-ffmpeg test (pattern in Media.test.ts;
   note test-preload.ts gives each test process a temp DATA_DIR — keep the
   tmpdir guard assertion at the top like Archive.test.ts).
6. `.env.example`: document TRANSLOADIT_API_KEY, R2_ACCOUNT_ID,
   R2_PARENT_ACCESS_KEY_ID.

## Acceptance sequence (after implementation)

1. Restart medina-dev; existing captures all have manifests → stage reads cached.
2. Smoke: allowlist the 3gp from AudioRec (smallest, ~100 MB) in
   `/mnt/archil/medina/allow/drive.json`:
   `{ "files": [ { "id": "<3gp drive id>", "note": "2021 archive smoke" } ] }`
   (ids are in `/mnt/archil/medina/inventory/drive/latest.json`). Watch:
   drive-allow ingests → archive uploads → normalize fires assembly → next
   pass chunks + manifest. Transcription will then run (media-transcribe) —
   3gp is small, acceptable spend.
3. Backfill: allowlist all 16 AudioRec files. Ingest+archive is the slow
   part (Drive→VM→bucket, ~35 GB through the VM once, unavoidable).
   Normalize fans out on Transloadit. BEFORE letting media-transcribe eat
   16 files × ~2.5h of audio, decide the transcription-cost gate (maybe
   MEDINA_SOURCES-style stage toggle, or a transcribe allowlist — not
   designed yet; cheap option: temporarily disable the transcribe stage).

## Context that will bite you if forgotten

- `bun test` auto-loads .env; test-preload.ts redirects DATA_DIR to a tmpdir
  per process. Never remove that. Archive.test.ts shows the guard pattern.
- The bucket-audio SOURCE (recorder uploads, BUCKET_PREFIX) shares the
  archive bucket; discovery skips capture/ and archive/ prefixes — if you
  add new bucket top-level prefixes (media/, normalize/), the skip-list in
  example-lifelog/main.ts bucket-audio discovery may need media/ added
  (currently only filters capture/ and archive/ — CHECK THIS: canonical.ogg
  under media/ would be discovered as a "recording" by bucket-audio if
  BUCKET_PREFIX is empty. Either add media/ to the filter or set
  BUCKET_PREFIX).
- ffmpeg on VM is 6.1 (system), Transloadit stack pinned "v7". Both fine.
- The AWS SDK under Bun: node-stream bodies stall on slow sources, web
  streams fail hashing — Bucket.putFile uses positional-read multipart
  (8 MB parts). Don't regress this.
- example-lifelog/main.ts stage order: archiveSweepSource FIRST (blob must
  be in bucket before normalize fires the vendor), then mediaNormalizeSource,
  mediaTranscribeSource, gpsCompactSource, staysSource.
- Uncommitted right now: lib/R2TempCreds.ts (new) and aws4fetch in
  package.json devDeps. Commit them as the starting point.
