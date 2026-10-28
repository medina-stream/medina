import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import { localState } from "alchemy/State";
import * as Effect from "effect/Effect";

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
// The bucket is ADOPTED, not owned: sco-lifelog predates this stack
// (it is Medina's canonical artifact bucket, written by the Medina
// server) and must outlive it. The stack declares it only so the
// Worker gets its R2 binding. NEVER run `alchemy destroy` against a
// stage of this stack without first removing this resource — destroy
// would try to delete the canonical bucket.
//
// The Worker's secrets (provider keys, when the pipeline lands here)
// are NOT declared in this stack, per the hskping Path B precedent:
// they will be Secrets Store bindings attached out-of-band, read via
// .get(), so values never enter Alchemy state.
//
// State is local (`.alchemy/` in this directory, committed with the
// code), matching hskping: the remote state store needs Secrets Store
// permissions the deploy token doesn't have.

export const Artifacts = Cloudflare.R2.Bucket("Artifacts", {
  name: "sco-lifelog",
}).pipe(adopt(true));

export const Api = Cloudflare.Worker("Api", {
  main: "./src/worker.ts",
  compatibility: { date: "2026-10-13" },
  // No explicit `name`: Alchemy derives a stage-scoped physical name
  // (stage dev produced medina-api-dev-<suffix>), which cannot collide
  // with the hand-made `medina*` workers already in the account or
  // with the medina-index Worker. The workers.dev URL is the point of
  // this milestone, so it stays enabled.
  workersDev: true,
  env: {
    ARTIFACTS: Artifacts,
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
