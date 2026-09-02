# Effect v4 (RC)

This branch runs on Bun and is built on Effect v4 RC (`effect@4.0.0-rc.112`
and `@effect/platform-bun@4.0.0-rc.112`). Your knowledge of Effect is likely v3;
v4 renames and moves many APIs (e.g. `Context.Service` classes,
`effect/unstable/http`, lowercase `Config.string`). The Effect repo is cloned
at `../effect` — grep it for current signatures before writing code, and note
that repo `main` can be slightly ahead of the published RC; the installed
`node_modules/effect/dist/*.d.ts` files are the final authority.

## Commands

| Command | Purpose |
|---------|---------|
| `bun run dev` | Local development (watch mode) |
| `bun start` | Run the server |
| `bun run typecheck` | Type check |

## State

`DATA_DIR` (on this VM: `/mnt/archil/medina`, an Archil disk mounted by
`archil-mount.service`) is the data dir — all pipeline state, just a
directory of JSON files accessed with plain filesystem calls (see README
“The data is just files”). Do not
delete it: it contains transcripts exported from the previous Cloudflare
implementation whose audio would be expensive to re-process. Stored key
shapes and JSON field names are frozen (see README “Compatibility freeze”).

## Vocabulary

Use the project's terms: stream, source, capture, channel, ingest,
provenance, attribution, correction, resource, materialize, stale/freshness
(see `lib/Resource.ts` and `example-lifelog/Resources.ts`). Don't introduce
synonyms (artifact, asset, bucket, domain, job).

## Dependencies

The filesystem (`DATA_DIR`) is the only core dependency: the record lives
there, and losing any peripheral service must never lose data. Peripherals
(AssemblyAI, the LLM, DuckDB, buckets, celld) produce or serve the record
but never hold it — speed-layer state (e.g. last known location) is a
cache, rebuildable from the record, outside the freshness machinery.

## Time

Internally everything is UTC; each capture carries a believed IANA zone
(never a bare offset), and its journal day is the local civil date where it
was recorded. `HOME_TZ` interprets zone-less evidence and zone-less request
labels only — it must never override a capture's own zone belief. Ingest
never discards or interprets source metadata (filenames are often the only
record of when something was recorded); interpretation lives in the
attribution layer, which is correctable via `correction/<captureId>.json`.

