# Medina Workers rethink

A deliberately small Cloudflare exploration:

- one stream Durable Object owns compact coordination state
- a named Workflow materializes an artifact
- the Worker exposes the smallest possible control surface

```sh
npm install
npm run dev -- --ip 0.0.0.0 --port 8000
```

- `GET /state` reads the stream state.
- `POST /materialize/:resource` starts a materialization workflow.
- `GET /workflows/:id` reads a workflow status.

This branch is local-only. It has no Cloudflare account resources or production deployment configuration.
