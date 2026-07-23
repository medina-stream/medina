# Configuration

Medina is configured with environment variables. Copy `.env.example` to `.env` for local development.

## Server

```env
HOST=127.0.0.1
PORT=3002
MEDINA_ROOT=http://127.0.0.1:3002
MEDINA_TOKEN=replace-with-a-long-random-secret
```

`MEDINA_ROOT` is the public URL/host expected by the default stream template. Requests for other hosts are rejected unless they are configured as aliases.
`MEDINA_TOKEN` authenticates the default user through Bearer, Basic, or `X-Medina-Token` authentication.

```bash
curl -u "default:$MEDINA_TOKEN" "$MEDINA_ROOT/status.json"
```

## Storage

The default stream template uses standard `S3_*` variables:

```env
S3_BUCKET=medina-dev
S3_ENDPOINT=http://127.0.0.1:3900
S3_REGION=garage
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_SESSION_TOKEN=...
S3_FORCE_PATH_STYLE=true
```

`S3_ENDPOINT` is optional for AWS S3, but required for local Garage, MinIO, and most other S3-compatible stores.

## Stream preferences

Stream preferences are stored in the bucket as JSON at `medina.conf`. On first startup Medina creates:

```json
{
  "name": "My Stream"
}
```

The stream name and future stream-level preferences belong in this object rather than environment variables.

## Streams

`medina.config.ts` is local deployment config and is gitignored. If it is missing, `bun scripts/ensure-streams-config.ts` copies `docs/streams-basic.ts` into place.

Set `MEDINA_STREAMS_TEMPLATE=docs/examples/streams.multitenant.ts` or another explicit template if you want to overwrite `medina.config.ts` from a template.

## App static export

`bun run dev` and production builds serve the committed Expo web export from `static/app/`. After UI changes under `expo/`, run:

```bash
npm run refresh:app-static
```

## Transcription and speaker identification

- `DEEPGRAM_API_KEY` — required for transcription; requests go straight to the Deepgram REST API with diarization enabled.
- `DEEPGRAM_MODEL` — default `nova-3`.
- `DEEPGRAM_BASE_URL` — default `https://api.deepgram.com`; override for testing.
- `TRANSCRIPT_MAX_AGE_DAYS` — skip transcribing chunks older than this (default 4, `0` disables the cutoff).
- `TRANSCRIPT_MIN_SPEECH_SECONDS` — VAD gate: minimum detected speech before a chunk is sent for transcription (default 1.5).
- `MEDINA_SELF_SPEAKER_ID` — enrolled speaker id treated as "me" for utterance provenance (me / to-me / ambient).
- `SPEAKER_MATCH_THRESHOLD` — cosine similarity required to match a diarized speaker to an enrolled voiceprint (default 0.4).
- `TRANSCRIPT_CONVERSATION_WINDOW_SECONDS` — window around my speech within which other speakers classify as to-me (default 30).

Speaker enrollment lives in the bucket under `speakers/<id>/`; audio samples are embedded (ECAPA, via `uv run`) into `speakers/<id>/centroid.embedding.json`, which rebuilds automatically when samples change.
