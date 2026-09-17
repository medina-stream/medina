import * as Schema from "effect/Schema"
import { mediaManifestKey, mergeParts, type TranscriptChunkPart } from "../capture/Media.ts"
import {
  ASSEMBLYAI_PRICE_PER_AUDIO_SECOND,
  MUSE_VOICE_PRICE_PER_AUDIO_SECOND,
  MUSE_VOICE_VERSION
} from "./MuseVoice.ts"

/**
 * Parallel-comparison harness for Meta Muse Voice Transcribe.
 *
 * Production transcripts are never touched: every artifact the harness writes
 * lives under `transcript-compare/<version>/`, a namespace the transcript
 * discovery and journal indexing never read. Raw Meta vendor JSON is kept
 * beside the merged comparison transcript, mirroring the production layout
 * (`transcript.json` + `.assemblyai.json`) without colliding with it.
 */
export const COMPARE_VERSION = MUSE_VOICE_VERSION
export const COMPARE_DIR = `transcript-compare/${COMPARE_VERSION}`

export const compareJobsKey = (captureId: string) => `${COMPARE_DIR}/${captureId}.jobs.json`
export const compareRawKey = (captureId: string) => `${COMPARE_DIR}/${captureId}.meta-muse.json`
export const compareTranscriptKey = (captureId: string) => `${COMPARE_DIR}/${captureId}.json`

export class CompareChunkJob extends Schema.Class<CompareChunkJob>("CompareChunkJob")({
  index: Schema.Number,
  key: Schema.String,
  transcriptId: Schema.String,
  /** Last vendor status seen; empty until the first poll. */
  status: Schema.String,
  submittedAt: Schema.String
}) {}

export class CompareJobReceipt extends Schema.Class<CompareJobReceipt>("CompareJobReceipt")({
  captureId: Schema.String,
  version: Schema.String,
  windowStart: Schema.String,
  windowEnd: Schema.String,
  chunks: Schema.Array(CompareChunkJob)
}) {}

const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/

/**
 * Wall-clock window check. Capture times come from device filenames as
 * zone-less local "YYYY-MM-DDTHH:mm:ss"; the window is given in the same
 * form, so plain string comparison is exact and timezone-free. The window
 * is inclusive at the start, exclusive at the end.
 */
export const inWindow = (
  capturedAt: string | null,
  start: string,
  end: string
): boolean => capturedAt !== null && capturedAt >= start && capturedAt < end

export interface CompareArgs {
  readonly start: string
  readonly end: string
  readonly limit: number | null
  readonly submitOnly: boolean
  readonly pollOnly: boolean
}

/** Parse `bun scripts/muse-voice-compare.ts --start <wall-clock> --end <wall-clock>
 * [--limit N] [--submit-only] [--poll-only]`. Throws with usage on bad input. */
export const parseCompareArgs = (argv: ReadonlyArray<string>): CompareArgs => {
  const usage = "usage: bun scripts/muse-voice-compare.ts --start YYYY-MM-DDTHH:mm:ss --end YYYY-MM-DDTHH:mm:ss [--limit N] [--submit-only] [--poll-only]"
  const fail = (reason: string): never => {
    throw new Error(`${reason}\n${usage}`)
  }
  const take = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    if (index === -1) return null
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`)
    return value as string
  }
  const start = take("--start") ?? fail("missing --start")
  const end = take("--end") ?? fail("missing --end")
  if (!WALL_CLOCK.test(start)) fail(`--start must be YYYY-MM-DDTHH:mm:ss (capture-local wall clock), got ${start}`)
  if (!WALL_CLOCK.test(end)) fail(`--end must be YYYY-MM-DDTHH:mm:ss (capture-local wall clock), got ${end}`)
  if (start >= end) fail("--start must be before --end")
  const limitRaw = take("--limit")
  const limit = limitRaw === null ? null : Number(limitRaw)
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) fail(`--limit must be a positive integer, got ${limitRaw}`)
  const submitOnly = argv.includes("--submit-only")
  const pollOnly = argv.includes("--poll-only")
  if (submitOnly && pollOnly) fail("--submit-only and --poll-only are mutually exclusive")
  return { start, end, limit, submitOnly, pollOnly }
}

/**
 * Merge per-chunk Meta results into a production-shaped transcript tagged
 * `provider: "meta-muse"`. A plain object, deliberately not a `Transcript`:
 * the schema pins `provider` to `"assemblyai"`, and comparison output must
 * never validate as (or be discovered as) a production transcript.
 */
export const mergeCompareTranscript = (
  captureId: string,
  capturedAt: string | null,
  parts: ReadonlyArray<TranscriptChunkPart>
): Record<string, unknown> => {
  const merged = mergeParts(parts)
  return {
    provider: "meta-muse",
    version: COMPARE_VERSION,
    ingestId: captureId,
    inputKey: mediaManifestKey(captureId),
    ...(capturedAt === null ? {} : { capturedAt }),
    transcriptId: merged.transcriptId,
    vendorKey: compareRawKey(captureId),
    status: merged.status,
    completedAt: new Date().toISOString(),
    text: merged.text,
    utterances: merged.utterances,
    error: merged.error
  }
}

export interface CompareSummary {
  readonly windowStart: string
  readonly windowEnd: string
  readonly capturesInWindow: number
  readonly submitted: number
  readonly completed: number
  readonly failed: number
  readonly audioSeconds: number
}

const dollars = (amount: number): string => `$${amount.toFixed(2)}`

export const formatSummary = (summary: CompareSummary): string => {
  const hours = summary.audioSeconds / 3600
  const museCost = summary.audioSeconds * MUSE_VOICE_PRICE_PER_AUDIO_SECOND
  const assemblyCost = summary.audioSeconds * ASSEMBLYAI_PRICE_PER_AUDIO_SECOND
  return [
    `muse-voice-compare [${summary.windowStart} .. ${summary.windowEnd})`,
    `captures in window: ${summary.capturesInWindow}`,
    `submitted: ${summary.submitted}, completed: ${summary.completed}, failed: ${summary.failed}`,
    `audio: ${hours.toFixed(1)}h`,
    `est. cost — Muse Voice @ $0.18/audio-hr: ${dollars(museCost)}`,
    `est. cost — AssemblyAI @ $0.23/audio-hr: ${dollars(assemblyCost)}`
  ].join("\n")
}
