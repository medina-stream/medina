/**
 * The day index: one file mapping day -> usable captures, so serving reads a
 * single file instead of scanning the corpus. Usable = a completed transcript
 * with text and an attributed day.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Files from "../lib/Files.ts"
import type { Resource } from "../lib/Resource.ts"
import { sha256 } from "./Hash.ts"
import { type Corrections, correctionFor, currentAttribution, readCorrections, transcribedCaptures } from "./Attribution.ts"
import { homeTimeZone } from "./Time.ts"
import { dataPath, DayEntry, DayIndex, DAY_INDEX_VERSION, dayIndexKey, Transcript, transcriptKey } from "./Resources.ts"

type AttributionEnv = FileSystem.FileSystem

/**
 * One file mapping day -> usable captures, so serving reads one file instead
 * of scanning the corpus. Usable = completed transcript with text and an
 * attributed day.
 *
 * The index key bakes in a hash over (capture id, correction hash) pairs —
 * exactly the inputs that can change an attribution — so a new capture or a
 * new correction stales it. The in-process memo makes repeated reads within
 * one process cheap; the file makes them cheap across restarts.
 */
const dayIndexBasis = Effect.gen(function*() {
  const captureIds = yield* transcribedCaptures
  const zone = yield* homeTimeZone
  const corrections = yield* readCorrections
  const pairs = captureIds.map((captureId) => ({
    captureId,
    correctionHash: correctionFor(corrections, captureId).hash
  }))
  // The home zone participates: changing it re-attributes zone-less captures,
  // so the index (and downstream journals) must re-derive.
  const inputHash = sha256(
    [DAY_INDEX_VERSION, zone, ...pairs.map((pair) => `${pair.captureId}:${pair.correctionHash ?? ""}`)].join("\n")
  )
  return { pairs, inputHash, corrections, zone }
})

const buildDayIndex = Effect.fn("buildDayIndex")(
  function*(
    pairs: ReadonlyArray<{ captureId: string; correctionHash: string | null }>,
    inputHash: string,
    corrections: Corrections,
    zone: string
  ) {
    const days: Record<string, Array<DayEntry>> = {}
    for (const { captureId, correctionHash } of pairs) {
      const transcript = yield* Files.readJson(Transcript, dataPath(transcriptKey(captureId)))
      if (Option.isNone(transcript)) continue
      if (transcript.value.status !== "completed" || !transcript.value.text?.trim()) continue
      const { attribution } = yield* currentAttribution(captureId, corrections, zone)
      if (!attribution.day || !attribution.estimatedStartTime || !attribution.timeZone) continue
      const entry = new DayEntry({
        captureId,
        transcriptKey: transcriptKey(captureId),
        startTime: attribution.estimatedStartTime,
        timeZone: attribution.timeZone,
        channel: attribution.channel,
        correctionHash
      })
      days[attribution.day] = [...(days[attribution.day] ?? []), entry]
    }
    for (const entries of Object.values(days)) {
      entries.sort((a, b) => a.startTime.localeCompare(b.startTime))
    }
    yield* Files.writeJson(
      dataPath(dayIndexKey(inputHash)),
      new DayIndex({ version: DAY_INDEX_VERSION, inputHash, builtAt: new Date().toISOString(), days })
    )
  }
)

export const dayIndexResource: Resource<AttributionEnv> = {
  name: "day-index",
  instances: Effect.map(dayIndexBasis, ({ pairs, inputHash, corrections, zone }) => [{
    key: dayIndexKey(inputHash),
    label: inputHash.slice(0, 12),
    dependencies: pairs.map((pair) => transcriptKey(pair.captureId)),
    materialize: buildDayIndex(pairs, inputHash, corrections, zone)
  }])
}

/** The current index, materializing if stale, memoized per input hash so
 * request handling in steady state does no corpus work at all. Concurrent
 * misses share one build: the in-flight Effect is what's cached, so two
 * requests arriving together can't both materialize. */
let dayIndexMemo: { inputHash: string; index: Effect.Effect<DayIndex, Error, FileSystem.FileSystem> } | null = null

export const currentDayIndex = Effect.gen(function*() {
  const { pairs, inputHash, corrections, zone } = yield* dayIndexBasis
  if (dayIndexMemo?.inputHash === inputHash) return yield* dayIndexMemo.index
  const key = dayIndexKey(inputHash)
  const load = Effect.gen(function*() {
    const existing = yield* Files.readJson(DayIndex, dataPath(key))
    if (Option.isSome(existing)) return existing.value
    yield* buildDayIndex(pairs, inputHash, corrections, zone)
    return Option.getOrThrow(yield* Files.readJson(DayIndex, dataPath(key)))
  })
  // cached() makes the first evaluation win and later ones reuse its result;
  // a failure isn't retained, so a transient error doesn't poison the memo.
  const cached = yield* Effect.cached(load)
  dayIndexMemo = { inputHash, index: cached }
  return yield* cached
})

/** Transcripts for one day, in believed chronological order. */
export const dayTranscripts = (index: DayIndex, day: string) =>
  Effect.forEach(index.days[day] ?? [], (entry) =>
    Effect.map(
      Files.readJson(Transcript, dataPath(entry.transcriptKey)),
      (transcript) => ({ entry, transcript })
    )).pipe(
      Effect.map((pairs) =>
        pairs.flatMap(({ entry, transcript }) =>
          Option.isSome(transcript) ? [{ entry, transcript: transcript.value }] : [])
      )
    )
