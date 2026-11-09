import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Medina's Cloudflare infrastructure, declared as an Alchemy stack —
// the same standard path as the hskping repo's alchemy.run.ts.
//
// Milestone 1 (docs/cloudflare-migration.md §4): one Worker serving
// the public device routes — GET /health, GET
// /api/capture-policy/<token>, GET /bucket-capture/<stamp>.apk — from
// the canonical artifact bucket. This is a proof of the deployment
// path, additively deployed on its own stage-scoped name. Nothing
// live points at it; medina-dev and the medina-index Worker keep
// serving production.
//
// Milestone 2 (§3 phase 1, the shadow ingest): the same Worker gets a
// minutely Cron Trigger, a read binding to the capture source bucket
// (sco-lifelog-in), and the ShadowDiscovery Durable Object (SQLite).
// Every minute it lists the source bucket, classifies objects exactly
// as the medina-dev capture sources do, and records first sightings
// in the DO — discover-only: it downloads nothing, writes to no
// bucket, and submits nothing to any provider.
//
// The buckets are ADOPTED, not owned: sco-lifelog and sco-lifelog-in
// both predate this stack (sco-lifelog is Medina's canonical artifact
// bucket, written by the Medina server; sco-lifelog-in is the capture
// app's upload bucket) and must outlive it. The stack declares them
// only so the Worker gets its R2 bindings. NEVER run
// `alchemy destroy` against a stage of this stack without first
// removing these resources — destroy would try to delete them.
//
// Secrets are declared in this stack as Secrets Store resources
// (Scott's direction, Nov 2: everything Alchemy-declared, nothing
// out-of-band). A secret's value is supplied to the deploy through the
// environment as a Redacted — never a literal in this repo — and the
// binding is read in the Worker via .get(). A deploy that lacks a
// required value fails loudly below rather than reconciling a secret
// to an empty value.
//
// State lives in Alchemy's encrypted remote state store for
// Cloudflare (a Worker backed by a Durable Object, credentials in the
// account Secrets Store, state encrypted at rest) — Scott's call,
// Nov 9, 2026, so more than one machine can deploy this stack
// against the same record. It was local files before (`.alchemy/` in
// this directory) because the deploy token then lacked the Secrets
// Store permissions the remote store needs; the Nov 9 switch was
// gated on a backup of the local state plus a clean plan against the
// remote store before any deploy (see docs/cloudflare-migration.md).
// The account is pinned by the deploy environment
// (CLOUDFLARE_ACCOUNT_ID), and `.alchemy/` is now just local cache.

export const Artifacts = Cloudflare.R2.Bucket("Artifacts", {
  name: "sco-lifelog",
}).pipe(adopt(true));

// The capture app's upload bucket — the pipeline's read-only source
// on medina-dev. The shadow only ever lists it through this binding.
export const CaptureIn = Cloudflare.R2.Bucket("CaptureIn", {
  name: "sco-lifelog-in",
}).pipe(adopt(true));

// INDEX_API_TOKEN: the Bearer credential for the medina-index index
// API — the same token medina-dev presents when it registers
// artifacts and medina-index checks on every call (§4.3). The Worker
// needs it to read the index for the capture shadow's diff (and, at
// the step-2 cutover, to register what it ingests). The value is the
// existing shared token, supplied via the deploy environment; it is
// never written in this repo. The store is the account's one Secrets
// Store (default_secrets_store, the same store hskping uses),
// referenced by id: the Secret resource takes plain store ids.
const indexApiToken = process.env.INDEX_API_TOKEN;
if (indexApiToken === undefined || indexApiToken === "") {
  throw new Error(
    "INDEX_API_TOKEN is not set in the deploy environment: the " +
      "medina-index token (the one medina-dev and medina-index " +
      "already share) must be supplied to declare its Secrets Store " +
      "binding — see docs/cloudflare-migration.md §4.3 step 2.",
  );
}
export const IndexApiToken = Cloudflare.SecretsStore.Secret(
  "IndexApiToken",
  {
    store: {
      storeId: "8c3b7231cb714944a163e017ceecfac4",
      accountId: "22e64798cbb760891764f349b53f573a",
    },
    name: "INDEX_API_TOKEN",
    value: Redacted.make(indexApiToken),
    scopes: ["workers"],
  },
);

