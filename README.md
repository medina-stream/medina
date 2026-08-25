# Medina rethink

A single-stream Worker that progressively turns Drive files into a compact public root artifact:

```text
hourly schedule → GdriveSource → Stream candidate queue → direct R2 download → Triage → Root
```

- [`resources/EasyVoice.ts`](./resources/EasyVoice.ts) is the tiny source declaration: a name, provider, and Drive folder ID.
- [`workflows/Source.ts`](./workflows/Source.ts) is the generic source refresh/ingest machinery: discover, observe, claim, and download.
- [`resources/Triage.ts`](./resources/Triage.ts) hashes and inspects raw ingests, writing private `triage/<id>.json` artifacts.
- [`resources/Root.ts`](./resources/Root.ts) turns accepted triages into compact public summaries and publishes `root/<generation>.json`.
- [`server/index.ts`](./server/index.ts) is a read-only Hono app plus the scheduled Worker handler.
- [`lib/`](./lib/) owns Drive API, artifact, ingest, and Stream mechanics.

The public API is only `GET /`, which serves Root summaries. Internal triage artifacts, Stream scheduling state, workflow state, and bucket inspection have no public routes.

No VM sync process is active. Local cron behavior can be exercised with a separate temporary Wrangler test session; it is not exposed by the running app.
