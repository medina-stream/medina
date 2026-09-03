/**
 * Derived views over the data dir: what the HTTP layer serves.
 *
 * Journal files live at `journal/<version>/<day>/<inputHash>.json`, so a
 * day's journals are found by splitting that path -- never by substring
 * matching, which would also match a day appearing inside a hash.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Files from "../lib/Files.ts"
import { RUN_REPORT_KEY, RunReport } from "../lib/Pipeline.ts"
import { currentDayIndex } from "./DayIndex.ts"
import { journalResource } from "./Journal.ts"
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
})
