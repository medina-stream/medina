/**
 * Derived views over the data dir: what the HTTP layer serves.
 *
 * Journal files live at `journal/<version>/<day>/<inputHash>.json`, so a
 * day's journals are found by splitting that path -- never by substring
 * matching, which would also match a day appearing inside a hash.
 */
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Files from "../lib/Files.ts"
import { RUN_REPORT_KEY, RunReport } from "../lib/Pipeline.ts"
import { currentDayIndex } from "./DayIndex.ts"
import { journalResource } from "./Journal.ts"
import { DayRow, ListDays } from "./JournalApi.ts"
import { dataPath, Journal, JOURNAL_VERSION } from "./Resources.ts"

const JOURNAL_PREFIX = `journal/${JOURNAL_VERSION}`

/** Every journal key on disk, grouped by day. */
const journalKeysByDay = Effect.gen(function*() {
  const entries = yield* Files.listFiles(dataPath(JOURNAL_PREFIX))
  const byDay = new Map<string, Array<string>>()
  for (const entry of entries) {
    const [day, file] = entry.split("/")
    if (!day || !file || !file.endsWith(".json")) continue
    byDay.set(day, [...(byDay.get(day) ?? []), `${JOURNAL_PREFIX}/${entry}`])
  }
  return byDay
})

/**
 * A pipeline status summary, derived entirely from the data dir: the last run's
 * report plus per-day input/journal freshness. Days whose journal hash doesn't
 * match the current input set are `stale` (a journal run is due).
 */
export const pipelineStatus = Effect.gen(function*() {
  const lastRun = yield* Files.readJson(RunReport, dataPath(RUN_REPORT_KEY)).pipe(
    Effect.orElseSucceed(() => Option.none<RunReport>())
  )
  const byDay = yield* journalKeysByDay
  const index = yield* currentDayIndex
  const instances = yield* journalResource.instances
  const days = [...instances]
    .sort((a, b) => b.label.localeCompare(a.label))
    .map((instance) => {
      const day = instance.label
      const keys = byDay.get(day) ?? []
      const journal = keys.includes(instance.key) ? "current" : keys.length > 0 ? "stale" : "missing"
      return { day, transcripts: index.days[day]?.length ?? 0, journal }
    })
  return {
    lastRun: Option.getOrNull(lastRun),
    days,
    totals: {
      days: days.length,
      transcripts: days.reduce((sum, entry) => sum + entry.transcripts, 0),
      current: days.filter((entry) => entry.journal === "current").length,
      stale: days.filter((entry) => entry.journal !== "current").length
    }
  }
})

/** A journal to show, plus whether it reflects the current input set. */
export interface JournalView {
  readonly journal: Journal
  readonly stale: boolean
}

/** Preview length: the summary line, so table cells stay fixed height. */
export const PREVIEW_CHARS = 160

/** The report's summary line: its first non-empty line, flattened to at most
 * PREVIEW_CHARS. The journal format leads with a single-sentence summary, so
 * table cells show that instead of the chronology. Pure — safe to test. */
export const previewText = (report: string): string => {
  const line = report.split("\n").find((candidate) => candidate.trim().length > 0) ?? ""
  const flat = line.replace(/\s+/g, " ").trim()
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : flat
}

/** One virtual-table row: the day, its freshness, and its preview. */
export interface DayPreview {
  readonly day: string
  readonly stale: boolean
  readonly preview: string
}

/**
 * The days to render, newest first, with previews. Selection reuses
 * `currentJournals`, so rows agree with the full views exactly.
 */
const currentDayPreviews = Effect.gen(function*() {
  const views: ReadonlyArray<JournalView> = yield* currentJournals
  return views.map((view): DayPreview => ({
    day: view.journal.day,
    stale: view.stale,
    preview: previewText(view.journal.report)
  }))
}).pipe(Effect.withSpan("views.dayPreviews"))

/**
 * Staleness bound for served previews. Journals only change on the hourly
 * pipeline pass (plus the post-pass poke below), so minutes of lag are
 * invisible — while reads never wait on derivation.
 */
const PREVIEWS_TTL_MS = 10 * 60 * 1000

interface PreviewsMemo {
  value: ReadonlyArray<DayPreview> | null
  expiresAt: number
  refreshing: boolean
}

const previewsMemo: PreviewsMemo = { value: null, expiresAt: 0, refreshing: false }

/** On-disk backstop so a cold boot serves the last refresh instantly
 * instead of deriving over the mount. Same contract as the RPC payload,
 * so the snapshot can never drift from what ListDays serves. */
const PREVIEWS_SNAPSHOT = dataPath("views/days-v2.json")

const storePreviews = (value: ReadonlyArray<DayPreview>, now: number) => {
  previewsMemo.value = value
  previewsMemo.expiresAt = now + PREVIEWS_TTL_MS
  previewsMemo.refreshing = false
}

/** Persist the memo for the next cold boot. Best-effort: a failed write
 * only logs, the memo itself is already stored. */
