/**
 * The lifelog, as a whole: sources collect evidence, attribution interprets
 * it, and everything served is derived from the result. Each stage lives in
 * its own module; this re-exports them as the application's surface.
 *
 * - `Audio` / `Notes` / `HttpIngest` — sources. They record what they saw
 *   and interpret nothing.
 * - `Attribution` — the believed time, zone, channel, and day of a capture,
 *   correctable via `correction/<captureId>.json`.
 * - `DayIndex` — the one derived view over all attributions, so serving
 *   never scans the corpus.
 * - `Journal` — a day's journal, written by the LLM from that day's
 *   transcripts, note, and movement.
 * - `Views` — what the HTTP layer reads.
 */
export { audioSource } from "./Audio.ts"
export { notesSource, noteForDay, NOTE_RECHECK_DAYS, NOTE_WINDOW_DAYS } from "./Notes.ts"
export { httpIngest } from "./HttpIngest.ts"
export { attributionResource, currentAttribution, readCorrections, transcribedCaptures } from "./Attribution.ts"
export { currentDayIndex, dayIndexResource, dayTranscripts } from "./DayIndex.ts"
export {
  journalCachedForDay,
  journalForDay,
  journalInputHash,
  journalResource,
  JournalWorkflow,
  JournalWorkflowLayer,
  notesForDay,
  notesResource,
  NotesWorkflowLayer,
  todayDay
} from "./Journal.ts"
export { currentJournals, pipelineStatus, type JournalView } from "./Views.ts"
export { homeTimeZone } from "./Time.ts"