// The media stages' vendor credentials — ASSEMBLYAI_API_KEY
// (§4.3 step 6) and TRANSLOADIT_API_KEY (§4.3 step 5) — are
// deliberately NOT declared as Secret resources, and never will
// be in that shape:
//
// A Secrets Store Secret resource reconciles its value FROM the
// deploy environment: Alchemy patches the stored value to match
// whatever the deploy supplies. That is safe for the index token
// above because the deployer holds its value. It is NOT safe for
// these two:
//
//   - TRANSLOADIT_API_KEY: Scott created a NEW scoped key
//     ("cloudflare": assemblies read+write only) on Nov 2 and
//     placed its value in the Secrets Store. That value exists
//     only in the store and Scott's own records; declaring the
//     resource with medina-dev's legacy key would silently
//     overwrite the scoped key in the store.
//   - ASSEMBLYAI_API_KEY: medina-dev never held this key at all —
//     its calls go through the exe.dev proxy
//     (assemblyai.int.exe.xyz), which injects it. The only copies
//     are the Secrets Store entry Scott created Nov 2 and his own
//     records.
//
// The mechanism instead (Scott confirmed the stored keys and said
// "flip it live", Nov 3): the two keys are bound to the Worker
// OUT-OF-BAND as `secrets_store_secret` bindings referencing the
// existing store secrets by name — the hskping pattern. Alchemy
// beta.83 cannot declare a binding against a pre-existing store
// secret without managing its value (ReadSecret still requires a
// Secret resource), and a deploy reconciles the Worker's settings
// and strips undeclared bindings — so scripts/reattach-secrets.ts
// re-attaches and asserts both bindings as the second half of
// every `bun run deploy:dev`. The Worker code reads both bindings
// optionally; GET /transcribe/verify and GET /normalize/verify
// resolve them and make one authenticated read-only vendor call
// each (the flip gate — verified live Nov 3, §4.3 steps 5–6).

// Milestone 4: the Worker bundle imports the repo's own schema
// modules (lib/lifelog/JournalApi.ts and friends), which resolve
// `effect` to the repo-root install (4.0.0) while this package pins
// effect 4.0.5. Two copies of effect in one bundle break the RPC
// codec's class handling (a 4.0.0 DayRow encodes as a defect
// through the 4.0.5 JSON codec), so every `effect` / `effect/*`
// specifier — from any importer — is aliased to this package's
// single copy, via the build.input.resolve.alias mechanism
// Alchemy documents for module replacement. Subpaths land on the
// dist tree the package's exports map points at; the resolver
// supplies the .js extension.
const effectDist = [
  fileURLToPath(new URL("./node_modules/effect/dist", import.meta.url)),
  join(process.cwd(), "node_modules/effect/dist"),
].find((dir) => existsSync(join(dir, "index.js")));
if (effectDist === undefined) {
  throw new Error("cannot locate this package's effect/dist for bundling");
}

