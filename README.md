# Medina

A personal context store: sources ingest captures into the data dir;
resources are software-defined data that should exist there, materialized
when stale. The vocabulary (source, capture, ingest, resource, materialize,
freshness) comes from the notes repo — see `Medina Themes.md` and
`Journal/2026-04-19.md` there. Start reading at `lib/Resource.ts`.

## Stack

- Bun
- [Effect v4 (RC)](https://effect.website/)
- HTMX?

The Effect v4 sources should be cloned alongside this repo at `../effect` for
API reference (the RC differs from both v3 and the published docs in places).

## Compatibility freeze

The data was exported from the previous Cloudflare
implementation's bucket, minus the ~10 GB of raw audio — so all prior transcription
and journaling work is reused as-is. Everything about the stored shapes is
therefore load-bearing: key layouts (`transcript/assemblyai-u35p-v1/…`,
`journal/journal-v4/…`, `triage/…`) and JSON field names must not change
without a migration.

## Running

```bash
bun install
bun run dev    # or: bun start
```

Configuration comes from `.env` (see `.env.example`): Drive token mint URL and
folder id, AssemblyAI and LLM endpoints (exe.dev integrations inject
credentials at the network edge, so no keys live here), `NOTES_REPO_DIR` for
the notes checkout, `SOURCE_LATEST` for the latest-N window, and `PORT`.
