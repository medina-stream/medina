# Medina rethink

A single-stream Worker that progressively turns Drive files into a compact public root artifact:

```text
hourly schedule → SourceRun → ProcessIngest → inspect → AssemblyAITranscript → JournalDay
```

- [`resources/EasyVoice.ts`](./resources/EasyVoice.ts) is the tiny source declaration: a name, provider, and Drive folder ID.
- [`workflows/Source.ts`](./workflows/Source.ts) is the generic source refresh/ingest machinery: discover, observe, claim, and download.
- [`resources/Triage.ts`](./resources/Triage.ts) hashes and inspects raw ingests, writing private `triage/<id>.json` artifacts.
- [`resources/AssemblyAITranscript.ts`](./resources/AssemblyAITranscript.ts) turns accepted audio ingests into normalized speaker-attributed transcripts, retaining the private vendor response alongside the Medina result.
- [`resources/Journal.ts`](./resources/Journal.ts) writes one versioned LLM report per calendar day from the transcripts Stream indexes under that day.
- [`server/index.ts`](./server/index.ts) is a read-only Hono app plus the scheduled Worker handler.
- [`lib/`](./lib/) owns Drive API, artifact, ingest, and Stream mechanics.

Days are the day a recording was *made*, taken from the source filename's `YYYYMMDDThhmmss` stamp at ingest and carried through triage and transcript artifacts. A day with no transcripts produces no artifact and no index entry, so the page never shows an empty entry. The LLM call asks for a final answer only: a response that returns reasoning but no `content` fails the run rather than publishing working notes.

The public app is only `GET /`, which renders indexed Journal reports. An hourly cron refreshes sources; a finished transcript starts a debounced journal for its day, and later transcripts revise it. A daily **00:30 UTC** cron rebuilds the Stream index from R2 and journals every day whose report is missing, stale, or from an older Journal version.

No VM sync process is active. Local cron behavior can be exercised with a separate temporary Wrangler test session; it is not exposed by the running app.

## AssemblyAI and LLM development auth

For local Wrangler development, copy `.dev.vars.example` to `.dev.vars`. It targets the attached exe.dev AssemblyAI and OpenAI integrations, which supply credentials outside the repository. Production uses the direct AssemblyAI endpoint by default and needs either an `ASSEMBLYAI_API_KEY` Worker secret or a pre-authenticated `ASSEMBLYAI_API_URL` relay; the journal LLM likewise needs `JOURNAL_LLM_API_KEY` unless `JOURNAL_LLM_API_URL` is pre-authenticated.
