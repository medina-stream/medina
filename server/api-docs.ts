export function createApiDocs(baseUrl: string) {
  return `# Medina HTTP API

Medina is an HTTP/REST server for a personal context lake. It accepts raw ingests, materializes software-defined resources from bucket objects, and exposes the current resource graph as JSON, XML, audio, and browser-friendly static assets.

Base URL for this request: \`${baseUrl}\`

Agent onboarding: \`${baseUrl}/agents.md\`

## Access model

Public, no token required:

- \`GET /agents.md\` — canonical agent onboarding guide
- \`GET /api.md\` — this document
- \`GET /app\`, \`GET /app/*\` — Expo web app shell and assets
- \`GET /sdk.js\`, \`GET /sdk.d.ts\`, \`GET /sdk.ts\`, \`GET /medina-cli.ts\` — client code artifacts

Everything else is stream-protected according to \`medina.config.ts\`. Token-capable streams accept any of:

- \`Authorization: Bearer <token>\`
- \`Authorization: Basic :<token>\`
- \`X-Medina-Token: <token>\`
- \`?token=<token>\`

Tailscale-protected streams accept the proxy identity headers configured by Tailscale Serve.

## Discovery and health JSON

### \`GET /status.json\`

Returns service status for the selected stream. This endpoint is public, but reports the request-selected stream health when a stream can be selected.

\`200 application/json\`

\`\`\`json
{
  "ok": true,
  "message": "all systems go (streams-v1)",
  "hostname": "medina.example",
  "bucket_id": "s3://bucket@endpoint/auto",
  "bucket_accessible": true,
  "current_user": null
}
\`\`\`

### \`GET /agents.md\`

Returns the canonical agent onboarding guide. Legacy paths such as \`/skill.md\`, \`/skill\`, \`/agent\`, and \`/agent.md\` redirect here.

## Event JSON and WebSocket

### \`GET /events.json?limit=100\`

Returns recent in-process server/app events as JSON. \`limit\` is optional.

### \`POST /events\`

Accepts an application event JSON object, stores it in the event log, and broadcasts it to WebSocket clients.

\`\`\`http
POST /events
Content-Type: application/json

{"type":"ingest-uploaded","ingestId":"abc","filename":"voice.m4a","sizeBytes":12345}
\`\`\`

If \`type\` is \`ingest-uploaded\`, Medina schedules durable triage work for the uploaded object.

### \`GET /events\` with \`Upgrade: websocket\`

Streams live event JSON objects over WebSocket.

## Ingest HTTP API

### \`POST /in\`

Creates or stores an ingest.

With \`Content-Type: application/json\`, returns an upload destination without uploading bytes:

\`\`\`json
{
  "type": "audio/m4a",
  "metadata": {
    "original-filename": "voice.m4a",
    "recording-started-at": "2026-06-08T18:00:00.000Z"
  }
}
\`\`\`

Response includes \`ingestId\`, bucket \`key\`, and a direct or presigned upload form/action.

With any other content type, the request body is stored directly as a new ingest and the JSON response includes its key and metadata.

### \`PUT /in/:ingestId\`

Uploads raw ingest bytes for a caller-chosen ingest id. Response is JSON with \`ingestId\`, bucket \`key\`, and normalized metadata.

## Ingest sources

Sources are first-class pointers to where ingests come from. Each source has a config (stored at \`sources/<id>.json\`), operational status (at \`sources/<id>/status.json\`), and sync state per imported file (at \`sources/<id>/sync/<hash>.json\`). The ingest worker periodically syncs every enabled source; new/changed files become queued ingests automatically.

Built-in source types: \`filesystem\` (watches a local directory) and \`google-drive\` (OAuth + Drive folder). More (bucket, podcast feed) to follow.

### \`GET /sources.json\`

Returns all configured sources. Refresh tokens and other secrets are never included:

\`\`\`json
{ "sources": [{ "id": "...", "type": "google-drive", "enabled": true, "extensions": [".m4a"], "account": "you@gmail.com", "folderId": "...", "connectedAt": "...", "lastSyncAt": "...", "lastSyncSummary": { "queued": 2, "skipped": 0, "errors": 0, "finishedAt": "..." } }] }
\`\`\`

Legacy \`connections/google-drive.json\` is migrated into a source on first read.

Filesystem sources are configured by the instance operator in bucket storage or deployment tooling; the app displays their status but does not create them.

### \`GET /sources/:id.json\`

Returns a single public source config (same shape as the list entries). 404 when the id is unknown.

### \`PUT /sources/:id\`

Updates the editable fields of a Google Drive source (\`folderId\`, \`extensions\`, or \`enabled\`). Instance-managed source types are read-only over this API.

### \`DELETE /sources/:id\`

Removes the source config and its per-file sync state.

### \`POST /sources/:id/sync\`

Runs a sync pass for one source: lists the source's files and enqueues \`source-fetch\` work for each new or changed file. Listing is fast; the ingest worker downloads the queued files asynchronously. Returns \`{ sourceId, type, synced, summary }\` where \`summary.queued\` counts newly enqueued fetches. Returns \`502 { error: "sync_failed", message }\` when listing fails (e.g. an expired token); the failure is also recorded on the source as \`lastSyncError\`.

### \`POST /sources/sync\`

Runs a sync pass for every enabled source. Returns \`{ results: [...] }\`.

### \`GET /connect/google?sourceId=<id>&folderId=<id>\`

Stream-authenticated. Begins the Google OAuth consent flow with a CSRF \`state\`. With \`sourceId\`, reconnects an existing \`google-drive\` source (refreshing its stored token). With \`folderId\` (or no params), a new source is created on callback. Redirects (302) to Google. The redirect URI is derived from the request's public base, so a tailnet-only host works.

### \`GET /connect/google/callback?code=&state=\`

Google redirects here after consent. Exchanges the code for a refresh token, creates or updates the \`google-drive\` source config, and redirects to \`/app/sources/<id>?gdrive=connected\` (or \`/app/sources?gdrive=error&message=...\`).

## Current JSON resources

### \`GET /recordings.json\`

Lists materialized recording manifests. Recordings are software-defined resources derived from audio ingest analysis. Each recording points at chunk assets and metadata under \`recordings/<recording-id>/...\`.

### \`GET /intervals.json\`

Lists materialized interval resource references currently present in the bucket.

### \`GET /:intervalId.json\`

Returns a materialized interval JSON resource. Valid ids are:

- \`02026.json\` — year
- \`0202605.json\` — month
- \`020260515.json\` — day

If an interval is missing, the server materializes it on first request from current chunk/recording resources. Empty past or future intervals are still valid resources with zero coverage. Responses are \`application/json\` with \`cache-control: no-cache\`.

### \`GET /:intervalId.md\`

Returns a markdown summary for the same year/month/day interval ids. Missing intervals are materialized first; empty intervals return a short summary ending in \`No data.\`

### \`HEAD /:intervalId.json\`

Returns resource freshness metadata without a body:

- \`x-medina-resource-key\`
- \`x-medina-resource-exists\`
- \`x-medina-resource-fresh\`
- \`x-medina-resource-stale-reason\` when stale (\`degraded\` means the last materialization used a fallback and will be retried)
- \`x-medina-resource-degraded\` warning codes when the cached output was produced degraded
- \`x-medina-resource-error\` when planning fails

### \`GET /transcripts/<dayId>.json\`

Returns the materialized transcript array for a UTC day, e.g. \`GET /transcripts/020260515.json\`. This is the preferred app path: one deterministic bucket object read when available, or a fast 404 when day transcripts have not been generated yet.

### \`GET /transcripts.json?from=<iso>&to=<iso>\`

Lists materialized chunk transcript JSON resources, optionally filtered by interval overlap. This remains a compatibility/query endpoint; day views should prefer the direct day transcript resource above. Transcript resources are derived from already-materialized \`chunks/<chunk-id>/<recording-id>.ogg\` audio via the Deepgram API with diarization and speaker identification.

### \`GET /todos.json\`

Materializes and returns \`todos/list.json\`, a deterministic JSON list of to-do items extracted from transcript text.

### \`GET /speakers.json\`

Lists known speaker records stored under \`speakers/<id>/info.json\`, including sample metadata discovered from \`speakers/<id>/...\` audio objects.

### \`POST /speakers\`, \`PUT /speakers/:id\`, \`DELETE /speakers/:id\`

Creates, updates, or deletes bucket-backed speaker records. The create/update body is JSON with \`name\` and optional \`notes\`.

### \`POST /speakers/:id/samples\`

Uploads a raw voice sample object under \`speakers/<id>/<filename>\`. Pass \`?filename=sample.ogg\` to choose the object basename; the request content type is preserved.

### \`GET /speakers/:id/samples/:sampleName\`, \`DELETE /speakers/:id/samples/:sampleName\`

Fetches or deletes an individual voice sample object.

## XML and media resources

### \`GET /podcast.xml\`

Materializes and returns an RSS feed for recordings as \`application/rss+xml\`. The feed is a software-defined resource derived from recording manifests and podcast episode resources.

### \`GET /podcast/episodes/:file\`

Returns podcast episode audio from \`podcast/episodes/:file\` when materialized.

### \`GET /recordings/:id/:file\`

Returns a recording chunk asset from \`recordings/:id/:file\` with the stored audio content type.

### \`GET /recordings/:id/manifest/:file\`

Returns a legacy manifest-scoped recording chunk path from \`recordings/:id/manifest/:file\`.

## Software-defined resources in this server

Medina resources are deterministic materialization definitions. Each definition declares dependencies, outputs, a version, and a receipt. Re-running a resource can skip fresh outputs or refresh stale ones when dependencies or definitions change.

Currently wired resource definitions:

| Resource | Output shape | Materialized from | HTTP exposure |
| --- | --- | --- | --- |
| \`ingests\` v1 | ingest analysis JSON | raw \`in/...\` object + ingest request metadata | created by ingest/event pipeline; not directly listed yet |
| \`recordings\` v3 | recording manifest/meta JSON + recording chunks | ingest analysis + raw ingest audio | \`GET /recordings.json\`, \`GET /recordings/:id/:file\` |
| \`chunks\` v1 | time-windowed Ogg/Opus chunks | recording manifest + raw ingest audio | chunk assets feed transcripts/intervals; no direct top-level route yet |
| \`intervals\` v2 | year/month/day interval JSON | chunk windows and recording manifests | \`GET /intervals.json\`, \`GET /:intervalId.json\`, \`HEAD /:intervalId.json\` |
| \`transcript-chunks\` v5 | chunk transcript JSON | Ogg/Opus chunk audio + Deepgram diarized transcription + speaker embeddings | \`GET /transcripts/<dayId>.json\`, \`GET /transcripts.json\` |
| \`speech-analysis\` v1 | speech/silence analysis JSON | Ogg/Opus chunk audio + ffmpeg silencedetect | worker resource; not directly routed yet |
| \`todos\` v2 | to-do list JSON | transcript JSON resources | \`GET /todos.json\` |
| \`podcast-feed\` | RSS XML | recording manifests + podcast episode resources | \`GET /podcast.xml\` |
| \`podcast-episodes\` | Ogg audio episode files | recording chunks/manifests | \`GET /podcast/episodes/:file\` |

## SDK and CLI

The Hono app is the source of truth. \`/api.md\` documents the HTTP surface, \`/sdk.js\` mirrors that surface with typed Hono-client access plus humane defaults, and \`/medina-cli.ts\` is a Bun-runnable Unix wrapper over the SDK.

### SDK install/use

\`\`\`js
import { createMedinaClient } from "${baseUrl}/sdk.js";

const medina = createMedinaClient({
  baseUrl: "${baseUrl}",
  token: process.env.MEDINA_TOKEN,
});

console.log(await medina.getStatus());
console.log(await medina.getRecordings());
console.log(await medina.getInterval("020260515"));
\`\`\`

The SDK exports \`api\` for the Hono client shape and helpers for common HTTP routes: \`request()\`, \`json()\`, \`getStatus()\`, \`getEvents()\`, \`getRecordings()\`, \`getIntervals()\`, \`getInterval(id)\`, \`getTranscripts()\`, \`getTodos()\`, \`createIngestDestination()\`, \`uploadIngest()\`, \`notifyUploadFinished()\`, and \`connectEvents()\`.

### CLI install/use

\`\`\`sh
curl -fsSL ${baseUrl}/medina-cli.ts -o medina-cli.ts
chmod +x medina-cli.ts
MEDINA_ROOT=${baseUrl} MEDINA_TOKEN=your-token bun medina-cli.ts status
\`\`\`

Useful commands:

\`\`\`sh
bun medina-cli.ts status
bun medina-cli.ts days 7 --header
bun medina-cli.ts day today
bun medina-cli.ts show yesterday
bun medina-cli.ts in --wait ./voice.m4a
bun medina-cli.ts get /recordings.json
bun medina-cli.ts req POST /events --json '{"type":"note","text":"hello"}'
\`\`\`

CLI stdout is data-oriented for pipes; progress and HTTP status lines go to stderr.

## Client artifacts

- \`GET /sdk.js\` — browser SDK bundle
- \`GET /sdk.d.ts\` — SDK TypeScript declarations
- \`GET /sdk.ts\` — SDK source
- \`GET /medina-cli.ts\` — Bun-runnable bundled CLI
- \`GET /app\` — Expo web app served from the committed static export
`;
}
