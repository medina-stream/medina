/**
 * This lifelog's own start-time knowledge.
 *
 * `lib/lifelog/StartTime.ts` holds the general heuristics; this file holds
 * what is true of *this* archive and nowhere else. It is meant to be edited
 * as messy inputs turn up, and it is safe to edit because:
 *
 * - rules are inputs to derivation, never writes to evidence, so a mistake
 *   is undone by deleting a few lines;
 * - they are hashed into the attribution basis, so saving re-derives exactly
 *   the captures affected and leaves the rest alone;
 * - they match on what the sources recorded -- source name, filename, a date
 *   range -- so they keep meaning the same thing as derivation improves.
 *
 * Reach for a rule when a *class* of captures is wrong. For one capture that
 * is simply wrong, write a correction file instead
 * (`correction/<captureId>.json`): a rule generalizes, a correction states.
 *
 * Nothing here is required. An empty `rules` list is the honest starting
 * point, and the defaults already handle this corpus.
 */
import * as StartTimeRules from "../lib/lifelog/StartTimeRules.ts"

export const StartTimeHintsLive = StartTimeRules.layer({
  /**
   * Filename formats this archive uses, tried before the library defaults.
   *
   * The recorder writes `sco-lifelog-020260907T110112.m4a`: a `0` prefix,
   * then the compact local stamp. The library already recognizes that shape,
   * so this is here as the place to add the next recorder's format rather
   * than because it is needed today.
   */
  filenamePatterns: [],

  /**
   * Per-class fixes and hints.
   *
   * Examples of what belongs here, kept as comments until a real case
   * arrives -- an invented rule is worse than none, because it silently
   * moves timestamps:
   *
   * ```ts
   * // A recorder whose container stamps the start, not the end.
   * {
   *   name: "olympus-stamps-start",
   *   filename: /^DS\d{6}/,
   *   container: "start",
   *   note: "DS-series writes creation_time at record-press"
   * },
   *
   * // A trip: the wall clock in these filenames was Berlin time.
   * {
   *   name: "berlin-trip-2025",
   *   from: "2025-06-14",
   *   until: "2025-06-29",
   *   zone: "Europe/Berlin",
   *   note: "phone stayed on local time all week"
   * },
   *
   * // A device whose clock ran fast until it was reset.
   * {
   *   name: "old-phone-clock-skew",
   *   source: /^easy-voice$/,
   *   until: "2024-03-01",
   *   shiftSeconds: -1_800,
   *   note: "clock ran 30m fast; confirmed against three GPS fixes"
   * }
   * ```
   */
  rules: []
})
