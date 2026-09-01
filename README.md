# Medina, Effect edition

A single Node process, built on [Effect v4 (RC)](https://effect.website/), that
turns Google Drive voice recordings into a daily journal:

```text
hourly pass → list latest N Drive files → transcribe new audio (AssemblyAI) → journal each day (LLM) → GET /
```

The Effect v4 sources are cloned alongside this repo at `../effect` for API
reference (the RC differs from both v3 and the published docs in places).

## Layout

Generic library code lives in `lib/`; the lifelog application — the specific
effects strung together for this data — lives in `example-lifelog/`.

**`lib/` — reusable services (each a `Context.Service` + `Layer`):**

- [`lib/Artifacts.ts`](./lib/Artifacts.ts) — keyed JSON store on the local filesystem (the role R2 used to play).
- [`lib/Drive.ts`](./lib/Drive.ts) — Google Drive list/download via the exe.dev service-account token mint.
- [`lib/AssemblyAI.ts`](./lib/AssemblyAI.ts) — upload + transcript job + poll-until-settled.

**`example-lifelog/` — the application:**

- [`example-lifelog/Domain.ts`](./example-lifelog/Domain.ts) — artifact schemas (`Transcript`, `Journal`) and capture-time rules. The JSON shapes match the previous Cloudflare implementation exactly, so artifacts carry over; keys keep their old shapes (`transcript/assemblyai-u35p-v1/…`, `journal/journal-v4/…`).
- [`example-lifelog/Pipeline.ts`](./example-lifelog/Pipeline.ts) — the pass itself: transcribe files that lack a transcript artifact, then journal days whose input set changed. Journal text comes from Effect's `LanguageModel` (`@effect/ai-openai`), with a guard that a reasoning-only response with no final text fails the run.
- [`example-lifelog/main.ts`](./example-lifelog/main.ts) — layers wired together: Drive, AssemblyAI, the OpenAI-backed `LanguageModel`, and the artifact store; an HTTP server for `GET /` and `GET /status` plus an hourly scheduled pipeline fiber.

## State model

Artifacts under `data/artifacts/` are the only state; everything else is
derived. Idempotence is by key existence:

- A transcript keyed by ingest id (source + Drive file id + md5) exists ⇒ the
  audio is never re-downloaded or re-transcribed.
- A journal keyed by day + SHA-256 of its input transcript keys exists ⇒ the
  LLM is not re-run. A new transcript landing on a day changes the hash and
  produces a revised journal.

The `data/artifacts` tree was exported from the previous branch's local R2
bucket (transcripts, triage, journals — not the 10 GB of raw audio), so this
branch reuses all prior transcription and journaling work as-is. Old
transcripts without a `capturedAt` recover it from their `triage/<id>.json`
artifact.

Days are the day a recording was *made*, taken from the source filename's
`YYYYMMDDThhmmss` stamp, with Drive modified time as fallback.

## Running

```bash
npm install
npm run dev    # or: npm start
```

Configuration comes from `.env` (see `.env.example`): Drive token mint URL and
folder id, AssemblyAI and LLM endpoints (exe.dev integrations inject
credentials at the network edge, so no keys live here), `SOURCE_LATEST` for the
latest-N window, and `PORT`.
