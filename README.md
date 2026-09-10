# Medina

Medina is a personal context management platform. Ingest anything,
keep it safe, derive useful indexes and summaries for all your agents.
Use our simple but powerful Effect-based primitives to define your data
sources, the questions you have for your data, and Medina will help manage
an efficient pipeline. Connect your agents via MCP and they'll gain instant
understanding of your larger personal context.

see `Medina Themes.md` in the notes repo for background.


## Stack

- [Effect v4 (RC)](https://effect.website/)
  - The Effect v4 sources should be cloned alongside this repo at `../effect` for API reference (the RC differs from both v3 and the published docs in places).
- Bun
- DuckDB
- Any writable filesystem locally; Archil is an optional cloud deployment choice

## Architecture

The repository deliberately separates the reusable Medina library from one
personal application:

- `lib/` contains the context-lake framework, connectors, reusable capture
  ingestion, lifelog derivatives, runtime support, and common web UI.
- `example-lifelog/` chooses concrete source locations and personal policy,
  then wires those library capabilities into an application.

The public entry points are `medina`, `medina/connectors`, `medina/capture`,
`medina/lifelog`, and `medina/runtime`. The lifelog package includes normalized transcripts,
correctable attribution, day indexing, GPS/places/movement, durable daily
synthesis, typed RPC contracts, and the journal UI. Applications should
configure these capabilities rather than copy their implementations.

Artifact keys remain relative and content/basis addressed. `ArtifactStore`
owns safe key-to-filesystem resolution, and `Resource` provides common cached
and materializing reads. Existing artifact layouts remain compatible across
the library/application split.

## Local development

Medina does not require Archil locally. `DATA_DIR` is an ordinary writable
directory, and the single-process runner uses SQLite by default. Archil is one
way a cloud deployment can provide durable storage; it is not part of the
application contract.

Install [Bun](https://bun.sh/) and DuckDB. On Arch Linux:

```sh
sudo pacman -S --needed duckdb
bun install
```

Create the local configuration:

```sh
cp .env.example .env
```

The fastest way to see it run is with no external services at all. Set
`MEDINA_SOURCES=` (empty) and Medina starts, serves the UI, and reports every
source as disabled rather than failing:

```dotenv
MEDINA_SOURCES=
DATA_DIR=data/artifacts
CLUSTER_DB=data/cluster.db
HOME_TZ=UTC
PORT=8000
```

That gives you an empty but honest instance — "3 sources disabled", "No
journal days yet." Add sources once you want data flowing:

```dotenv
MEDINA_SOURCES=notes
NOTES_REPO_URL=git@github.com:you/notes.git
NOTES_REPO_REF=main
LIFELOG_EPOCH_DAY=1900-01-01
LIFELOG_MAIN_CHANNEL=main
```

Both local data paths are ignored by Git. Medina clones `NOTES_REPO_URL` into
`DATA_DIR/sources/git`, fetches `NOTES_REPO_REF` before each pass, and reads
committed blobs without modifying or pushing to the source repository. Normal
Git credential and SSH configuration provide private-repository access. Set
`NOTES_REPO_DIR` instead to read an existing checkout without managing it.

`MEDINA_SOURCES` is a comma-separated subset of the external sources
`audio,inventory,allow,notes,bucket`.
Missing source-specific configuration disables that source and reports why at
`GET /status`; it does not prevent the server from starting. An empty value
disables every scheduled source. Existing data remains readable and HTTP
ingestion remains available. GPS compaction and stay detection are internal
processing stages rather than sources; they continue processing captures
accepted through `POST /in` and are reported separately by `/status`.

### S3-compatible recording bucket

The `bucket` source imports recordings from S3 or an S3-compatible service.
It lists objects matching `BUCKET_PREFIX`, selects the newest
`BUCKET_LIMIT` by object modification time,
streams uncached objects into the content-addressed capture store, and then
uses the same AssemblyAI transcription path as Drive audio.

```dotenv
MEDINA_SOURCES=notes,bucket
BUCKET_ENDPOINT=https://s3.example.com
BUCKET_NAME=recordings
BUCKET_ACCESS_KEY_ID=...
BUCKET_SECRET_ACCESS_KEY=...
BUCKET_REGION=us-east-1
BUCKET_FORCE_PATH_STYLE=true
BUCKET_PREFIX=recordings/
BUCKET_LIMIT=25
```

Use a narrow prefix for large buckets: S3 has no descending listing operation,
so Medina must enumerate every matching key before it can select the newest.

The example external-service URLs are exe.dev wire integrations. Their
`.int.exe.xyz` addresses work inside exe.dev VMs but are not reachable from a
normal local machine. For local development, configure direct vendor APIs:

```dotenv
ASSEMBLYAI_API_URL=https://api.assemblyai.com
# Optional Universal-3.5 Pro context and known-speaker identification:
# ASSEMBLYAI_PROMPT=Personal ambient lifelog audio recorded by Scott Raymond, including conversations and spoken notes.
# ASSEMBLYAI_SPEAKER_NAMES=Scott Raymond
ASSEMBLYAI_API_KEY=...
JOURNAL_LLM_API_URL=https://api.openai.com/v1
JOURNAL_LLM_API_KEY=...
```

Google Drive is the exception: `GOOGLE_TOKEN_URL` is a Medina-specific token
mint, not a Google API endpoint. Enabling the `audio` source requires a
reachable token mint plus `GDRIVE_FOLDER_ID`; direct local Google
authentication is not implemented yet. Leave `audio` out of `MEDINA_SOURCES`
to run without Drive or AssemblyAI.

The `allow` source is remote-first. It uses the token mint only to create a
short-lived private Drive request, then a signed Transloadit SDK Assembly reads
the file directly from Google and stores the original plus one-hour Opus chunks
in R2. Medina keeps provenance, Assembly receipts, and manifests locally; no
allowlisted file bytes pass through the VM. AssemblyAI likewise receives only
short-lived R2 URLs, and transcript IDs are polled on later pipeline passes.
This path requires `TRANSLOADIT_API_KEY`, `TRANSLOADIT_AUTH_SECRET`, and the R2
temporary-credential settings documented in `.env.example`.

Check and run the application from the repository root:

```sh
bun test
bun run typecheck
bun run dev
```

The development server listens on `PORT` (8000 by default). The first pipeline
pass starts immediately, then repeats hourly. Source failures are isolated and
recorded rather than terminating the server; the home page and `GET /status`
show whether data is flowing, empty, disabled, degraded, or failing.

## Lifelog MCP server

The read-only MCP bridge exposes two tools to an agent: `list_recent_days`
(the latest 30 civil days, newest first) and `get_day_summary` (the complete
journal report for an ISO `YYYY-MM-DD` day). It reads Medina's cached
`/journal/:day` endpoint, so MCP requests never trigger LLM work.

Start Medina, then configure the MCP client to run:

```json
{
  "command": "bun",
  "args": ["run", "mcp:lifelog"],
  "cwd": "/path/to/medina"
}
```

By default it connects to `http://127.0.0.1:$PORT` and uses `HOME_TZ` to
calculate civil days. Set `LIFELOG_URL` when the lifelog is elsewhere, and
`LIFELOG_TIME_ZONE` to override that timezone. Keep `LIFELOG_URL` on a
trusted, authenticated network path: the MCP bridge carries the full private
journal to its client.

## Exposure, identity, and agent delegation

Medina binds to `127.0.0.1` by default. Put an authenticating front door in
front of it:

- **exe.dev** (recommended for the owner): the proxy authenticates the VM owner
  before a request reaches the port.
- **Tailscale**: `tailscale serve` terminates TLS for the tailnet and forwards
  to loopback, injecting a verified `Tailscale-User-Login`.
- **Anything else**: a reverse proxy that authenticates and forwards to
  loopback.

Set `HOST=0.0.0.0` only when one of those is in front. On a laptop on shared
wifi, an unguarded bind publishes a personal lifelog to the local network.

### Delegating Medina to an agent

Medina has one delegated scope today: `medina`, which is full access to the
current API. It is intentionally one permission rather than a premature role
system. `GET /auth.md` describes the compact approval flow:

1. The agent creates a request at `POST /auth/requests` with its name.
2. You open the returned approval URL from Tailscale and choose Allow or Deny.
3. The agent polls `POST /oauth2/token` and receives a one-hour Bearer token.
4. It sends that token as `Authorization: Bearer …` to REST and `/rpc`.

`AUTH_OWNER` names the Tailscale login allowed to approve a delegation; it
falls back to `INGEST_OWNER`. Tokens are opaque, stored only as SHA-256 hashes
in `DATA_DIR/auth/delegations.json`, and can be revoked through
`POST /oauth2/revoke`. Tailscale remains the network boundary; the token is a
separately revocable record of delegated trust.

Writes (`POST /in`, `PUT /places`) are otherwise gated on `INGEST_OWNER`,
matched against the Tailscale login behind the request. An unset
`INGEST_OWNER` is treated as unconfigured, not open: direct writes are refused
with 503 while a valid delegated `medina` token remains authorized.

