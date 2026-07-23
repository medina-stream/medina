# Changelog

## 0.1.0 — Unreleased

First public release.

- Bun server with Hono API, web app at `/app`, and `medina` CLI
- Ingest pipeline: raw `in/*` objects → ingests → recordings → derived resources
- S3-compatible storage (bring your own bucket; Garage works well locally)
- Day/interval resources with GPS, transcripts, and speech analysis
- Tailscale and token auth
