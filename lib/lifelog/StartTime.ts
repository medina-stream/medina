/**
 * Deciding when a recording started, from disagreeing evidence.
 *
 * Three kinds of clue, and none is reliable alone:
 *
 * - **Filename stamp** (`...020260903T140436...`) is usually the recorder
 *   pressing record: exact, but zone-less, and absent from much of an
 *   archive. Recorders also change their naming over time, so the patterns
 *   are a list rather than one regex.
 * - **Container `mvhd`** carries a real UTC instant plus the encoded
 *   duration. What that instant *means* is a per-recorder convention: on the
 *   Android recorder here it is when recording stopped, so the start is
 *   creation minus duration. Another device may stamp the start instead.
 * - **Source modified time** is upload time -- observed hours late on this
 *   corpus. A last resort, not evidence.
 *
 * Measured on 32 real recordings: container-derived starts agreed with the
 * filename stamp within 2s on 31, and were 888s later on one that had
 * evidently been paused. So the two corroborate, and where they disagree the
 * *earlier* is the record-press.
 *
 * ## Rules, not hard-coding
 *
 * Every judgement above is a `StartTimeRules` field with a sensible default
 * in `defaultStartTimeRules`. An application layers its own knowledge on top
 * -- a new filename format, a recorder with the opposite container
 * convention, a trip where the wall clock was another zone -- by providing
 * `StartTimeRules` (see `lib/lifelog/StartTimeRules.ts`). Rules are *inputs
 * to derivation*, hashed into the attribution basis, so editing them
 * re-derives affected captures and never edits stored evidence.
 *
 * This module is pure: callers gather evidence, this decides. That keeps the
 * policy testable and the IO out of it.
 */

/** How much filename/container disagreement still counts as corroboration. */
export const AGREEMENT_WINDOW_SECONDS = 120

/**
 * What a container's creation instant means for a given recorder.
 *
 * - `end`: recording stopped then; start is creation minus duration.
 * - `start`: recording began then; used as-is.
 * - `ignore`: the recorder's metadata is not trustworthy.
 */
export type ContainerConvention = "end" | "start" | "ignore"

/**
 * A filename time stamp format. `pattern` must capture six groups in
 * year, month, day, hour, minute, second order.
 */
export interface FilenamePattern {
  /** Named so a decision can say which format matched. */
  readonly name: string
  readonly pattern: RegExp
  /**
   * The zone the recorder stamps in, when it is known to be fixed (some
   * devices always stamp UTC). Unset means the believed local zone.
   */
  readonly zone?: string
}

/**
 * An adjustment applied to captures matching some evidence.
 *
 * Matching is on evidence the source recorded -- its name, the filename --
 * never on derived output, so a hint keeps working as derivation changes.
 */
export interface SourceRule {
  readonly name: string
  /** Matched against the source name, e.g. `easy-voice`. */
  readonly source?: RegExp
  /** Matched against the original filename. */
  readonly filename?: RegExp
  /** Only captures whose derived start falls in `[from, until)` (ISO days). */
  readonly from?: string
  readonly until?: string
  /** Overrides the container convention for matching captures. */
  readonly container?: ContainerConvention
  /** Overrides the zone that zone-less stamps are interpreted in. */
  readonly zone?: string
  /** Shifts the decided instant by this many seconds (a known clock skew). */
  readonly shiftSeconds?: number
  /** Why this rule exists; surfaced in the attribution record. */
  readonly note?: string
}

export interface StartTimeRules {
  /** Tried in order; the first match wins. */
  readonly filenamePatterns: ReadonlyArray<FilenamePattern>
  /** Applied when no rule overrides it. */
  readonly container: ContainerConvention
  readonly agreementWindowSeconds: number
  /** Layered over the defaults; later rules win. */
  readonly rules: ReadonlyArray<SourceRule>
}

/**
 * Medina's defaults: what has been observed to work, with no application
 * knowledge baked in.
 *
 * The patterns are ordered most- to least-specific. The bare `YYYYMMDDThhmmss`
 * scan is last because it also matches inside the others.
 */
