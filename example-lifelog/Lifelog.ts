/**
 * The lifelog, as a whole: sources collect evidence, attribution interprets
 * it, and everything served is derived from the result. Each stage lives in
 * its own module; this re-exports them as the application's surface.
 *
 * The implementations are Medina library capabilities. This compatibility
 * surface adds only Scott's notes-repository policy.
 */
export { audioSource, recordingObjectSource } from "../lib/capture/index.ts"
export { notesSource, noteForDay, NOTE_RECHECK_DAYS, NOTE_WINDOW_DAYS } from "./Notes.ts"
export { httpIngest } from "../lib/capture/index.ts"
export { attributionResource, currentAttribution, readCorrections, transcribedCaptures } from "../lib/lifelog/Attribution.ts"
export { currentDayIndex, dayIndexResource, dayTranscripts, dayTranscriptDetail } from "../lib/lifelog/DayIndex.ts"
export { transcriptSearchResource, searchTranscripts } from "../lib/lifelog/TranscriptSearch.ts"
export {
  hasJournalInputs,
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
} from "../lib/lifelog/Journal.ts"
export { currentJournals, pipelineStatus, type JournalView } from "../lib/lifelog/Views.ts"
export { homeTimeZone } from "../lib/lifelog/Time.ts"
