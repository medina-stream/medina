# Canonical AppIcon design

Status: revised for `effect-rethink` and implemented on 2026-09-14.

## Model

`AppIcon` is one canonical resource, not the input to a separate icon pipeline.
Its hand-edited definition is a data-only TypeScript module containing the
inline SVG, separated foreground artwork, colors, product metadata, and the
design prompt. Normal builds are deterministic and offline; the prompt records
intent but never invokes a model.

Materialization means making a declared set of paths or object keys exist with
the correct bytes. The existing pipeline does this for the durable resource
tree. The resource contract additionally permits a resource-level materializer
parameterized by a target, allowing a build to ask the same resource for its
own concrete outputs. A target is Schema-decoded data, not hidden script
configuration. This keeps ownership and derivation in the resource while build
steps remain thin invokers.

For the web app, `build:icons` invokes `appIconResource.materialize(webTarget)`.
The target declares every output path, public route, media type, variant, and
size. AppIcon's one materializer writes SVG and raster derivatives, constructs
the ICO, and rewrites the web manifest to reference the target's URLs. The
aggregate build composes icon, browser-client, and CLI builds. Derived files
remain under ignored `example-lifelog/public/`; source-controlled binary assets
would create a second authority.

This target-based API also admits S3 keys: another target can provide keys and
the materializer can use the appropriate storage service without changing the
canonical definition. No S3 target is needed by this branch.

## Web target and consumers

The web target produces:

| Artifact | Purpose |
| --- | --- |
| canonical SVG | preferred browser icon and manifest `any` icon |
| 16/32/48 PNG-in-ICO | legacy favicon compatibility |
| 180 px PNG | Apple touch icon |
| 192 and 512 px PNG | manifest `any` icons |
| 192 and 512 px safe-zone PNG | manifest `maskable` icons |
| web manifest | install metadata generated from AppIcon and this target |

Every public name contains the first 16 hex characters of the canonical SVG's
SHA-256. Shared HTML metadata references those same descriptors for the
manifest, SVG/ICO favicons, Apple touch icon, and theme color. The server
registers only the declared routes—there is no general static-file mount—and
serves them with their explicit media types.

The manifest contains `id`, `start_url`, and `scope` `/`, standalone display,
canonical names/description/colors, and exactly the SVG, two regular PNGs, and
two maskable PNGs. ICO and Apple touch outputs are intentionally HTML/browser
concerns rather than manifest entries.

## Caching and rollout

Icons are read constantly and almost never changed. All icon and manifest URLs
are content-addressed and therefore receive
`public, max-age=31536000, immutable`. Changing the canonical SVG creates a new
hash namespace; rebuilt HTML and manifest point at the new URLs immediately.
Old cached objects can expire naturally, so rollout needs neither invalidation
nor a mutable compatibility route. Missing build outputs return 503 with a
direct build instruction rather than silently serving stale content.

## Effect-oriented boundaries

- `AppIconTarget` and each output descriptor are Effect Schema classes, making
  the build request explicit and validated at the materialization boundary.
- Materialization is an `Effect` requiring `FileSystem`; only the tiny command
  entry point supplies Bun's live filesystem layer.
- Rendering and manifest construction are pure helpers around the canonical
  data. HTTP response loading also uses the filesystem service.
- The generic resource vocabulary exposes target materialization while leaving
  eager/lazy instance behavior unchanged for existing resources.
- Tests provide a real filesystem layer over isolated temporary directories,
  exercise replacement of incorrect files, and assert the descriptor-driven
  HTTP contract and shared markup.

## Future native targets

Do no Expo work until an Expo build exists on this branch. At that point, add an
Expo build target listing exactly the icon paths it needs and any config file it
needs rewritten. The Expo build step invokes the same AppIcon materializer;
materialization can render those requested sizes and update the config to point
at their content-addressed paths. There is still one resource and one
`materialize(target)` operation—no Expo icon generator, checked-in copies, or
parallel pipeline.

## Acceptance checks

The focused tests verify target validation, complete output creation, PNG
dimensions, ICO structure, deterministic repair, manifest membership, route
allowlisting/content types/cache policy, and hashed shared HTML metadata. The
repository acceptance sequence is `bun run typecheck`, `bun test`, and
`bun run build` (the client build is included in the aggregate build).
