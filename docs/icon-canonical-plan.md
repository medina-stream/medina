# Plan: one canonical Medina app icon

Status: investigation and implementation plan only. No implementation has been
started. Findings compare `effect-rethink` at `063e385` with local `main` on
2026-09-14.

## Repository and branch state

The working branch is `effect-rethink`. It already had user changes before this
investigation:

- modified: `lib/lifelog/Pages.tsx`, `lib/lifelog/client.ts`, `todo.md`
- untracked: `docs/android-capture-plan.md`

Do not overwrite or fold those changes into this work. The branches have
diverged from merge base `4f932e1`; neither is an ancestor of the other. Inspect
and port the icon idea deliberately rather than merging or cherry-picking the
large, unrelated `main` rewrite.

## Current state

### `main`

`main` has two partially connected icon systems.

The good core is `resources/app-icon.ts`: it contains a 1024-square inline SVG
and a short English prompt, plus an output list. `lib/image.ts` uses
`@resvg/resvg-js` to materialize SVG and PNG outputs as bucket-backed resources.
The server mounts `/icon.svg`, `/icon-monochrome.svg`, 192/512 regular PNGs,
192/512 maskable PNGs, and `/apple-touch-icon.png`. `/manifest.json` names those
outputs, the Markdown HTML template adds manifest/icon/apple-touch links and a
hard-coded `#0f172a` theme color, and the service worker precaches most of them.
Tests cover SVG extraction, versioning, rasterization, masking, bucket
materialization, routes, manifest entries, and HTML tags.

The disconnected half is Expo/static output:

- `expo/assets/icon.svg`, `icon.png` (1024), `adaptive-icon.png` (512), and
  `apple-touch-icon.png` (180) are checked in.
- `expo/app.json` points directly at the checked-in `icon.png` and
  `adaptive-icon.png`; the adaptive background is separately hard-coded as
  `#0f172a`.
- `static/app/favicon.ico` is another checked-in binary produced by the Expo web
  export. The root image resource does not define or serve `/favicon.ico`.
- `scripts/build-app.ts` exports Expo and edits its generated HTML, but does not
  generate or synchronize icons first.

The checked-in Expo SVG currently matches the inline resource SVG exactly, but
that agreement is by convention, not enforced derivation. The PNGs, ICO,
resource output declaration, web manifest icon array, service-worker asset
list, HTML tags, and three color literals create several drift points.
`lib/image.ts` is also broader than this need: it includes bucket caching,
resource planning/versioning, and optional runtime LLM SVG generation. Those
features fit `main`'s resource model but would be overwrought to port merely to
give `effect-rethink` a favicon.

### `effect-rethink`

This branch has no app-icon asset, web manifest, Expo directory/config, image
generation dependency, or icon build step. `Layout` in
`lib/lifelog/Pages.tsx` emits only charset, viewport, title, and inline CSS in
the document head. `example-lifelog/main.ts` explicitly serves the generated
client bundle and a font; it has no generic static-file or icon routes.

`example-lifelog/public/` is wholly ignored and is already the build-output
location for `app.js` and `medina-cli.js`. That makes it the natural home for
derived web icons without adding binaries to git. The branch currently builds
those two bundles independently in both `dev` and `start`, so icon generation
should join the same small build pipeline rather than introduce the runtime
bucket-resource abstraction from `main`.

On this VM, Bun 1.3.14, ImageMagick 6 `convert`, and ffmpeg are installed.
ImageMagick can read SVG through its own/XML renderer, but it is an unpinned
system tool and should not be the reproducible project dependency.
`effect-rethink` does not currently have `@resvg/resvg-js`; `main` already
proves version 2.6.2 works with this SVG and Bun.

## Proposed canonical module

Add `example-lifelog/app-icon.ts` as the sole hand-edited icon definition. Keep
it data-only and side-effect-free so build scripts, server code, tests, and a
future Expo config can import it. It should export one object containing:

- `svg`: the complete 1024×1024 inline SVG (port the current `main` artwork);
- `description`: the existing English prompt, retained as design intent and as
  the input to a possible future generator, but never invoked during a normal
  build;
- `backgroundColor` and `themeColor` (initially choose one canonical value; see
  the color question below);
