# Medina Architecture

## Thesis

Medina is infrastructure for personal context.

It should be able to ingest broad, messy personal data, preserve it with minimal assumptions, and support layered derivation into more structured and more shareable resources.

## Core Surfaces

- JSON API
- CLI
- app
- SDK

These should all reflect the same model and the same resource contracts.

## Resource Layers

### `ingests`

`ingests` are the raw frontier.

- they are accepted with minimal assumptions
- they preserve original bytes and important metadata
- they are not yet trusted, normalized, or safe to expose broadly
- they are the source material for further derivation

### `recordings`

`recordings` are an important early derived resource class.

In general, a recording should be:

- selected from relevant ingests
- organized into a stable identity
- sanitized for downstream use
- chunked and, where appropriate, transcoded
- time-estimated
- censored or redacted where needed
- characterized with machine-usable metadata
- hashed so downstream references can be stable and auditable

### Higher-order resources

Higher-order resources sit on top of recordings and other derived resources.

Examples:

- transcripts
- summaries
- incidents
- notes
- timelines
- entities
- exports
- user-specific views

Some resources may be tiny Markdown files. Others may be substantial programs or native binaries. The preferred default is still small, readable TypeScript transforms where that is enough.

## Transforms

Medina needs a layered transform model.

At a high level:

- users define short functions or scripts
- a transform consumes one or more resources
- it emits one or more derived resources
- each output should carry enough metadata to understand provenance
- the system should be able to decide what is safe to expose and to whom

Useful transform properties will likely include:

- input resource references
- output resource references
- hashes
- timestamps
- transform identity or version
- metadata
- exposure policy

## Resource Contract Sketch

The first concrete resource abstraction is intentionally small:

- a resource has a `kind`, such as `ingests`, `recordings`, or `intervals`
- a resource reference has an `id`, `kind`, and bucket `key`
- a resource reference may include a URL only when a narrower exposure path intentionally publishes it
- JSON resources can be wrapped in an envelope with optional provenance
- transforms are named, versioned functions from one resource envelope to zero or more output envelopes

The current framework code lives in `lib/resource.ts`. It is not a scheduler or sandbox yet. It gives resource scripts a common shape so the API, CLI, app, and SDK can agree on identity, materialization, and URLs before the runtime becomes more powerful.

### `ingests` as degenerate resources

The `in/*` namespace is the raw resource frontier. It is degenerate because it is a flat bucket namespace rather than a carefully modeled resource set, but every ingest can still be referenced by bucket key and served over HTTP.

### `ingests` and `recordings` as the first derived resources

The current resource graph starts with three declarative resource definitions:

- `resources/ingests.ts` defines ingest-analysis resources over raw `in/*` objects
- `resources/recordings.ts` defines chunked recording resources over ingest analyses
- `resources/intervals.ts` defines interval resources over the set of known recordings

This keeps ingest analysis separate from recording materialization while treating each resource family as something that can be materialized independently from its declared dependencies.

### `intervals` as the primary read model

`intervals` are materialized range resources built from downstream data such as recordings. The first shape is day-sized ids like `020260515`, but the contract is intentionally generic so the same resource family can later serve month intervals like `0202605` or year intervals like `02026`.

Example:

- day interval: `intervals/020260515.json`
- month interval: `intervals/0202605.json`

That keeps the API and UI centered on one concept: fetch an interval resource and render it, without baking “day” assumptions into every layer.

## Design Direction

The next major architectural step is to formalize this derivation layer cleanly enough that:

- the API can expose it directly
- the CLI can inspect and run it
- the app can visualize it
- other clients can use it without becoming a special case in the architecture
