# Next task: make Journal reliable and useful

The app runs at port 8000. `GET /` renders Journal artifacts from local R2.

## Current observed output

- `2026-08-25`: a cautious but somewhat useful report.
- `2026-08-27`: **bad** — it exposes the LLM gateway's `reasoning_content` / working notes instead of a user-facing journal.
- `2026-08-28`: empty report, because it had no transcripts.

## Fix goals

1. **Never publish reasoning.** `lib/llm.ts` currently falls back from `message.content` to `message.reasoning_content`; remove that behavior. Select/use a model or API response mode that reliably supplies final `content`. Treat a missing final answer as a failed run, not a report.
2. **Avoid empty journals.** Do not write or index a Journal artifact when a day has zero transcript inputs.
3. **Use recording time, not ingest time.** `AssemblyAITranscript` indexes a day from `ingest.receivedAt`. Derive and persist an event/capture timestamp during inspection (filename is an acceptable temporary basis), then index Journal inputs by that day.
4. **Make automatic triggering sensible.** A transcript completion starts a debounced day Journal; preserve that behavior, but avoid duplicate LLM work and allow a later revision when new transcripts arrive.
5. **Keep the catalog boring.** `Stream` is intended as SQLite index/pointers only; R2 holds raw audio, transcript payloads, and Journal artifacts. Do not reintroduce queue/lease/workflow-state machinery into `lib/stream.ts`.
6. **Use Workflows for orchestration.** Current shape is `SourceRun` → `ProcessIngest` → `AssemblyAITranscript`, plus `Journal`. Prefer durable Workflow steps/retries over hand-built state machines.

## Relevant files

- `resources/Journal.ts` — batching, prompts, Journal artifact output.
- `lib/llm.ts` — OpenAI-compatible gateway call; current source of reasoning leakage.
- `resources/AssemblyAITranscript.ts` — transcript result/index registration and Journal trigger.
- `resources/Triage.ts` — inspection facts; likely home for provisional capture-time extraction.
- `lib/stream.ts` — SQLite journal input/report index.
- `server/index.ts` — simple homepage renderer.
- `.dev.vars.example` — local exe.dev LLM gateway/model configuration.

## Local data / safety

There are local R2 transcript artifacts from a broad earlier test run. Do **not** start broad source ingestion. Local development is capped with `DEV_SOURCE_LIMIT=6`, selected across the newest two source days.

Before declaring success, regenerate the affected Journal days and verify `GET /` contains only clean user-facing report text.
