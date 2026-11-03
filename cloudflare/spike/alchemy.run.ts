/**
 * THROWAWAY Alchemy stack for the @yielded/auth WASM spike.
 *
 * Mirrors the medina-api Worker's build configuration in
 * ../alchemy.run.ts (same compatibility date + nodejs_compat flag,
 * same single-effect-copy aliasing, bundle analyzer on) so the spike
 * proves the production build path, not a side channel. Deployed on
 * its own stack/stage (MedinaAuthSpike / spike) with a stage-scoped
 * physical name — it can never collide with medina-api-dev.
 */
import * as Alchemy from "alchemy";
import { localState } from "alchemy/State";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const effectDist = [
  fileURLToPath(new URL("../node_modules/effect/dist", import.meta.url)),
  join(process.cwd(), "../node_modules/effect/dist"),
].find((dir) => existsSync(join(dir, "index.js")));
if (effectDist === undefined) {
  throw new Error("cannot locate the cloudflare package's effect/dist");
}

export const Spike = Cloudflare.Worker("Spike", {
  main: "./worker.ts",
  compatibility: { date: "2026-10-13", flags: ["nodejs_compat"] },
  build: {
    bundleAnalyzer: true,
    input: {
      resolve: {
        alias: {
          "effect$": join(effectDist, "index.js"),
          effect: effectDist,
        },
      },
    },
  },
  workersDev: true,
});

export default Alchemy.Stack(
  "MedinaAuthSpike",
  {
    providers: Cloudflare.providers(),
    state: localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Spike;
    return { url: worker.url };
  }),
);
