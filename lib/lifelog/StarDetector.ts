/**
 * The star detector — the doorbell on the Stars SDR.
 *
 * When Scott says "star …" in captured speech, this files the star
 * automatically (createdVia "voice"): no manual API call, and no request
 * path ever runs it. A periodic sweep in the server re-reads the current
 * and previous UTC days' transcripts, parses self-spoken utterances that
 * begin with the word "star", and files each command through the Stars
 * service. The same pass runs the retention sweep, giving expiry its
 * heartbeat.
 *
 * Filing is idempotent end to end. A command's id is deterministic over
 * (captureId, utterance start, utterance text), so a re-scan overwrites
 * the same record with the same content rather than duplicating it; a
 * command's createdAt rides its utterance end (which is always the
 * interval end), so retention counts from when he said it and a re-scan
 * can never revive a star whose life has already run out.
 *
 * Only self speech commands. Utterances whose speaker is
 * SPEAKER_SELF_ID — today the unlabeled on-device channel, see DayIndex —
 * count; diarized vendor labels do not, because they cannot yet be
 * attributed to Scott durably.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { sha256 } from "../Hash.ts"
import { currentDayIndex, dayTranscripts, SPEAKER_SELF_ID } from "./DayIndex.ts"
import {
  DayIndex,
  DAY_INDEX_VERSION,
  DEFAULT_STAR_RETENTION_SECONDS,
  type Transcript
} from "./Resources.ts"
import { Stars } from "./Stars.ts"
import type { StartTimeRulesService } from "./StartTimeRules.ts"

/** How often the server re-scans for spoken star commands (seconds). */
export const STAR_DETECTOR_PERIOD_SECONDS = 90

/** The default window for a bare "star": the two minutes running up to the
 * end of the command utterance (its start is excluded only by its own
 * duration — the command is in the window, as its capstone). */
const DEFAULT_WINDOW_SECONDS = 120

// --- the parser --------------------------------------------------------------

/** One transcript as the detector sees it: the day index entry's capture
 * identity and start, plus the transcript itself. */
export interface TranscriptFile {
  readonly captureId: string
  /** The capture's start, ISO UTC, from the day index entry. */
  readonly startTime: string
  readonly transcript: Transcript
}

export interface DetectedStarCommand {
  readonly starId: string
  readonly startUtc: string
  readonly endUtc: string
  readonly name: string | null
  readonly utteranceText: string
}

const FILLERS: ReadonlySet<string> = new Set(["ok", "okay", "hey"])

/** A token stripped of the punctuation transcription wraps words in, so
 * matching sees the word itself: `"star,` → `star`. */