const writeSnapshot = (value: ReadonlyArray<DayPreview>) =>
  Effect.flatMap(
    Effect.try(() => Schema.encodeSync(ListDays.successSchema)(value.map((row) => new DayRow(row)))),
    (json) => Files.writeJson(PREVIEWS_SNAPSHOT, json)
  ).pipe(
    Effect.catchCause((cause) => Effect.logError("previews snapshot write failed", cause))
  )

/**
 * The last persisted previews, or null when no usable snapshot exists. Any
 * problem — missing file, corrupt JSON, failed decode, unreadable mount —
 * falls through to synchronous derivation: the snapshot is a backstop,
 * never load-bearing.
 */
const readSnapshot: Effect.Effect<ReadonlyArray<DayPreview> | null, never, FileSystem.FileSystem> =
  Effect.matchCauseEffect(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      if (!(yield* fs.exists(PREVIEWS_SNAPSHOT))) return null
      const text = yield* fs.readFileString(PREVIEWS_SNAPSHOT)
      return yield* Schema.decodeUnknownEffect(ListDays.successSchema)(JSON.parse(text))
    }),
    {
      onFailure: () => Effect.succeed(null),
      onSuccess: (rows) =>
        Effect.succeed(
          rows === null
            ? null
            : rows.map((row): DayPreview => ({ day: row.day, stale: row.stale, preview: row.preview }))
        )
    }
  )

/**
 * Recompute previews now and store them. Failures keep the previous value
 * (and clear the in-flight flag) so a transient read error degrades to
 * slightly older rows instead of an error page.
 */
export const refreshDayPreviews = Effect.gen(function*() {
  // Single-flight: concurrent triggers (expiry + journal events) collapse
  // into one recompute. Set before the first yield — atomic.
  if (previewsMemo.refreshing) return
  previewsMemo.refreshing = true
  const exit = yield* Effect.exit(currentDayPreviews)
  if (Exit.isSuccess(exit)) {
    storePreviews(exit.value, yield* Clock.currentTimeMillis)
    yield* writeSnapshot(exit.value)
  } else {
    previewsMemo.refreshing = false
    yield* Effect.logError("day previews refresh failed", exit.cause)
  }
})

/**
 * Previews with stale-while-revalidate semantics: a cached value is always
 * served immediately; an expired one triggers a background refresh and
 * still serves. Only the very first call ever (usually the boot warmup)
 * computes synchronously and fails loudly, since there is nothing to
 * serve yet. Shared process-wide.
 */
export const dayPreviews = Effect.gen(function*() {
  if (previewsMemo.value !== null) {
    const now = yield* Clock.currentTimeMillis
    if (now < previewsMemo.expiresAt || previewsMemo.refreshing) return previewsMemo.value
    // Expired: answer now, converge behind. refreshDayPreviews is
    // single-flight, so a fork storm just collapses.
    yield* Effect.forkDetach(refreshDayPreviews)
    return previewsMemo.value
  }
  // Cold boot: serve the last snapshot instantly (marked expired so the
  // next call reconverges behind), and only derive synchronously when no
  // snapshot exists yet.
  const snapshot = yield* readSnapshot
  if (snapshot !== null) {
    const value = snapshot
    const now = yield* Clock.currentTimeMillis
    storePreviews(value, now)
    // Already expired: the next call serves this instantly and reconverges behind.
    previewsMemo.expiresAt = now
    return value
  }
  const value = yield* currentDayPreviews
  storePreviews(value, yield* Clock.currentTimeMillis)
  yield* writeSnapshot(value)
  return value
})

/**
 * The journals to render, newest day first.
 *
 * Enumeration starts from what is on disk, not from the eager instance list:
 * a development window narrows what gets *pre-generated*, and the pages
 * should still show every journal the record holds.
 *
 * When the current input set has no journal yet (a correction landed, or
 * today gained a recording), the most recently *generated* journal for that
 * day is shown and marked stale. Picking by `generatedAt` matters: the
 * alternative -- taking the last key in sort order -- sorts by input hash,
 * which is arbitrary, so a day with several journals could show an older one
 * with no way to tell.
 */
export const currentJournals = Effect.gen(function*() {
  const byDay = yield* journalKeysByDay
  const instances = yield* journalResource.instances
  const currentKey = new Map(instances.map((instance) => [instance.label, instance.key]))
  const views: Array<JournalView> = []
  for (const [day, keys] of byDay) {
    if (keys.length === 0) continue
    const wanted = currentKey.get(day)
    if (wanted && keys.includes(wanted)) {
      const journal = yield* Files.readJson(Journal, dataPath(wanted))
      if (Option.isSome(journal)) views.push({ journal: journal.value, stale: false })
      continue
    }
    const candidates = yield* Effect.forEach(keys, (key) => Files.readJson(Journal, dataPath(key)))
    const newest = candidates
      .flatMap((candidate) => Option.isSome(candidate) ? [candidate.value] : [])
      .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))
      .at(-1)
    // Outside the eager window there is no current key to compare against,
    // so what is on disk is simply what the record has.
    if (newest) views.push({ journal: newest, stale: wanted !== undefined })
  }
  return views.sort((a, b) => b.journal.day.localeCompare(a.journal.day))
}).pipe(Effect.withSpan("views.currentJournals"))
