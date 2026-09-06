/** Scott's notes-repository convention and recency policy. */
import { gitDailyNotesSource } from "../lib/lifelog/GitDailyNotes.ts"

export { noteBasisHash, noteForDay } from "../lib/lifelog/DailyNotes.ts"

export const NOTE_WINDOW_DAYS = 90
export const NOTE_RECHECK_DAYS = 2

const JOURNAL_NOTE = /^Journal\/(\d{4}-\d{2}-\d{2})\.md$/

export const notesSource = (repo: string) => gitDailyNotesSource({
  repo,
  sourceName: "notes",
  windowDays: NOTE_WINDOW_DAYS,
  recheckDays: NOTE_RECHECK_DAYS,
  dayFromPath: (path) => JOURNAL_NOTE.exec(path)?.[1] ?? null
})
