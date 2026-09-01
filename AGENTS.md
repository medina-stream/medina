# Effect v4 (RC)

This branch is built on Effect v4 RC (`effect@4.0.0-rc.112` and
`@effect/platform-node@4.0.0-rc.112`). Your knowledge of Effect is likely v3;
v4 renames and moves many APIs (e.g. `Context.Service` classes,
`effect/unstable/http`, lowercase `Config.string`). The Effect repo is cloned
at `../effect` — grep it for current signatures before writing code, and note
that repo `main` can be slightly ahead of the published RC; the installed
`node_modules/effect/dist/*.d.ts` files are the final authority.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local development (watch mode) |
| `npm start` | Run the server |
| `npm run typecheck` | Type check |

## State

`data/artifacts/` holds all pipeline state as JSON artifacts and is
gitignored. Do not delete it: it contains transcripts exported from the
previous Cloudflare implementation whose audio would be expensive to
re-process.
