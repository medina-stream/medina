# Medina

Medina is self-hostable personal context infrastructure.

It accepts messy, high-volume personal data, stores it safely in your own S3-compatible bucket, derives useful resources from it, and exposes the right slices to users and agents at the right time.

## Quickstart for local development

Medina expects S3-compatible object storage. For local development, we recommend [Garage](./docs/garage.md).

1. Install Bun and Garage.
2. Create a local Garage bucket and access key.
3. Copy the example environment and fill in the Garage values:

```bash
cp .env.example .env
bun install
bun run dev
```

Open the URL printed by the dev server. By default, the web app served from `/app` uses the same host it was loaded from.

## Repository shape

- [`server/`](./server): Bun server entrypoint, Hono API routes, and web UI
- [`bin/`](./bin): Medina CLI commands
- [`expo/`](./expo): Expo app and committed web export source
- [`lib/`](./lib): shared storage, ingest, event, auth, and stream code
- [`resources/`](./resources): resource model and transformations
- [`docs/`](./docs): configuration, storage, auth, API, and architecture notes

## Core concepts

Medina starts from raw inputs and moves upward through explicit derivation:

- raw `in/*` objects are the untrusted import frontier
- `ingests` normalize file/media metadata and estimate start times
- `recordings` organize and chunk audio for listening and analysis
- higher-order resources build on top of recordings and other derived resources
- small resource modules define how one resource becomes another

## Configuration

The default stream template uses one hostname, one S3-compatible bucket, and one default user. The important variables are:

```env
MEDINA_ROOT=http://localhost:3002
MEDINA_TOKEN=replace-with-a-long-random-secret

S3_BUCKET=medina-dev
S3_ENDPOINT=http://127.0.0.1:3900
S3_REGION=garage
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true
```

Stream preferences live in the bucket at `medina.conf`. Medina creates it on first startup with:

```json
{
  "name": "My Stream"
}
```

See:

- [Garage local storage](./docs/garage.md)
- [Configuration](./docs/configuration.md)
- [Stream routing](./docs/stream-routing.md)
- [Tailscale auth](./docs/auth-tailscale.md)

## Common commands

```bash
bun run dev              # development server
bun test                 # test suite
bun run resources        # materialize configured resources
bun run smoke:ingest     # ingest-to-materialization smoke test
bun run audit:public     # check for managed/deployment leakage
```

`bun run dev` serves `/app` from the committed Expo web export in [`static/app/`](./static/app). After any change under [`expo/`](./expo/) that affects app UI or behavior, refresh the committed export:

```bash
npm run refresh:app-static
```

To work against a live Expo dev server instead:

```bash
bun run dev:app
EXPO_DEV_SERVER_URL=http://127.0.0.1:8082 bun run dev
```

## API snapshot

- `GET /status.json`
- `GET /events.json`
- `GET /recordings.json`
- `GET /intervals.json`
- `GET /020260515.json`
- `POST /in`
- `PUT /in/:ingestId`
- `POST /in/:ingestId/finished`
- `GET /recordings/:id/:file`
- `GET /events`
- `GET /sdk.js`
- `GET /sdk.ts`
- `GET /sdk.d.ts`
- `GET /app` and `/app/*`

See [API.md](./docs/API.md) for more detail.

## Resource materialization

Derived resources are declarative, receipt-backed transformations over durable bucket objects. The generic worker claims triage, grouped GPS, media, and transcription work while resource definitions decide freshness from explicit dependencies.

```bash
bun scripts/ingest-worker.ts --once
bun scripts/ingest-worker.ts
```

Run a single resource directly:

```bash
bun resources/ingests.ts in/<ingest-id>
bun resources/recordings.ts 02026/.../ingests/in/<ingest-id>.json
bun resources/intervals.ts 020260515
```

## Bucket inspection

`scripts/s3` is a thin wrapper around `aws s3` that loads `S3_*` credentials from `.env` and sets the endpoint automatically:

```bash
./scripts/s3 ls s3://medina-dev/
./scripts/s3 ls s3://medina-dev/chunks/ --recursive
```

## NAS metadata scan

`scripts/nas-scan.py` scans an audio archive and emits shareable metadata-only JSONL/CSV. It does not upload, copy, or export raw audio.

```bash
python3 scripts/nas-scan.py /path/to/audio/archive \
  --out ~/medina-nas-scan \
  --timezone America/Los_Angeles \
  --hash-mode none
```

Useful options include `--limit`, `--include-extensions`, `--hash-mode none|prefix|full`, and `--no-ffprobe`.

## License

[MIT](./LICENSE)
