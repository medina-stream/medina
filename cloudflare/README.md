# Medina on Cloudflare

The Alchemy stack for Medina's Cloudflare deployment (Workers-native).
Plan: `docs/cloudflare-migration.md` in the repo root. This directory
is deliberately separate from the bun server code (`example-lifelog/`,
`lib/`), which keeps running production on medina-dev until cutover.

## Layout

- `alchemy.run.ts` — the stack (**Medina**): the `sco-lifelog` R2
  bucket (adopted, see below) and one Worker, stage-scoped name.
- `src/worker.ts` — the Worker. Milestone 1 serves `/health`,
  `/api/capture-policy/<token>`, and `/bucket-capture/<stamp>.apk`
  from the bucket, mirroring the medina-index Worker's public routes.

## Deploy (dev stage)

Credentials come from the vault via the Cloudflare connector helper —
never put a token in this repo or in a shell history file:

```sh
cd cloudflare
bun install
python3 ~/workspace/bin/cf_env_run.py . bun run deploy:dev
```

`cf_env_run.py` injects `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` for the child process. The deploy prints the
Worker's workers.dev URL.

State is local (`.alchemy/`, committed), matching hskping.

## Warnings

- **The bucket is adopted, not owned.** `sco-lifelog` is Medina's
  canonical artifact bucket; the stack declares it only to bind it to
  the Worker. Never run `alchemy destroy` on this stack without
  removing that resource first.
- **No secrets in the stack.** Provider keys will be Secrets Store
  bindings attached out-of-band (hskping Path B), never declared here.
- The root repo `.gitignore` ignores `package.json`/`tsconfig.json`
  at every depth (a bun-server-era rule); the local `.gitignore` in
  this directory re-includes them for this package only.
