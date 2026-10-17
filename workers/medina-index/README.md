# medina-index

The Durable Object index for Medina's bucket-first artifact store
(`lib/ArtifactStore.ts` in the repo root). Artifact bytes live in an S3
bucket (Cloudflare R2); this worker answers the two questions a bucket
cannot answer cheaply: *which keys exist under a prefix*, and *which key
is the latest for a group*.

One Durable Object instance (`global`) with SQLite storage:

- `objects` — one row per artifact key: size, sha256 content hash,
  updated-at. Written by the ArtifactStore on every put/delete, and by
  the migration tool for the pre-existing tree.
- `latest` — one row per pointer group.

## API

All endpoints except `/health` require `Authorization: Bearer
<INDEX_API_TOKEN>`.

| Endpoint | Body / query | Returns |
| --- | --- | --- |
| `GET /health` | — | `{ ok: true }` |
| `POST /register` | `{ key, size, hash? }` (idempotent upsert) | `{ ok: true }` |
| `POST /unregister` | `{ key }` (idempotent) | `{ ok: true }` |
| `GET /list?prefix=` | directory-bounded prefix | `{ keys: [...] }` |
| `GET /latest?group=` | — | `{ key: string \| null }` |
| `PUT /latest` | `{ group, key }` | `{ ok: true }` |

Unregistering a key does not clear latest pointers that name it: a
pointer to a forgotten key reads back as a key whose bytes are gone
(the store's read returns none), never as phantom content.

## Deploy

```sh
cd workers/medina-index
bunx wrangler secret put INDEX_API_TOKEN   # choose a long random token
bunx wrangler deploy
```

Then configure the Medina server (see the repo's `.env` conventions):

```sh
ARTIFACT_STORE=bucket
ARTIFACT_BUCKET_NAME=<bucket>            # plus ARTIFACT_BUCKET_ENDPOINT /
                                         # ARTIFACT_BUCKET_ACCESS_KEY_ID /
                                         # ARTIFACT_BUCKET_SECRET_ACCESS_KEY
MEDINA_INDEX_URL=https://medina-index.<your-subdomain>.workers.dev
INDEX_API_TOKEN=<the same token>
```

Run the migration (`scripts/migrate-artifacts-to-bucket.ts` on the
Medina host) before flipping `ARTIFACT_STORE=bucket`.