const bareToken = (token: string): string =>
  token.replace(/^[\s"'“”‘’(\[{<]+|[\s"'“”‘’.,!?;:)}\]>]+$/g, "")

/** Seconds named by the text after "the last", or null when the phrase is
 * not one the grammar knows. */
const lastSpanSeconds = (afterLast: string): number | null => {
  const amount = /^(\d+(?:\.\d+)?)\s*(minutes?|mins?|seconds?|secs?|hours?|hrs?)\b/.exec(afterLast)
  if (amount) {
    const value = Number(amount[1])
    if (!Number.isFinite(value) || value <= 0) return null
    const unit = amount[2]!
    return unit.startsWith("min") ? value * 60 : unit.startsWith("sec") ? value : value * 3600
  }
  if (/^half (an )?hour\b/.test(afterLast)) return 30 * 60
  if (/^minute\b/.test(afterLast)) return 60
  if (/^hour\b/.test(afterLast)) return 3600
  if (/^second\b/.test(afterLast)) return 1
  return null
}

/** The star's name from the words after "star": a quoted phrase wins, then
 * "as <words>". Best-effort and original-case; null when neither is said. */
const starName = (afterStar: string): string | null => {
  const quoted = /["“'‘]([^"“”'’]{1,80})["“”'’]/.exec(afterStar)
  if (quoted?.[1]?.trim()) return quoted[1].trim()
  const as = /\bas\b\s+(.+)$/i.exec(afterStar)
  if (as?.[1]) {
    const name = as[1].trim().replace(/[.!?;,]+$/, "").trim()
    if (name) return name
  }
  return null
}

/**
 * Parse one transcript's self utterances into star commands.
 *
 * An utterance is a command when, trimmed and case-insensitively, it
 * starts with "star" — optionally preceded by exactly one filler token
 * ("ok", "okay", "hey"). "star" anywhere else ("the star of the show",
 * "I said star …") is speech, not a command.
 *
 * Interval grammar, relative to the end of the command utterance:
 * "star the last N minutes/seconds/hours" reaches N back from the end;
 * "star the last half hour" is 30 minutes and "star the last minute" is
 * 60 seconds. Anything else — bare "star", "star that", "star it", or a
 * span the grammar doesn't know — takes the default window ending at the
 * utterance end and starting 120s before the utterance start. A named
 * span ends at the utterance end, so the command utterance itself is not
 * inside its own interval (the excerpt resolver may still brush it).
 */
export const detectStarCommands = (file: TranscriptFile): ReadonlyArray<DetectedStarCommand> => {
  const captureStart = Date.parse(file.startTime)
  if (Number.isNaN(captureStart)) return []
  const commands: Array<DetectedStarCommand> = []
  for (const utterance of file.transcript.utterances) {
    if (utterance.speaker !== SPEAKER_SELF_ID) continue
    const text = utterance.text.trim()
    if (!text) continue
    const tokens = text.split(/\s+/)
    let head = 0
    if (tokens.length > 1 && FILLERS.has(bareToken(tokens[0]!).toLowerCase())) head = 1
    if (bareToken(tokens[head]!).toLowerCase() !== "star") continue

    const utteranceStartUtc = new Date(captureStart + utterance.startMs).toISOString()
    const utteranceEndMs = captureStart + utterance.endMs
    const utteranceEndUtc = new Date(utteranceEndMs).toISOString()
    // What he said after the word "star" itself: the interval grammar
    // reads it normalized, the name reads it as spoken.
    const afterStar = text.slice(text.indexOf(tokens[head]!) + tokens[head]!.length).trim()
    const normalized = afterStar.toLowerCase()
    const last = /^the last\s+(.+)$/.exec(normalized)
    const spanSeconds = last ? lastSpanSeconds(last[1]!) : null
    const startUtc = spanSeconds !== null
      ? new Date(utteranceEndMs - Math.round(spanSeconds * 1000)).toISOString()
      : new Date(captureStart + utterance.startMs - DEFAULT_WINDOW_SECONDS * 1000).toISOString()
    commands.push({
      starId: sha256(`${file.captureId}:${utteranceStartUtc}:${text}`).slice(0, 32),
      startUtc,
      endUtc: utteranceEndUtc,
      name: starName(afterStar),
      utteranceText: text
    })
  }
  return commands
}

// --- the sweep -----------------------------------------------------------------

type DetectorEnv = Stars | FileSystem.FileSystem

/**
 * File every star command in one day index and then sweep expired stars.
 * The index is a parameter (rather than always the current one) so tests
 * drive the same code over a hand-built index. Safe to run repeatedly:
 * deterministic ids overwrite in place, and a command whose default
 * retention has already run out by scan time is left unfiled — born
 * expired, never written, never revived.
 */
export const detectAndFileStarsIn = (
  index: DayIndex,
  now: Date
): Effect.Effect<ReadonlyArray<string>, Error, DetectorEnv> =>
  Effect.gen(function*() {
    const stars = yield* Stars
    const todayUtc = now.toISOString().slice(0, 10)
    const yesterdayUtc = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)
    const filed: Array<string> = []
    for (const day of [yesterdayUtc, todayUtc]) {
      const transcripts = yield* dayTranscripts(index, day)
      for (const { entry, transcript } of transcripts) {
        const commands = detectStarCommands({
          captureId: entry.captureId,
          startTime: entry.startTime,
          transcript
        })
        for (const command of commands) {
          if (Date.parse(command.endUtc) + DEFAULT_STAR_RETENTION_SECONDS * 1000 <= now.getTime()) continue
          yield* stars.setStar({
            id: command.starId,
            startUtc: command.startUtc,
            endUtc: command.endUtc,
            name: command.name,
            note: command.utteranceText,
            retentionSeconds: DEFAULT_STAR_RETENTION_SECONDS,
            createdAt: command.endUtc,
            createdVia: "voice"
          })
          filed.push(command.starId)
        }
      }
    }
    yield* stars.sweepExpired(now)
    return filed
  })

/**
 * The live sweep: the current and previous UTC days from the current day
 * index, with the retention sweep behind it. If the index cannot be built
 * the scan finds nothing this pass, but the sweep still runs — stars must
 * not be held hostage by a corrupt transcript elsewhere in the corpus
 * (the same stance starsResource takes).
 */
export const detectAndFileStars = (
  now: Date
): Effect.Effect<ReadonlyArray<string>, Error, DetectorEnv | StartTimeRulesService> =>
  Effect.gen(function*() {
    const index = yield* currentDayIndex.pipe(
      Effect.orElseSucceed(
        () => new DayIndex({ version: DAY_INDEX_VERSION, inputHash: "unavailable", builtAt: now.toISOString(), days: {} })
      )
    )
    return yield* detectAndFileStarsIn(index, now)
  })
