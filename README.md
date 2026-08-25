# Medina rethink

A single-stream Hono Worker built from small Resources:

```text
Google Drive source → raw ingest → Triage → immutable R2 artifacts → Stream head → product
```

- [`resources/GdriveSource.ts`](./resources/GdriveSource.ts) is a source Resource. The external hourly sync downloads one Drive file and posts its bytes here; the Resource creates a raw `in/<id>` artifact and starts Triage.
- [`resources/Triage.ts`](./resources/Triage.ts) is a derived Resource. It hashes and inspects the raw artifact, writes `triage/<id>.json`, then accepts or retains it in the Stream.
- [`src/index.ts`](./src/index.ts) is only the Hono/HTTP adapter and Worker entrypoint.
- [`lib/`](./lib/) owns shared artifact, ingest, and Stream mechanics.

```sh
curl -X POST http://127.0.0.1:8000/sources/gdrive \
  -H 'content-type: audio/mp4' \
  -H 'x-medina-filename: voice-note.m4a' \
  --data-binary @voice-note.m4a
```

- `POST /sources/gdrive` creates an ingest from Drive provenance and starts Triage.
- `POST /ingests` starts Triage for a generic raw upload.
- `GET /ingests/:id` reads the triage artifact.
- `GET /` displays the last triaged ingest; `GET /state` displays compact Stream state.

The Google Drive sync operator and one-hour systemd timer live separately in `/home/exedev/medina-ops`.
