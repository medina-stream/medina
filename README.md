# Medina rethink

A single-stream Hono Worker exploring Medina’s core pipeline:

```text
source snapshot or raw ingest → durable Workflow → immutable R2 artifact → Stream DO head → product
```

The Worker has one `Stream` Durable Object. It owns compact stream state: source heads, ingest counters, and the last triaged ingest. R2 holds raw bytes and immutable artifacts.

## Directory source

The first SDR is the `directory` source. Its default directory is `/home/exedev/medina-data/google-drive-rethink` and its persisted refresh policy is one hour (`3600` seconds). The Worker does not read the VM filesystem: an external source operator posts directory snapshots, so the same contract works once deployed to Cloudflare.

- `GET`/`PUT /sources/directory` reads or changes its directory and refresh policy.
- `POST /sources/directory/refresh` starts a Workflow from a directory snapshot.

## Ingest and triage SDR

```sh
curl -X POST http://127.0.0.1:8000/ingests \
  -H 'content-type: application/json' \
  -H 'x-medina-filename: note.json' \
  --data '{"hello":"Medina"}'
```

`POST /ingests` writes raw bytes to R2 and starts an ingest Workflow. Its triage SDR writes `triage/<ingest-id>.json`, with:

- SHA-256, byte size, filename, request metadata, and declared content type
- basic magic-byte type detection for JSON, WAV, MP3, Ogg, MP4/M4A, PNG, and PDF
- initial retention signals for zero-byte inputs, unsafe/executable filenames, and declared-type mismatches

The route step commits accepted or retained triage to the Stream. `GET /ingests/:id` reads the triage artifact; `GET /` displays the latest triage product; and `GET /workflows/:id` reads its run status.

Specialized media inspection and richer abuse detectors are intentionally next-stage triage enrichers: this Worker cannot run MediaInfo binaries itself.

The Google Drive sync operator and hourly systemd timer live separately in `/home/exedev/medina-ops`.
