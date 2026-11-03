import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import { localState } from "alchemy/State";
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
// State is local (`.alchemy/` in this directory, committed with the
// code), matching hskping: the remote state store needs Secrets Store
// permissions the deploy token doesn't have.

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
  },
});

export default Alchemy.Stack(
  "Medina",
  {
    providers: Cloudflare.providers(),
    state: localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Api;
    return { url: worker.url };
  }),
);
