# Medina rethink

A single-stream Worker that progressively turns Drive files into durable artifacts:

```text
hourly schedule → GdriveSource → Stream candidate queue → direct R2 download → Triage → product
```

- [`resources/GdriveSource.ts`](./resources/GdriveSource.ts) lists Drive metadata, records new file versions in the Stream DO, claims the newest candidate, and downloads it straight to R2.
- [`resources/Triage.ts`](./resources/Triage.ts) hashes and inspects raw ingests, writes `triage/<id>.json`, then accepts or retains them in the Stream.
- [`server/index.ts`](./server/index.ts) is a read-only Hono app plus the scheduled Worker handler.
- [`lib/`](./lib/) owns Drive API, artifact, ingest, and Stream mechanics.

The Stream DO stores only compact Drive observations and ingest state. R2 stores raw bytes and immutable result artifacts. The hourly cron starts `GdriveSource`; no Medina HTTP upload routes exist.

- `GET /` displays the last triaged ingest.
- `GET /state` displays the Stream’s candidates and ingest state.
- `GET /ingests/:id` reads a triage artifact.

For local development, `npm run dev` enables Wrangler’s `GET /__scheduled` test route. No VM sync process is active.
