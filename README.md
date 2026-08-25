# Medina rethink

A local Cloudflare proof of concept for the smallest plausible Medina pipeline:

```text
input → durable Workflow → immutable R2 artifact → Stream DO head → product
```

The Worker has no UI and no application data model beyond this pipeline.

```sh
npm install
npm run dev -- --ip 0.0.0.0 --port 8000
curl -X POST http://127.0.0.1:8000/inputs \
  -H 'content-type: application/json' \
  -d '{"text":"Messy input becomes a compact artifact."}'
curl http://127.0.0.1:8000/
```

- `POST /inputs` starts a Workflow.
- The Workflow condenses the input, writes an immutable JSON artifact to R2, then commits its key as the Stream DO’s current head.
- `GET /` displays the current product.
- `GET /state` exposes the small coordination state.
- `GET /workflows/:id` exposes a run status.

`wrangler dev --local` provides local implementations of R2, Durable Objects, and Workflows. No Cloudflare account resources are created by this branch.
