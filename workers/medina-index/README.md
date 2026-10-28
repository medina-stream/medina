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

## Public device routes

Two routes sit ahead of the token gate and read the `sco-lifelog`
bucket (the `BUCKET` R2 binding), so a phone on any network can reach
them at this worker's public `workers.dev` URL — no tailnet DNS, no
exe.dev login gate:

| Endpoint | Returns |
| --- | --- |
| `GET /bucket-capture/<stamp>.apk` | the published recorder APK object `bucket-capture/<stamp>.apk` (public; APKs carry no credentials) |
| `GET /api/capture-policy/<token>` | the capture policy document `capture-policy/policy.json`, when `<token>` is a known, unrevoked capability token |

Token verification reads `capture-policy/tokens.json`, the registry
mirror (SHA-256 hashes only) the Medina server rewrites on every
registry change. Unknown or revoked tokens get a 404, exactly as the
Medina server's own policy route answers. Devices point their policy
URL at this host: `https://medina-index.<subdomain>.workers.dev/api/capture-policy/<token>`
— the same per-device token as before, only the host changes.

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