export const defaultStartTimeRules: StartTimeRules = {
  filenamePatterns: [
    // Medina's recorder: a `0` prefix then the compact stamp.
    { name: "medina-0-prefixed", pattern: /0(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/ },
    // Common phone recorders: `2026-09-03 14.04.36` or with dashes/colons.
    { name: "dated-separators", pattern: /(\d{4})[-_](\d{2})[-_](\d{2})[ T_](\d{2})[.:_-](\d{2})[.:_-](\d{2})/ },
    // ISO basic, anywhere in the name.
    { name: "iso-basic", pattern: /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/ }
  ],
  container: "end",
  agreementWindowSeconds: AGREEMENT_WINDOW_SECONDS,
  rules: []
}

export type StartMethod =
  | "filename-and-container"
  | "container-mvhd"
  | "filename-stamp"
  | "modified-time"
  | "none"

export type StartConfidence = "high" | "medium" | "low" | "none"

/** What the sources recorded, before interpretation. */
export interface StartEvidence {
  /** Source name, e.g. `easy-voice`. Matched by rules. */
  readonly source: string | null
  readonly filename: string | null
  /** Container creation instant (UTC) and encoded duration, if probed. */
  readonly containerCreatedAt: string | null
  readonly containerDurationSeconds: number | null
  /** A naive local wall clock recorded by a legacy path, if any. */
  readonly legacyWallClock: string | null
  /** The source's modified time (a UTC instant), if any. */
  readonly modifiedAt: string | null
  /** The believed local zone, before any rule overrides it. */
  readonly zone: string
  /** Wall clock -> UTC in a zone; supplied so this module stays pure. */
  readonly toUtc: (wallClock: string, zone: string) => string | null
}

export interface StartDecision {
  readonly startUtc: string | null
  readonly method: StartMethod
  readonly confidence: StartConfidence
  /** The zone the decision was made in, after rules. */
  readonly zone: string
  /** Seconds between filename and container, when both were present. */
  readonly disagreementSeconds: number | null
  /** Which filename pattern matched, if any. */
  readonly filenamePattern: string | null
  /** Names of the rules that applied, in order. */
  readonly appliedRules: ReadonlyArray<string>
}

/** The naive local wall clock a filename claims, and which pattern found it. */
export const matchFilenameStamp = (
  filename: string,
  patterns: ReadonlyArray<FilenamePattern>
): { wallClock: string; pattern: FilenamePattern } | null => {
  for (const pattern of patterns) {
    const found = filename.match(pattern.pattern)
    if (!found) continue
    const [, year, month, day, hour, minute, second] = found
    if (!year || !month || !day || !hour || !minute || !second) continue
    const wallClock = `${year}-${month}-${day}T${hour}:${minute}:${second}`
    // A pattern can match digits that are not a date; reject those rather
    // than dating a capture to month 47.
    if (Number.isNaN(Date.parse(`${wallClock}Z`))) continue
    return { wallClock, pattern }
  }
  return null
}

const seconds = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 1000

/** Rules matching this capture's evidence, in declaration order. */
const matching = (rules: ReadonlyArray<SourceRule>, evidence: StartEvidence, probeUtc: string | null) =>
  rules.filter((rule) => {
    if (rule.source && !(evidence.source && rule.source.test(evidence.source))) return false
    if (rule.filename && !(evidence.filename && rule.filename.test(evidence.filename))) return false
    // Date bounds compare against the best instant available before rules,
    // so a rule can be scoped to a trip without depending on its own output.
    if (rule.from || rule.until) {
      if (!probeUtc) return false
      const day = probeUtc.slice(0, 10)
      if (rule.from && day < rule.from) return false
      if (rule.until && day >= rule.until) return false
    }
    return true
  })

/**
 * The best available start time, under `rules`.
 *
 * Corroborated evidence wins; then the container (an absolute instant beats
 * a zone-less guess); then the filename; then modified time, which is
 * really "we do not know".
 *
 * Where filename and container disagree, the earlier is taken: the encoded
 * duration excludes pauses, so a paused recording makes the container start
 * too late, and nothing observed makes it too early.
 */
export const decideStart = (
  evidence: StartEvidence,
  rules: StartTimeRules = defaultStartTimeRules
): StartDecision => {
  const stamp = evidence.filename
    ? matchFilenameStamp(evidence.filename, rules.filenamePatterns)
    : null

  // A provisional instant for date-scoped rule matching: whatever the
  // evidence says before any rule has been applied.
  const provisional = evidence.containerCreatedAt
    ?? (stamp ? evidence.toUtc(stamp.wallClock, evidence.zone) : null)
    ?? evidence.modifiedAt

  const applied = matching(rules.rules, evidence, provisional)
  const last = <A>(pick: (rule: SourceRule) => A | undefined): A | undefined => {
    for (let index = applied.length - 1; index >= 0; index--) {
      const value = pick(applied[index]!)
      if (value !== undefined) return value
    }
    return undefined
  }

  const convention = last((rule) => rule.container) ?? rules.container
  // A rule's zone beats the believed zone; a pattern's fixed zone beats
  // both, since it is a property of the format rather than a guess.
  const ruleZone = last((rule) => rule.zone) ?? evidence.zone
  const zone = stamp?.pattern.zone ?? ruleZone
  const shift = applied.reduce((total, rule) => total + (rule.shiftSeconds ?? 0), 0)
  const appliedRules = applied.map((rule) => rule.name)

  const containerStartUtc = (() => {
    if (convention === "ignore" || !evidence.containerCreatedAt) return null
    if (convention === "start") return evidence.containerCreatedAt
    if (evidence.containerDurationSeconds === null) return null
    const end = Date.parse(evidence.containerCreatedAt)
    if (Number.isNaN(end)) return null
    return new Date(end - evidence.containerDurationSeconds * 1000).toISOString()
  })()

  const wallClock = stamp?.wallClock ?? evidence.legacyWallClock
  const filenameUtc = wallClock ? evidence.toUtc(wallClock, zone) : null

  const shifted = (iso: string) =>
    shift === 0 ? iso : new Date(Date.parse(iso) + shift * 1000).toISOString()

  const decide = (): Omit<StartDecision, "zone" | "filenamePattern" | "appliedRules"> => {
    if (filenameUtc && containerStartUtc) {
      const gap = seconds(filenameUtc, containerStartUtc)
      if (gap <= rules.agreementWindowSeconds) {
        return {
          startUtc: filenameUtc,
          method: "filename-and-container",
          confidence: "high",
          disagreementSeconds: gap
        }
      }
      const earlier = Date.parse(filenameUtc) <= Date.parse(containerStartUtc)
        ? filenameUtc
        : containerStartUtc
      return {
        startUtc: earlier,
        method: earlier === filenameUtc ? "filename-stamp" : "container-mvhd",
        confidence: "medium",
        disagreementSeconds: gap
      }
    }
    if (containerStartUtc) {
      return {
        startUtc: containerStartUtc,
        method: "container-mvhd",
        confidence: "high",
        disagreementSeconds: null
      }
    }
    if (filenameUtc) {
      return {
        startUtc: filenameUtc,
        method: "filename-stamp",
        confidence: "medium",
        disagreementSeconds: null
      }
    }
    if (evidence.modifiedAt && !Number.isNaN(Date.parse(evidence.modifiedAt))) {
      return {
        startUtc: new Date(evidence.modifiedAt).toISOString(),
        method: "modified-time",
        confidence: "low",
        disagreementSeconds: null
      }
    }
    return { startUtc: null, method: "none", confidence: "none", disagreementSeconds: null }
  }

  const decided = decide()
  return {
    ...decided,
    startUtc: decided.startUtc === null ? null : shifted(decided.startUtc),
    zone,
    filenamePattern: stamp?.pattern.name ?? null,
    appliedRules
  }
}

/**
 * A stable digest of the rules, for the attribution basis hash.
 *
 * Rules are derivation inputs, so a changed rule must re-derive the captures
 * it touches. `RegExp` sources are included: editing a pattern is a real
 * change even when the rule's name stays the same.
 */
export const startTimeRulesDigest = (rules: StartTimeRules): string =>
  JSON.stringify({
    patterns: rules.filenamePatterns.map((entry) => [entry.name, entry.pattern.source, entry.zone ?? ""]),
    container: rules.container,
    window: rules.agreementWindowSeconds,
    rules: rules.rules.map((rule) => [
      rule.name,
      rule.source?.source ?? "",
      rule.filename?.source ?? "",
      rule.from ?? "",
      rule.until ?? "",
      rule.container ?? "",
      rule.zone ?? "",
      rule.shiftSeconds ?? 0
    ])
  })
