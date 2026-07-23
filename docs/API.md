# Medina API

Medina exposes a small HTTP API with a matching SDK surface for apps, CLIs, and other clients.

## Base URL

- most public JSON endpoints live at top-level `*.json` paths
- runnable SDK: `/sdk.js`
- type declarations: `/sdk.d.ts`

## Authentication

No authentication contract is documented yet.

## Endpoints

### `GET /status.json`

Returns current service status.

Example response:

```json
{
  "ok": true,
  "message": "all systems go",
  "hostname": "medina.example.com",
  "bucket_id": "s3://medina-prod@s3.example.com/auto"
}
```

### `GET /events.json`

Returns the current list of stored events.

### `GET /recordings.json`

Returns the current list of derived recordings.

### `GET /intervals.json`

Returns the currently materialized interval resource references.

### `GET /:intervalId.json`

Returns one materialized interval resource directly from bucket storage.

Current examples:

- `GET /020260515.json` for a day interval
- `GET /0202605.json` for a month interval
- `GET /02026.json` for a year interval

The contract is intentionally generic: clients should treat intervals as range resources keyed by id, not assume every interval spans 24 hours.

### `POST /in`

Creates an ingest destination and returns the upload action, method, headers, and key.

### `PUT /in/:ingestId`

Uploads raw ingest bytes for a chosen ingest id.

### `GET /recordings/:id/:file`

Returns a playable recording chunk.

### `POST /events`

Accepts an application event as a JSON object. Stored in the event log and broadcast to all connected WebSocket clients. If `type` is `"ingest-uploaded"`, triggers resource materialization and emits `"interval.materialized"` events for any intervals that changed.

### `GET /events` (WebSocket)

WebSocket endpoint for live server-push event delivery. Connect with `wss://` and receive all events as JSON as they are created.

## SDK

Browser example:

```js
import { createMedinaClient } from "/sdk.js";

const client = createMedinaClient(window.location.origin);
const notes = await (await client.api.notes.$get()).json();
```

TypeScript consumers can inspect `/sdk.d.ts` for the public client surface.
