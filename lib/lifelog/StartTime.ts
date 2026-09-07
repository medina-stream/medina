/**
 * Deciding when a recording started, from disagreeing evidence.
 *
 * Three kinds of clue, and none is reliable alone:
 *
 * - **Filename stamp** (`...020260903T140436...`) is the recorder pressing
 *   record. Usually exact, but zone-less, and much of the archive lacks it.
 * - **Container `mvhd`** carries a real UTC instant. For the recorders seen
 *   here it is when recording *stopped*, so subtracting the encoded duration
 *   gives a start. Zone-free and hard to fake, but the duration is *encoded*
 *   audio: if the recorder paused, elapsed wall time is longer and the
 *   derived start is too late.
 * - **File modified time** is upload time. Observed hours after the fact on
 *   this corpus, so it is a last resort, not evidence.
 *
 * Measured on 32 real recordings: container-derived starts agreed with the
 * filename stamp within 2s on 31 of them, and were 888s later on one that
 * had evidently been paused. So the two corroborate each other, and where
 * they disagree the *earlier* is the record-press.
 *
 * Pure: the caller gathers evidence, this decides. That keeps the policy
 * testable and keeps the IO out of it.
 */

/** How much disagreement still counts as corroboration. */
export const AGREEMENT_WINDOW_SECONDS = 120

export type StartMethod =
  | "filename-and-container"
  | "container-mvhd"
  | "filename-stamp"
  | "modified-time"
  | "none"

export type StartConfidence = "high" | "medium" | "low" | "none"

export interface StartEvidence {
  /** Naive local wall clock from the filename, e.g. `2026-09-03T14:04:36`. */
  readonly filenameWallClock: string | null
  /** UTC instant derived from container metadata. */
  readonly containerStartUtc: string | null
  /** Naive local wall clock from the source's modified time. */
  readonly modifiedWallClock: string | null
  /** Interprets the naive wall-clock values above. */
  readonly zone: string
  /** Wall clock -> UTC in `zone`; supplied so this module stays pure. */
  readonly toUtc: (wallClock: string, zone: string) => string | null
}

export interface StartDecision {
  /** UTC instant, or null when nothing usable was offered. */
  readonly startUtc: string | null
  readonly method: StartMethod
  readonly confidence: StartConfidence
  /** Seconds between filename and container, when both are present. */
  readonly disagreementSeconds: number | null
}

const seconds = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 1000

/**
 * The best available start time.
 *
 * Corroborated evidence wins; then the container (an absolute instant beats
 * a zone-less guess); then the filename; then modified time, which is
 * really "we do not know".
 *
 * When both are present but disagree, the earlier is taken: a paused
 * recording makes the container start too late, and nothing observed makes
 * it too early.
 */
export const decideStart = (evidence: StartEvidence): StartDecision => {
  const { containerStartUtc, filenameWallClock, modifiedWallClock, zone, toUtc } = evidence
  const filenameUtc = filenameWallClock ? toUtc(filenameWallClock, zone) : null

  if (filenameUtc && containerStartUtc) {
    const gap = seconds(filenameUtc, containerStartUtc)
    if (gap <= AGREEMENT_WINDOW_SECONDS) {
      // Agreement across independent sources: the strongest claim available,
      // and it also confirms the zone the filename was interpreted in.
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

  const modifiedUtc = modifiedWallClock ? toUtc(modifiedWallClock, zone) : null
  if (modifiedUtc) {
    return {
      startUtc: modifiedUtc,
      method: "modified-time",
      confidence: "low",
      disagreementSeconds: null
    }
  }

  return { startUtc: null, method: "none", confidence: "none", disagreementSeconds: null }
}
