# Next task: give the Journal a spine

The app runs at port 8000. `GET /` renders Journal artifacts from local R2.

Journals are now reliable: clean second-person prose, no reasoning leakage, no
empty days, indexed by recording day. What they are not yet is *useful over
time* — every day is written from scratch, in isolation, with no memory of who
the recurring people are or what is still unresolved.

## Fix goals

1. **Carry continuity between days.** A journal should know what came before:
   ongoing threads (a house sale, a court matter, a project), and whether an open
   question from an earlier day got answered. Prefer a small, explicit carried
   state artifact over stuffing prior reports into the prompt.
2. **Name people consistently.** Speaker labels are `A`/`B` per recording. The
   same person across recordings and days should end up with one stable handle,
   and the journal should say when a name is inferred rather than heard.
3. **Make the page readable at length.** Eighteen days of full prose in one
   scroll is already unwieldy. Consider per-day routes, a summary line per day,
   or both — but keep the app read-only and boring.
4. **Keep the boring parts boring.** `Stream` stays SQLite pointers only; R2
   holds artifacts; orchestration stays in Workflows. Anything derived must stay
   rebuildable by the 00:30 UTC reconcile.

## Relevant files

- `resources/Journal.ts` — batching, prompts, Journal artifact output, versioning.
- `lib/stream.ts` — journal input/report index.
- `resources/AssemblyAITranscript.ts` — transcript artifacts, `reindexTranscripts`.
- `server/index.ts` — homepage renderer and cron handlers.

## Local data / safety

Local R2 holds ~35 transcripts from an earlier broad test run, spanning
2026-07-23 to 2026-08-27. Do **not** start broad source ingestion;
`DEV_SOURCE_LIMIT=6` caps local runs.

Bumping the Journal `VERSION` makes the 00:30 UTC reconcile regenerate every
indexed day, which is how you exercise a prompt change end to end:

```sh
npx wrangler dev --local --test-scheduled --port 8000
curl "http://localhost:8000/__scheduled?cron=30+0+*+*+*"
```

A full 18-day regeneration takes a few minutes. Before declaring success, read
the rendered page, not just the logs.
