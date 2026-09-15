/**
 * Pure row-layout helpers for the journal's virtual list.
 *
 * Today, Yesterday, and the ghost Tomorrow render as special kinds inside
 * the list's own flow, each with its own *fixed* height. Heights are
 * per-kind constants -- content is clamped and can never change a row's
 * height, so the virtual list's static offset math stays exact.
 *
 * Nothing here touches the server: "today" is the viewer's civil day, and
 * the ghost Tomorrow is pure presentation.
 */

export const ROW_H = 100
export const TODAY_H = 148
export const YESTERDAY_H = 124
export const TOMORROW_H = 64
/** The ghost Tomorrow row appears this close to local midnight. */
export const GHOST_TOMORROW_MS = 60 * 60 * 1000
/** The Today "data is flowing" light stays lit this long after the last
 * live day-event for today. */
export const LIVE_HOLD_MS = 60 * 1000

/** The fields of a day row that layout needs. */
export interface TableRow {
  readonly day: string
  readonly ghost?: boolean
}

/** Shift a civil day by whole days, staying on the civil calendar. */
export const shiftDay = (day: string, delta: number): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (match === null) return ""
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  date.setDate(date.getDate() + delta)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Fixed height for a row's kind. Never derived from content. */
export const rowHeight = (row: TableRow, today: string, yesterday: string): number => {
  if (row.ghost === true) return TOMORROW_H
  if (row.day === today) return TODAY_H
  if (row.day === yesterday) return YESTERDAY_H
  return ROW_H
}
