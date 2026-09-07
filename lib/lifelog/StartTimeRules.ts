/**
 * The start-time rules an application supplies.
 *
 * `lib/` holds the heuristics that have been observed to work generally
 * (`defaultStartTimeRules`); this service is where one person's corpus adds
 * what only they know: a recorder that names files differently, a device
 * whose container stamps the start rather than the end, a trip where the
 * wall clock was in another zone, a phone with a known clock skew.
 *
 * Three properties make this safe to iterate on:
 *
 * - **Rules never touch evidence.** They are inputs to derivation, so a bad
 *   rule is undone by deleting it, not by repairing stored files.
 * - **Rules are hashed into the attribution basis.** Editing them re-derives
 *   exactly the captures they affect, automatically.
 * - **Rules match on what sources recorded** -- source name, filename, a
 *   date range -- never on derived output, so they keep meaning the same
 *   thing as derivation improves.
 *
 * For a single capture that is simply wrong, prefer a correction file
 * (`correction/<captureId>.json`): a rule generalizes, a correction states.
 */
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import { defaultStartTimeRules, type StartTimeRules } from "./StartTime.ts"

export class StartTimeRulesService extends Context.Service<StartTimeRulesService, StartTimeRules>()(
  "medina/lifelog/StartTimeRules"
) {}

/** Medina's defaults, with no application knowledge. */
export const layerDefault: Layer.Layer<StartTimeRulesService> = Layer.succeed(StartTimeRulesService)(
  defaultStartTimeRules
)

/**
 * The defaults extended with an application's own rules and patterns.
 *
 * Application patterns are tried *before* the defaults, so a local format
 * can take precedence over a general one that would also match.
 */
export const layer = (
  overrides: {
    readonly filenamePatterns?: StartTimeRules["filenamePatterns"]
    readonly container?: StartTimeRules["container"]
    readonly agreementWindowSeconds?: number
    readonly rules?: StartTimeRules["rules"]
  }
): Layer.Layer<StartTimeRulesService> =>
  Layer.succeed(StartTimeRulesService)({
    filenamePatterns: [
      ...(overrides.filenamePatterns ?? []),
      ...defaultStartTimeRules.filenamePatterns
    ],
    container: overrides.container ?? defaultStartTimeRules.container,
    agreementWindowSeconds: overrides.agreementWindowSeconds
      ?? defaultStartTimeRules.agreementWindowSeconds,
    rules: [...defaultStartTimeRules.rules, ...(overrides.rules ?? [])]
  })
