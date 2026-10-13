/**
 * The day index: one file mapping day -> usable captures, so serving reads a
 * single file instead of scanning the corpus. Usable = a completed transcript
 * with text and an attributed day.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Files from "../Files.ts"
import type { Resource } from "../Resource.ts"
import { sha256 } from "../Hash.ts"
import { type Corrections, correctionFor, currentAttribution, readCorrections, transcribedCaptures } from "./Attribution.ts"
import { StartTimeRulesService } from "./StartTimeRules.ts"
import { homeTimeZone } from "./Time.ts"
import { dataPath, DayEntry, DayIndex, DAY_INDEX_VERSION, dayIndexKey, liveTranscriptKey, localTranscriptKey, parseLiveCaptureId, Transcript, transcriptKey } from "./Resources.ts"

type AttributionEnv = FileSystem.FileSystem | StartTimeRulesService

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
/**
 * A UTC instant as local wall-clock in the home zone, for live provisionals
 * (which bypass attribution and its estimated-start-time machinery).
 */
const wallClockInZone = (isoUtc: string, zone: string): { day: string; startTime: string } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(isoUtc))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  const day = `${get("year")}-${get("month")}-${get("day")}`
  return { day, startTime: `${day}T${get("hour")}:${get("minute")}:${get("second")}` }
}

const usableTranscript = (t: Option.Option<Transcript>) =>
  Option.isSome(t) && t.value.status === "completed" && !!t.value.text?.trim() ? t : null

/**
 * Which transcript key (if any) makes a capture usable for the index: the
 * canonical vendor transcript wins, the on-device first-look fills the gap
 * before it lands (or when the vendor run has not completed). This is the
 * same selection `buildDayIndex` files the capture under.
 */
const selectedTranscriptKey = (captureId: string) =>
  Effect.gen(function*() {
    const live = parseLiveCaptureId(captureId)
    if (live !== null) {
      const key = liveTranscriptKey(live.installId, live.segmentUuid)
      return usableTranscript(yield* Files.readJson(Transcript, dataPath(key))) !== null ? key : null
    }
    const canonical = yield* Files.readJson(Transcript, dataPath(transcriptKey(captureId)))
    if (usableTranscript(canonical) !== null) return transcriptKey(captureId)
    const firstLook = yield* Files.readJson(Transcript, dataPath(localTranscriptKey(captureId)))
    return usableTranscript(firstLook) !== null ? localTranscriptKey(captureId) : null
  })

const dayIndexBasis = Effect.gen(function*() {
  const captureIds = yield* transcribedCaptures
  const zone = yield* homeTimeZone
  const corrections = yield* readCorrections
  // The selected transcript key participates, not just the capture id:
  // a canonical transcript can now replace an error/absent state at the
  // same path when a failed transcription is retried, and a first-look
  // can later be superseded by the canonical transcript. Without it the
  // basis (and thus the index file) would be identical before and after
  // the fix landed, and the index built while the capture was unusable
  // would be served forever.
  const pairs = yield* Effect.forEach(captureIds, (captureId) =>
    Effect.map(selectedTranscriptKey(captureId), (transcriptKey) => ({
      captureId,
      correctionHash: correctionFor(corrections, captureId).hash,
      transcriptKey
    })), { concurrency: 8 })
  // The home zone participates: changing it re-attributes zone-less captures,
  // so the index (and downstream journals) must re-derive.
  const inputHash = sha256(
    [DAY_INDEX_VERSION, zone, ...pairs.map((pair) => `${pair.captureId}:${pair.correctionHash ?? ""}:${pair.transcriptKey ?? ""}`)].join("\n")
  )
  return { pairs, inputHash, corrections, zone }
})

const buildDayIndex = Effect.fn("buildDayIndex")(
  function*(
    pairs: ReadonlyArray<{ captureId: string; correctionHash: string | null; transcriptKey: string | null }>,
    inputHash: string,
    corrections: Corrections,
    zone: string
  ) {
    // Per-capture work (transcript read + attribution probe/materialize)
    // is independent, so it runs concurrently; grouping and the per-day
    // sort below keep the written index identical to the sequential pass.
    const placed = yield* Effect.forEach(pairs, ({ captureId, correctionHash, transcriptKey: selectedKey }) =>
      Effect.gen(function*() {
        // Live provisionals (in-progress segments) aren't captures yet: file
        // them directly from the provisional transcript, keyed by segment UUID.
        const live = parseLiveCaptureId(captureId)
        if (live !== null) {
          const liveKey = liveTranscriptKey(live.installId, live.segmentUuid)
          const provisional = usableTranscript(yield* Files.readJson(Transcript, dataPath(liveKey)))
          const capturedAt = provisional?.value.capturedAt
          if (provisional === null || !capturedAt) return null
          const { day, startTime } = wallClockInZone(capturedAt, zone)
          return { day, entry: new DayEntry({
            captureId,
            transcriptKey: liveKey,
            startTime,
            timeZone: zone,
            channel: "audio",
            correctionHash: null
          }) }
        }
        // The vendor transcript wins when it is usable; the on-device
        // first-look fills the gap before it lands (or when the vendor run
        // has not completed). The basis already selected the key, and the
        // entry records it, so a later canonical transcript changes both
        // this index's key and the journal's input hash.
        if (selectedKey === null) return null
        const { attribution } = yield* currentAttribution(captureId, corrections, zone)
        if (!attribution.day || !attribution.estimatedStartTime || !attribution.timeZone) return null
        return { day: attribution.day, entry: new DayEntry({
          captureId,
          transcriptKey: selectedKey,
          startTime: attribution.estimatedStartTime,
          timeZone: attribution.timeZone,
          channel: attribution.channel,
          correctionHash
        }) }
      }), { concurrency: 8 })
    const days: Record<string, Array<DayEntry>> = {}
    for (const item of placed) {
      if (item === null) continue
      days[item.day] = [...(days[item.day] ?? []), item.entry]
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
let dayIndexMemo: { inputHash: string; index: Effect.Effect<DayIndex, Error, AttributionEnv> } | null = null

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

/** The normalized transcript evidence for one day, in recording and turn
 * order. This uses the same attributed timing as journals and search. */
export const dayTranscriptDetail = (day: string) =>
  Effect.gen(function*() {
    const index = yield* currentDayIndex
    const inputs = yield* dayTranscripts(index, day)
    return inputs.map(({ entry, transcript }) => ({
      captureId: entry.captureId,
      startTime: entry.startTime,
      timeZone: entry.timeZone,
      turns: transcript.utterances.length > 0
        ? transcript.utterances.map(({ speaker, startMs, endMs, text }) => ({ speaker, startMs, endMs, text }))
        : transcript.text?.trim()
          ? [{ speaker: null, startMs: 0, endMs: 0, text: transcript.text }]
          : []
    }))
  })
