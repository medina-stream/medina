# Medina rethink

A single-stream Worker that progressively turns Drive files into a compact public root artifact:

```text
hourly schedule → GdriveSource → Stream candidate queue → direct R2 download → Triage → Root
```

- [`resources/GdriveSource.ts`](./resources/GdriveSource.ts) lists Drive metadata, records new file versions in the Stream DO, claims the newest candidate, and downloads it straight to R2.
- [`resources/Triage.ts`](./resources/Triage.ts) hashes and inspects raw ingests, writing private `triage/<id>.json` artifacts.
- [`resources/Root.ts`](./resources/Root.ts) turns accepted triages into compact public summaries and publishes `root/<generation>.json`.
- [`server/index.ts`](./server/index.ts) is a read-only Hono app plus the scheduled Worker handler.
- [`lib/`](./lib/) owns Drive API, artifact, ingest, and Stream mechanics.

The public API is only `GET /`, which serves Root summaries. Internal triage artifacts, Stream scheduling state, workflow state, and bucket inspection have no public routes.

For local development, `npm run dev` enables Wrangler’s `GET /__scheduled` test route. No VM sync process is active.
