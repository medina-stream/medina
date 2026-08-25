# Medina rethink

A local Cloudflare proof of concept for a Software Defined Resource:

```text
local directory → directory snapshot → durable Workflow → immutable R2 artifact → Stream DO head → product
```

The first resource is the `directory` source. Its default directory is `/home/exedev/medina-data/google-drive` and its persisted refresh policy is one hour (`3600` seconds). The Worker does not read the VM filesystem: an external source operator posts directory snapshots, so the same Medina contract works once deployed to Cloudflare.

```sh
npm install
npm run dev -- --ip 0.0.0.0 --port 8000
curl http://127.0.0.1:8000/sources/directory
curl -X POST http://127.0.0.1:8000/sources/directory/refresh \
  -H 'content-type: application/json' \
  -d '{"files":[{"path":"note.txt","size":12,"modifiedAt":"2026-08-25T00:00:00Z"}]}'
curl http://127.0.0.1:8000/
```

- `GET`/`PUT /sources/directory` reads or changes its directory and refresh policy.
- `POST /sources/directory/refresh` starts a Workflow from a directory snapshot.
- The Workflow publishes a compact file-index artifact to R2 and atomically advances the source head in the Stream DO.
- `GET /` displays the last committed artifact.
- `GET /state` exposes the small coordination state.
- `GET /workflows/:id` exposes a run status.

The Google Drive sync operator and hourly systemd timer live separately in `/home/exedev/medina-ops`.
