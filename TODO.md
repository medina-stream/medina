# TODO

## Next: timezone phase 5 — day-ID contract cleanup (docs/timezones.md)

Phases 1–4 are done: gps-hours carry per-point IANA zones, GPS days and
transcript days assemble by local civil date, the app renders from
gps.json with per-segment zones. What remains is making the rest of the
system honest about the semantic split between UTC intervals and local
civil days:

- **Separate the two day concepts in code**: `parseIntervalId` still means
  UTC-midnight intervals and is used by both kinds of consumers. Introduce
  an explicit local-day helper (e.g. `parseDayId` beside
  `localDateFromDayId` in lib/timezone.ts) and migrate GPS/transcript day
  resources onto it, leaving interval.ts strictly UTC.
- **`/:intervalId.json` semantics**: intervals.ts still computes
  coverageSeconds by UTC-window overlap from chunk-prefix scans, so the day
  screen's "5.8h audio" is UTC-day coverage next to local-day content.
  Decide: local-day overlap (widened prefix scan + per-chunk zone, like
  transcripts) or keep UTC and label it. Then rebuild month/year rollups
  from day resources instead of prefix scans.
- **Audit remaining UTC-day assumptions**: expo dates.ts
  (dateFromDayId/getLastDayIds label days in UTC), journal/index screens,
  bin/medina-cli day helpers ("yesterday"), docs/API.md day-route wording.
- **gps.json first-request latency**: ~16s cold because runResource replans
  52 hour objects; serve the materialized object directly when fresh
  (HEAD-style fingerprint check) and replan only when stale.
- **Device-reported zones**: ingest metadata `timezone` is defined in the
  plan as the highest-precedence source but nothing writes or reads it yet;
  wire recorder/uploader metadata through ingest classification into
  resolveChunkTimeZone.

## Planned

- **Image resources + generic resource mounting** — declarative
  `resources/app-icon.ts` (prompt or inline SVG + output list),
  `lib/image.ts` with @resvg/resvg-js, and `mountResource(app, def, {prefix})`
  so one line exposes a resource's outputs over HTTP.
- **Google Drive connection in the app** — server-owned OAuth (plain fetch,
  no googleapis), refresh token in bucket, `resources/gdrive.ts` sync
  resource, Connections UI in Expo app; retires scripts/sync-gdrive* and the
  VM systemd timer.

## Nix / devenv

- **Finish devenv + flake setup** — `.envrc` + `devenv.nix` scaffolded but direnv
  integration not yet verified. Next: confirm `direnv allow` works, then define a
  proper Nix flake (`flake.nix`) so the dev environment is fully reproducible and
  lockable. Consider dropping `ffmpeg-static`/`ffprobe-static` npm deps in favour
  of nixpkgs ffmpeg.

## Cleanup continuation (from the 2026-07 cleanup pass)

- **Runtime-agnostic resources/**: resources/ still use Bun.spawn/Bun.file/
  Bun.$/Bun.Glob (recordings, transcripts, speech-analysis, podcast). Add a
  tiny lib/exec.ts (spawn + collect output) and node:fs equivalents so
  resources never touch runtime APIs directly. lib/ is already Bun-free except
  bucket-bun.ts (intentional adapter) and db.ts/event.ts (bun:sqlite;
  event.ts already injects db — swap to node:sqlite when Bun resolves it).
- **server/adapters/bun/**: flatten — three tiny files (app-ui, cli, sdk
  bundle-on-demand) that could live in server/ directly.
- **bin/ contracts**: keep bin/medina-cli.ts (HTTP client, served at
  /medina-cli.ts) and bin/admin (read-only bucket inspection) separate; add a
  header comment to each stating its contract.
- **README as tutorial**: rewrite around the story "raw bytes in → resource
  derived → slice served"; prune docs/ to what's true; make docs/API.md match
  routes exactly.
- **Guardrails**: a test that fails on unimported modules / unused deps so
  bloat can't silently return.
- **STT swappability**: transcription (resources/transcripts.ts) calls the
  Deepgram REST API directly (DEEPGRAM_API_KEY/MODEL/BASE_URL). If another
  provider is ever needed, introduce a provider interface returning
  { text, utterances[] } — but only when a second provider is real.

## Speaker identification (2026-07-21 state and next steps)

Pipeline: chunk → silero VAD gate (speech-analysis) → Deepgram diarized
transcription → ECAPA embeddings per diarized cluster (speaker-embeddings)
→ cosine match vs enrolled centroids → per-utterance provenance
(me / to-me / ambient). Config: MEDINA_SELF_SPEAKER_ID,
SPEAKER_MATCH_THRESHOLD (0.4), TRANSCRIPT_MAX_AGE_DAYS (4),
TRANSCRIPT_CONVERSATION_WINDOW_SECONDS (30).

- **Enrollment is the current bottleneck**: speaker 1 has one webm sample
  (browser mic, June 26). Against real lifelog chunks, best similarities ran
  0.28–0.33 — below threshold, so nothing labels as "me" yet. Unclear how
  much is genuinely-not-me vs domain mismatch (mic/codec/distance).
- **Labeling UI**: playback UI for finding/labeling "this is me" segments in
  real chunks; confirmed segments should be added as speaker samples
  (centroid auto-rebuilds when the sample set changes — signature check in
  resources/speaker-embeddings.ts).
- **Threshold calibration**: once a few ground-truth me-segments exist,
  measure the similarity distribution (self vs others) and set
  SPEAKER_MATCH_THRESHOLD from data instead of the 0.4 guess.
- **Backfill**: after enrollment improves, bump the speaker-id portion of the
  transcript version (or add re-scoring that reuses stored utterances
  without re-paying Deepgram — utterance spans are already in the transcript
  JSON, so re-embedding chunk audio locally is enough).
- **to-me refinement**: current rule is "other speaker within a 30s window of
  my speech"; could use turn-taking cadence and overlap instead.
- **App**: transcripts UI doesn't render provenance/speaker info yet; day
  rollups include utterances but the app only shows flat text. A default
  filter to me/to-me with an "include ambient" toggle is the intended UX.

## Backlog (unchanged)

- transform runtime: sandboxes with medina cli/bucket/gws installed; "run
  script" tool with explicit runtime selection
- job/queue-less method for generating probes etc
- full ci: test and deploy on push (hosted deploy, app update, migrate, local)
- generate hooks from hono-rpc
- dynamic manifest
- logtape?
- cors
- powerful events
- exclusions
- policies
- themes / "design tokens"
- presigned direct-to-S3 ingest uploads for large files
- if durable jobs/workers become necessary, see git history:
  lib/s3-job-queue.ts skeleton and old SQLite job queue around 1032b7f / 409e173
