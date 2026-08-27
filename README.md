# Medina rethink

A single-stream Worker that progressively turns Drive files into a compact public root artifact:

```text
hourly schedule → GdriveSource → Stream candidate queue → direct R2 download → Triage ┬→ AssemblyAITranscript → Journal (on demand, per day)
                                                                              └→ Root
```

- [`resources/EasyVoice.ts`](./resources/EasyVoice.ts) is the tiny source declaration: a name, provider, and Drive folder ID.
- [`workflows/Source.ts`](./workflows/Source.ts) is the generic source refresh/ingest machinery: discover, observe, claim, and download.
- [`resources/Triage.ts`](./resources/Triage.ts) hashes and inspects raw ingests, writing private `triage/<id>.json` artifacts.
- [`resources/AssemblyAITranscript.ts`](./resources/AssemblyAITranscript.ts) turns accepted audio ingests into normalized speaker-attributed transcripts, retaining the private vendor response alongside the Medina result.
- [`resources/Journal.ts`](./resources/Journal.ts) creates a versioned LLM report for one calendar day from the transcript artifacts currently indexed by Stream.
- [`resources/Root.ts`](./resources/Root.ts) turns accepted triages into compact public summaries and publishes `root/<generation>.json`.
- [`server/index.ts`](./server/index.ts) is a read-only Hono app plus the scheduled Worker handler.
- [`lib/`](./lib/) owns Drive API, artifact, ingest, and Stream mechanics.

The public app is only `GET /`, which renders indexed Journal reports. An hourly cron refreshes sources and drains their candidate queue; a daily **00:30 UTC** cron generates/revises journals for completed prior-day transcripts. Internal artifacts, Stream scheduling state, workflow state, and bucket inspection have no public routes.

No VM sync process is active. Local cron behavior can be exercised with a separate temporary Wrangler test session; it is not exposed by the running app.

## AssemblyAI development auth

For local Wrangler development, copy `.dev.vars.example` to `.dev.vars`. It targets the attached exe.dev AssemblyAI integration, which supplies credentials outside the repository. Production uses the direct AssemblyAI endpoint by default and needs either an `ASSEMBLYAI_API_KEY` Worker secret or a pre-authenticated `ASSEMBLYAI_API_URL` relay.
