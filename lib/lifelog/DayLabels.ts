/**
 * How a day is written in the UI.
 *
 * Pure and DOM-free so the browser bundle and tests share them. `today` is
 * always passed in rather than read from the clock: these are used in a
 * virtual list that repaints constantly, and a hidden clock read would make
 * rows untestable and inconsistent within one paint.
 *
 * Days are civil `YYYY-MM-DD` strings throughout Medina, and the arithmetic
 * here stays on that string form (via UTC) on purpose -- constructing local
 * `Date`s would let the host's zone shift which day a row claims to be.
 */

const DAY_MS = 86_400_000

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** Midnight UTC for a civil day, or NaN if it is not a day. */
const dayMs = (day: string): number =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN

/**
 * The app's day id: a `0` prefix and the compact date, e.g. `020260901`.
 *
 * This matches the recorder's own filename convention
 * (`sco-lifelog-020260907T110112.m4a`), so what the UI shows and what the
 * URL carries line up with the source files. Civil `YYYY-MM-DD` stays the
 * canonical form everywhere inside Medina -- this is a display and routing
 * skin over it, and `parseDayId` is its inverse.
 */
export const DAY_ID_PREFIX = "0"

export const dayId = (day: string): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${DAY_ID_PREFIX}${day.replaceAll("-", "")}` : day

/**
 * A day id back to a civil day, or `null` if it is not one.
 *
 * Plain `YYYY-MM-DD` and an unprefixed `YYYYMMDD` are both accepted, so
 * older links and hand-typed URLs keep working.
 */
export const parseDayId = (id: string): string | null => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(id)) return id
  const match = id.match(/^0?(\d{4})(\d{2})(\d{2})$/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

/**
 * A short human bearing on a day, relative to `today`:
 *
 * - today and its neighbours by name (`Today`, `Yesterday`, `Tomorrow`)
 * - within the last week, the weekday (`Monday`)
 * - the week before that, `Last Tue`
 * - anything else, `Aug 3` -- plus the year once it is not this year
 */
export const relativeDay = (day: string, today: string): string => {
  const target = dayMs(day)
  const now = dayMs(today)
  if (Number.isNaN(target) || Number.isNaN(now)) return ""
  const delta = Math.round((target - now) / DAY_MS)
  if (delta === 0) return "Today"
  if (delta === -1) return "Yesterday"
  if (delta === 1) return "Tomorrow"
  const date = new Date(target)
  if (delta < 0 && delta >= -6) return WEEKDAYS[date.getUTCDay()]!
  if (delta < 0 && delta >= -13) return `Last ${WEEKDAYS_SHORT[date.getUTCDay()]}`
  const month = MONTHS[date.getUTCMonth()]!
  const sameYear = day.slice(0, 4) === today.slice(0, 4)
  return sameYear
    ? `${month} ${date.getUTCDate()}`
    : `${month} ${date.getUTCDate()}, ${date.getUTCFullYear()}`
}

/**
 * Recorded audio as a short duration: `4h 20m`, `35m`, `40s`.
 *
 * Empty string for nothing at all, so a day with no audio simply shows no
 * badge rather than a misleading `0h`.
 */
export const audioLabel = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 1) return ""
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.round((total % 3600) / 60)
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (total >= 60) return `${Math.max(1, minutes)}m`
  return `${total}s`
}