- stable app metadata used by the manifest: name, short name, and description;
- an output specification (route/file name, media type, dimensions, and
  regular/maskable purpose), so the generator and manifest cannot acquire
  separate hand-maintained icon lists.

Inline SVG should remain authoritative. If prompt-based generation is added
later, make it an explicit, opt-in command that replaces/reviews the `svg`
field; do not call a model during ordinary builds. This preserves deterministic,
offline builds and keeps generated artwork changes visible in code review.

## Exact derived outputs and consumers

Generate these into `example-lifelog/public/icons/`:

| Output | Derivation | Consumer |
| --- | --- | --- |
| `favicon.svg` | exact canonical SVG | `<link rel="icon" type="image/svg+xml">` and manifest `any` icon |
| `favicon.ico` | ICO container holding 16, 32, and 48 px PNG renders | legacy `/favicon.ico` requests and fallback `<link rel="icon">` |
| `apple-touch-icon.png` | 180×180 opaque, safe-area render | Apple touch link |
| `icon-192.png` | 192×192 regular render | web manifest |
| `icon-512.png` | 512×512 regular render | web manifest |
| `icon-maskable-192.png` | 192×192 opaque-background safe-zone render | web manifest, purpose `maskable` |
| `icon-maskable-512.png` | 512×512 opaque-background safe-zone render | web manifest, purpose `maskable` |
| `expo-icon.png` | 1024×1024 opaque regular render | Expo top-level/iOS icon |
| `expo-adaptive-foreground.png` | 1024×1024 transparent foreground with Android safe-zone padding | Expo Android adaptive foreground |

Also generate `example-lifelog/public/manifest.webmanifest` from the same module.
It should contain `id: "/"`, `start_url: "/"`, `scope: "/"`, `display:
"standalone"`, the canonical name/description/colors, and exactly the SVG,
192/512 regular, and 192/512 maskable entries. Do not include the ICO, Apple
touch icon, or Expo-only files in the manifest.

The shared HTML `Layout` should add links for `/manifest.webmanifest`,
`/favicon.svg`, `/favicon.ico`, and `/apple-touch-icon.png`, plus a theme-color
meta tag sourced from `app-icon.ts`. Because every page uses `Layout`, this
covers the SPA and journal/pending pages. The three small authorization HTML
strings in `main.ts` bypass `Layout`; leave them alone unless product behavior
requires install metadata on administrative pages.

`example-lifelog/main.ts` should expose an explicit allowlist of generated icon
routes and the manifest with correct content types and public cache headers.
Keep the allowlist rather than adding a general static server. The manifest can
use `no-cache`; versionless icon paths should use revalidation (for example
`public, max-age=0, must-revalidate`) rather than `immutable`. Add these paths to
the auth bypass so user agents can fetch install metadata before an authenticated
page session. Confirm this exposure matches the intended private-deployment
boundary before implementation.

## Build-time generation on `effect-rethink`

1. Add `@resvg/resvg-js` to dependencies and the lockfile. Use it from a small
   `scripts/generate-app-icons.ts`; this is portable and matches the proven
   renderer on `main` rather than relying on this VM's system ImageMagick.
2. Have the script import `example-lifelog/app-icon.ts`, create the ignored
   output directory, write the SVG and manifest, and rasterize the requested
   PNG sizes. Construct the ICO deterministically in the same script from
   16/32/48 PNG buffers; the ICO format can embed PNG payloads, so this needs a
   small encoder and no second image package.
3. For maskable and adaptive outputs, do not blindly scale the rounded-square
   source as `main` currently does. Define a simple SVG composition helper that
   separates the background from foreground artwork and keeps foreground inside
   the maskable safe zone. Ideally split the canonical module into background
   and foreground SVG fragments once; otherwise document and test the inset.
4. Add `build:icons`, and preferably one aggregate `build` command that runs
   icons, client, and CLI. Make both `dev` and `start` run that aggregate before
   launching. Keep watch mode simple: icon edits require restarting `dev` unless
   actual demand justifies another watcher.