export const Api = Cloudflare.Worker("Api", {
  main: "./src/worker.ts",
  compatibility: { date: "2026-10-13", flags: ["nodejs_compat"] },
  build: {
    // The analyzer output is the parity evidence that the bundle
    // carries exactly one copy of effect (see §4.3).
    bundleAnalyzer: true,
    input: {
      resolve: {
        alias: {
          // Exact-match key for the bare specifier; the prefix
          // key rewrites every effect/* subpath onto the dist
          // tree (the resolver supplies the .js extension).
          "effect$": join(effectDist, "index.js"),
          effect: effectDist,
        },
      },
    },
  },
  // No explicit `name`: Alchemy derives a stage-scoped physical name
  // (stage dev produced medina-api-dev-<suffix>), which cannot collide
  // with the hand-made `medina*` workers already in the account or
  // with the medina-index Worker. The workers.dev URL is the point of
  // this milestone, so it stays enabled.
  workersDev: true,
  // Milestone 2: the shadow discovery pass runs every minute (the
  // finest cron grain, matching the medina-dev capture loop).
  crons: ["* * * * *"],
  env: {
    ARTIFACTS: Artifacts,
    CAPTURE_IN: CaptureIn,
    ShadowDiscovery: Cloudflare.DurableObject("ShadowDiscovery"),
    // Milestone 4 step 2: the capture-loop shadow's notebook and the
    // index credential its diff reads through.
    CaptureShadow: Cloudflare.DurableObject("CaptureShadow"),
    INDEX_API_TOKEN: IndexApiToken,
    // Milestone 4 step 2 cutover: the capture loop's mode. "shadow"
    // (the step-2 build) plans and diffs only; "live" performs the
    // plans on this Worker and medina-dev's capture loop stands down
    // (MEDINA_SOURCES without "capture"). Rolling back the stage is
    // flipping this back to "shadow", redeploying, and re-enabling
    // medina-dev's capture loop in the same batch.
    CAPTURE_LOOP_MODE: "live",
    // Milestone 4 steps 3–4: the star detector's and archive
    // sweep's notebooks and modes, same pattern as step 2 — "shadow"
    // plans and diffs only; "live" performs, with medina-dev's
    // corresponding stage standing down in the same batch
    // (MEDINA_SOURCES without "stars" / "archive"). Rolling a stage
    // back is flipping its mode to "shadow", redeploying, and
    // re-enabling the stage on medina-dev.
    StarsShadow: Cloudflare.DurableObject("StarsShadow"),
    ArchiveShadow: Cloudflare.DurableObject("ArchiveShadow"),
    STAR_DETECTOR_MODE: "live",
    ARCHIVE_SWEEP_MODE: "live",
    // Milestone 4 steps 5–6: the media stages' notebooks, modes,
    // and credentials, same pattern as steps 2–4 — "shadow" plans
    // and diffs only; "live" performs, with medina-dev's
    // corresponding stage standing down in the same batch
    // (MEDINA_SOURCES without "normalize" / "transcribe").
    NormalizeShadow: Cloudflare.DurableObject("NormalizeShadow"),
    TranscribeShadow: Cloudflare.DurableObject("TranscribeShadow"),
    // Milestone 4 step 7: the GPS stages' notebook and mode, same
    // pattern as steps 2–6 — "shadow" (the step-7 build) checks
    // medina-dev's compaction and stays without performing;
    // "live" performs, with medina-dev's gps-compact / gps-stays
    // stages standing down in the same batch (MEDINA_SOURCES
    // without them). Rolling back is flipping this to "shadow",
    // redeploying, and re-enabling the stages on medina-dev.
    GpsShadow: Cloudflare.DurableObject("GpsShadow"),
    GPS_MODE: "shadow",
    // Milestone 4 step 8 (day-index piece): the day-index
    // resource's notebook and mode, same pattern — "shadow"
    // computes the corpus basis and compares medina-dev's
    // snapshot without writing; "live" writes the snapshot and
    // the attribution artifacts it computes, with medina-dev's
    // attribution + day-index resources standing down in the
    // same batch (MEDINA_SOURCES without "attribution" /
    // "day-index"). HOME_TZ must match medina-dev's: the zone
    // participates in both bases.
    DayIndexShadow: Cloudflare.DurableObject("DayIndexShadow"),
    DAYINDEX_MODE: "shadow",
    HOME_TZ: "America/Los_Angeles",
    // The media stages presign R2 URLs and mint temporary R2
    // credentials — impossible with the native R2 binding — so
    // the Worker needs an S3 keypair for sco-lifelog, delivered
    // as the ARTIFACTS_S3 secret binding (see src/r2creds.ts).
    // The first attempt declared it as
    // Cloudflare.R2.S3Credentials(Artifacts, {access:"read-write"}),
    // which has Alchemy mint a bucket-scoped account API token at
    // deploy time — but the Nov 3 deploy FAILED: the deploy
    // credential is not authorized to create account API tokens
    // ("Unauthorized to access requested resource" on the
    // ApiToken resource). The fallback — reuse a keypair
    // medina-dev already holds — was inventoried Nov 3 and does
    // not exist: the server's sco-lifelog access is edge-injected
    // (endpoint sco-lifelog.int.exe.xyz, no keypair in its
    // environment at all), and the one raw S3 keypair on the box
    // (SOURCE_BUCKET_*, for the capture source) is scoped to
    // sco-lifelog-in only — an in-place probe got AccessDenied on
    // sco-lifelog list and write. RESOLVED Nov 6 by path (b):
    // Scott created a bucket-scoped R2 API token for sco-lifelog
    // (Account API, Object Read & Write) and placed its keypair in
    // the Secrets Store as ARTIFACTS_S3_ACCESS_KEY_ID and
    // ARTIFACTS_S3_SECRET_ACCESS_KEY. Like the vendor keys, the
    // pair is attached out-of-band by scripts/reattach-secrets.ts
    // (never declared here — a Secret resource would reconcile
    // the stored value from the deploy environment), and
    // src/worker.ts composes the two into the ARTIFACTS_S3 JSON
    // value the stages parse (resolveArtifactsS3). Each stage's
    // perform path needs it — normalize to presign the import and
    // mint the store credentials, transcribe to presign chunk
    // URLs for AssemblyAI.
    NORMALIZE_MODE: "live",
    TRANSCRIBE_MODE: "live",
  },
});

export default Alchemy.Stack(
  "Medina",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Api;
    return { url: worker.url };
  }),
);
