/**
 * Day-path queries for the journal view: the ordered, deduplicated fixes
 * of one *local* day.
 *
 * The GPS store (`Gps.ts`) partitions by UTC day; the journal day is a
 * civil day in the home timezone. One local day always spans two UTC
 * partitions, so this merges both and filters to the local-day bounds.
 */
import * as Effect from "effect/Effect"
import { gpsDay } from "./Gps.ts"
import { homeTimeZone } from "./Time.ts"

export interface GpsPathPoint {
  readonly source: string
  readonly ts: string
  readonly lat: number
  readonly lon: number
  readonly speed: number | null
  readonly alt: number | null
  readonly acc: number | null
  readonly batt: number | null
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Minutes the zone is ahead of UTC at the given instant. */
const offsetMinutesAt = (utcMs: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const asUtcMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  )
  return Math.round((asUtcMs - utcMs) / 60_000)
}

/**
 * The UTC instants of local midnight at the start and end of a civil day.
 * Fixed-point iteration handles DST transitions (the offset depends on the
 * instant, which depends on the offset). Null for a malformed day.
 */
export const localDayBounds = (
  day: string,
  timeZone: string
): { readonly start: Date; readonly end: Date } | null => {
  const match = DAY_RE.exec(day)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const date = Number(match[3])
  if (month < 1 || month > 12 || date < 1 || date > 31) return null
  const midnight = (y: number, mo: number, d: number): number => {
    let utcMs = Date.UTC(y, mo - 1, d)
    for (let i = 0; i < 3; i++) {
      utcMs = Date.UTC(y, mo - 1, d) - offsetMinutesAt(utcMs, timeZone) * 60_000
    }
    return utcMs
  }
  const startMs = midnight(year, month, date)
  // Guard against rolled-over calendar dates (Feb 30 becomes Mar 2).
  const check = new Date(startMs + offsetMinutesAt(startMs, timeZone) * 60_000)
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== date
  ) {
    return null
  }
  const next = new Date(Date.UTC(year, month - 1, date) + 86_400_000)
  const endMs = midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())
  return { start: new Date(startMs), end: new Date(endMs) }
}

/**
 * Pure merge: drop out-of-bounds and duplicate fixes, order by time.
 * Exported for tests; `gpsLocalDay` is the effectful entry point.
 */
export const selectLocalDay = (
  points: ReadonlyArray<GpsPathPoint>,
  start: Date,
  end: Date
): Array<GpsPathPoint> => {
  const seen = new Set<string>()
  const startMs = start.getTime()
  const endMs = end.getTime()
  const out: Array<GpsPathPoint> = []
  for (const point of points) {
    const ms = Date.parse(point.ts)
    if (!Number.isFinite(ms) || ms < startMs || ms >= endMs) continue
    const key = `${point.source}|${point.ts}|${point.lat}|${point.lon}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(point)
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
}

/**
 * The day's path in home-timezone terms: both overlapping UTC partitions
 * (plus inbox rows, via gpsDay) merged, filtered to the local day,
 * chronological.
 */
export const gpsLocalDay = (day: string) =>
  Effect.gen(function*() {
    const timeZone = yield* homeTimeZone
    const bounds = localDayBounds(day, timeZone)
    if (bounds === null) return []
    const days = [
      ...new Set([
        bounds.start.toISOString().slice(0, 10),
        new Date(bounds.end.getTime() - 1).toISOString().slice(0, 10)
      ])
    ].sort()
    const points: Array<GpsPathPoint> = []
    for (const utcDay of days) points.push(...(yield* gpsDay(utcDay)))
    return selectLocalDay(points, bounds.start, bounds.end)
  })