5. Keep `example-lifelog/public/` ignored, so all web icon outputs remain build
   artifacts. Add a focused generator test (temporary output directory), HTML
   head assertions, and route tests for status/content type. Validate PNG
   dimensions, required manifest entries, and ICO magic/directory sizes. A
   clean-clone acceptance check is `bun install`, aggregate build, typecheck,
   tests, then HTTP requests for every declared route.

This is intentionally smaller than porting `main`'s `lib/image.ts`: one source
module, one deterministic build script, explicit routes, and no bucket or model
dependency at runtime.

## Expo integration when reconciling with `main`

There is no Expo tree on `effect-rethink`, so this branch should not add a
placeholder `expo/` merely for icons. When the Expo app is brought across, make
these follow-up changes in the same integration:

- Replace static icon fields in `expo/app.json` with `expo/app.config.js`
  fields pointing at the generated `expo-icon.png` and
  `expo-adaptive-foreground.png`; set adaptive `backgroundColor` from the
  canonical module rather than retaining a second literal. Preserve the
  existing revision metadata logic.
- Ensure `build:app`, local native prebuild/build commands, and EAS all run
  `build:icons` before Expo evaluates the config. An EAS build must receive the
  generated assets: adjust `expo/.easignore` to include the two generated Expo
  outputs (and any canonical/script inputs needed by an EAS-side hook), or run
  generation before archive creation and explicitly unignore the outputs.
  Verify this with `eas build:inspect`; ignored local files silently missing
  from the archive is the main failure mode.
- Stop tracking the four hand-maintained `expo/assets/icon*` /
  `apple-touch-icon.png` files and the exported `static/app/favicon.ico` once
  every config/build consumer points at generated paths. Do not remove other
  checked-in Expo web-export assets as part of this focused change.
- If Expo requires icon files to live inside `expo/`, let the generator emit
  ignored copies under `expo/.generated/icons/`; they still derive from the
  same module. Path-local duplication at build time is acceptable, while
  duplicate source assets in git are not.

## Open questions and decisions

1. **Canonical color.** The SVG background starts at `#1e1b4b` and ends at
   teal, while `main` uses `#0f172a` for theme, PWA background, and Android
   adaptive background. Recommendation: keep `themeColor: #0f172a` for browser
   chrome and define `backgroundColor` explicitly for maskable/Android use;
   make both fields canonical even if they differ.
2. **Maskable composition.** `main` wraps the complete rounded-square icon in a
   10% inset over a flat background, which can produce a visible tile inside
   the OS mask. Recommendation: expose background and foreground layers in the
   canonical module and render the adaptive/maskable variants from those
   layers. This is a little more definition code but gives correct platform
   semantics.
3. **ICO support.** Modern browsers prefer SVG, but `/favicon.ico` remains a
   useful zero-surprise compatibility path. Recommendation: generate the small
   multi-size ICO; if the project wants absolute minimalism, omit only the ICO
   and keep the SVG link, rather than checking in an unrelated ICO.
4. **Expo config format.** JSON cannot import TypeScript or colors. Recommendation:
   consolidate icon-related Expo settings in `app.config.js`; keep static
   non-icon fields in `app.json` if desired. The generator, not Expo config,
   should do rendering.
5. **Manifest ownership.** A generated static manifest is simplest on
   `effect-rethink`, whose app name is fixed. If per-instance names return as on
   `main`, keep the icon array/colors exported from the canonical module but
   construct the name-bearing manifest response dynamically.
6. **Public routes under auth.** Favicons are harmless brand assets and browser
   fetches are more reliable without auth, matching `main`'s public mounting.
   Confirm that leaking the Medina name/artwork on a private host is acceptable.

## Implementation sequence

1. Add the canonical module and generator dependency/script; generate and test
   all files in a temporary directory.
2. Add package scripts and ignored-output behavior; prove a clean build creates
   every artifact without modifying tracked files.
3. Add the explicit server routes/auth exceptions and shared `Layout` metadata,
   with route and rendered-HTML tests.
4. Run typecheck/tests and manually inspect regular, maskable, Apple, and 16 px
   renders before accepting the artwork pipeline.
5. During the later Expo/main reconciliation, repoint Expo config/build/EAS,
   verify the build archive, and only then delete the tracked duplicate assets.
