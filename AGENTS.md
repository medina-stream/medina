# Agent Guidelines for Medina

## Big-Picture Goal

The mission is to build Medina as a clean implementation with well-defined resource contracts, no dead code, and no placeholder routes.

The dev server (`bun run dev`, which runs `scripts/dev.ts` → `bun --hot server/index.ts`) picks up edits to `server/` and `lib/` automatically. Verify with `curl http://127.0.0.1:3002/status.json` (default port; see `.env`).

To start the dev server:

```sh
bun run dev
```

Config is in `.env` (gitignored). Do not commit secrets.

## Architecture

- Server runtime: Bun (`server/index.ts`)
- `lib/` must stay runtime-agnostic — no Bun-specific APIs
- No Cloudflare Workers, no Railway, no Docker required
- Storage: S3-compatible via `S3_*` env vars (pointed at local Garage)
- The Expo app in `expo/` is ported from the old architecture as reference material for re-implementing the API and CLI

## What we're building toward

A clean re-implementation of the API, CLI, and app with well-defined resource contracts (ingests → recordings → higher-order resources). Compact, no dead code, no placeholder routes.

## Code style

- Prefer portable TypeScript/JavaScript in `lib/` — no Bun-only APIs there
- Keep core resource behavior in `resources/` and shared helpers in `lib/`
- Keep `scripts/` files minimal: argument parsing, environment setup, and orchestration only
- Keep package scripts as the invocation surface for common commands
- Use Bun APIs freely in `server/` and `bin/`
- No comments unless the why is non-obvious
- No extra abstractions beyond what the task requires

## Testing

```sh
bun run test
```

Always use `bun run test` (the package script), not bare `bun test`: bunfig.toml sets a test root that makes bare `bun test` skip `resources/*.test.ts`.

## UI change checklist

- `bun run dev` serves `/app` from the exported web bundle in `static/app/`, not directly from the files under `expo/`, unless `EXPO_DEV_SERVER_URL` is set.
- After any change under `expo/` that affects the UI or behavior of the Expo app, run `npm run refresh:app-static` before considering the task complete.
- Deploy builds use the committed `static/app/` artifact as-is and do not install `expo/` dependencies or run Expo export by default.
- Do not assume a browser refresh will pick up Expo app changes until `static/app/` has been rebuilt and committed.
