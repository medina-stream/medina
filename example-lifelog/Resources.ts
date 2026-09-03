/**
 * Resource shapes and keys: what gets materialized into the data dir, plus
 * capture-time rules.
 *
 * The schemas intentionally match the JSON written by the previous
 * Cloudflare implementation, so existing transcripts and journals under
 * the data dir are reused as-is instead of re-processing audio.
 */
import * as Schema from "effect/Schema"
import { join } from "node:path"

/** Where the data lives: a plain directory (local disk, or a mounted
 * filesystem such as an Archil disk). Keys below are paths relative to it. */
export const DATA_DIR = process.env.DATA_DIR ?? "data/artifacts"

export const dataPath = (key: string) => join(DATA_DIR, key)

export const TRANSCRIPT_VERSION = "assemblyai-u35p-v1"
export const JOURNAL_VERSION = "journal-v5"
/** Notes are keyed by the day they are about, not by ingest id: exactly one
 * journal note per day is what the journal reads. The previous
 * `notes-git-v1` (every markdown file in the checkout, keyed by ingest id)
 * is superseded -- its files are inert and can be deleted. */
export const NOTE_VERSION = "notes-day-v1"
export const ATTRIBUTION_VERSION = "attribution-v1"
export const DAY_INDEX_VERSION = "days-v1"

/** The main body-recorder channel. Channels separate simultaneous audio
 * perspectives within the stream (e.g. a future headphone-audio channel). */
export const CHANNEL_MAIN = "lifelog-audio-1"

export const noteKey = (day: string) => `note/${NOTE_VERSION}/${day}.json`

/** One note file as of a git commit, captured from the notes checkout. */
export class Note extends Schema.Class<Note>("Note")({
  provider: Schema.Literal("git"),
  version: Schema.String,
  ingestId: Schema.String,
  /** The civil day this note is about (from its `Journal/<day>.md` name). */
  day: Schema.String,
  path: Schema.String,
  blobSha: Schema.String,
  capturedAt: Schema.NullOr(Schema.String),
  importedAt: Schema.String,
  text: Schema.String
}) {}

export const transcriptKey = (ingestId: string) => `transcript/${TRANSCRIPT_VERSION}/${ingestId}.json`
export const vendorKey = (ingestId: string) => `transcript/${TRANSCRIPT_VERSION}/${ingestId}.assemblyai.json`
export const journalKey = (day: string, inputHash: string) => `journal/${JOURNAL_VERSION}/${day}/${inputHash}.json`

/** LLM-derived notes from a day's transcripts. Keyed by a hash of the
 * transcript set (the notes version + each transcript key + correction
 * hash), so a new or corrected transcript stales exactly that day's notes.
 * Movement and the day's written note are NOT part of the key — notes are
 * extraction from audio only, and re-running them when movement changes is
 * the waste this resource eliminates. */
export const NOTES_LLM_VERSION = "notes-llm-v1"
export const notesLlmKey = (day: string, inputHash: string) => `notes/${NOTES_LLM_VERSION}/${day}/${inputHash}.json`

/** LLM-derived notes from a day's audio transcripts. Stable across movement
 * and note changes: transcripts are immutable, so the notes are re-derivable
 * and cached on disk. The journal reads this instead of re-running the notes
 * LLM pass every time its own basis changes. */
export class NotesLlm extends Schema.Class<NotesLlm>("NotesLlm")({
  version: Schema.String,
  day: Schema.String,
  inputHash: Schema.String,
  generatedAt: Schema.String,
  notes: Schema.Array(Schema.String)
}) {}

export class Utterance extends Schema.Class<Utterance>("Utterance")({
  speaker: Schema.NullOr(Schema.String),
  startMs: Schema.Number,
  endMs: Schema.Number,
  text: Schema.String,
  confidence: Schema.NullOr(Schema.Number)
}) {}

export class Transcript extends Schema.Class<Transcript>("Transcript")({
  provider: Schema.Literal("assemblyai"),
  version: Schema.String,
  ingestId: Schema.String,
  inputKey: Schema.String,
  capturedAt: Schema.optional(Schema.String),
  transcriptId: Schema.NullOr(Schema.String),
  vendorKey: Schema.NullOr(Schema.String),
  status: Schema.Literals(["completed", "error"]),
  completedAt: Schema.String,
  text: Schema.NullOr(Schema.String),
  utterances: Schema.Array(Utterance),
  error: Schema.NullOr(Schema.String)
}) {}

export class Journal extends Schema.Class<Journal>("Journal")({
  version: Schema.String,
  day: Schema.String,
  inputHash: Schema.String,
  transcriptKeys: Schema.Array(Schema.String),
  model: Schema.NullOr(Schema.String),
  generatedAt: Schema.String,
  status: Schema.Literal("completed"),
  report: Schema.String
}) {}

/** The subset of the old triage record needed to recover capture times. */
export class Triage extends Schema.Class<Triage>("Triage")({
  filename: Schema.String,
  receivedAt: Schema.String
}) {}

/**
 * When the content was recorded, as opposed to when it was received. Source
 * filenames carry `...YYYYMMDDThhmmss...`; the Drive modified time is the
 * fallback.
 */
export const captureTime = (filename: string, modifiedTime: string): string => {
  const stamp = filename.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/)
  if (stamp) {
    const [, year, month, day, hour, minute, second] = stamp
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`
  }
  return modifiedTime.replace(/(\.\d+)?Z$/, "")
}

export const ingestId = (sourceName: string, fileId: string, checksum: string) =>
  `${sourceName}-${fileId}-${checksum}`.replace(/[^a-zA-Z0-9_-]/g, "")

// --- captures: contenthash identity + provenance ----------------------------

/**
 * A capture's id is the sha256 of its bytes. Everything the source knew about
 * the file (filename, Drive id, times — often the only clue to when it was
 * recorded) is preserved as provenance beside the blob; ingest never discards
 * source metadata, and never interprets it — that is attribution's job.
 *
 * Legacy captures (pre-contenthash, audio not retained) use their old
 * `ingestId` as capture id; their evidence lives in the transcript's
 * `capturedAt` and `triage/` records instead of provenance.
 */
export const captureDir = (captureId: string) => `capture/${captureId}`
export const provenanceKey = (captureId: string) => `${captureDir(captureId)}/provenance.json`

/** The blob keeps its original filename (sanitized), so provenance survives
 * even if every JSON record were lost. */
export const captureBlobName = (filename: string) => {
  const name = filename.replace(/[/\\]/g, "_")
  return name === "provenance.json" || name.startsWith(".tmp-") ? `_${name}` : name
}

export class ProvenanceRecord extends Schema.Class<ProvenanceRecord>("ProvenanceRecord")({
  source: Schema.String,
  filename: Schema.String,
  fileId: Schema.String,
  mimeType: Schema.String,
  modifiedTime: Schema.String,
  md5Checksum: Schema.NullOr(Schema.String),
  fetchedAt: Schema.String
}) {}

export class Provenance extends Schema.Class<Provenance>("Provenance")({
  captureId: Schema.String,
  records: Schema.Array(ProvenanceRecord)
}) {}

/** Source-side receipt that a source file has been ingested, so a pass can
 * skip it with one existence check (the capture id is not derivable from
 * source metadata alone — hashing requires the bytes). */
export const ingestReceiptKey = (sourceName: string, fileId: string, checksum: string) =>
  `ingest/${sourceName}/${`${fileId}-${checksum}`.replace(/[^a-zA-Z0-9_-]/g, "")}.json`

export class IngestReceipt extends Schema.Class<IngestReceipt>("IngestReceipt")({
  captureId: Schema.String,
  ingestedAt: Schema.String
}) {}

// --- attribution: believed time/zone/channel, correctable -------------------

/**
 * Attribution is the interpretation layer: for each capture, the believed
 * UTC start instant, IANA zone, and channel, derived from evidence (never
 * mutated at ingest). A correction file, when present, overrides the guess.
 *
 * Freshness follows the key-bakes-basis-hash scheme: the file lives at
 * `attribution/<version>/<captureId>/<basisHash>.json`, where the basis
 * covers the attribution version and the correction text. Evidence files
 * (transcripts, triage, provenance) are immutable, so they participate in
 * materialization but not the basis.
 */
export const attributionDir = (captureId: string) => `attribution/${ATTRIBUTION_VERSION}/${captureId}`
export const attributionKey = (captureId: string, basisHash: string) =>
  `${attributionDir(captureId)}/${basisHash}.json`

export class Attribution extends Schema.Class<Attribution>("Attribution")({
  version: Schema.String,
  captureId: Schema.String,
  channel: Schema.String,
  /** UTC instant, full ISO; null when no evidence yields a guess. */
  estimatedStartTime: Schema.NullOr(Schema.String),
  /** IANA zone the capture is believed recorded in (never a bare offset). */
  timeZone: Schema.NullOr(Schema.String),
  /** Local civil date at estimatedStartTime in timeZone: the journal day. */
  day: Schema.NullOr(Schema.String),
  method: Schema.String,
  confidence: Schema.Literals(["high", "medium", "low", "corrected", "none"]),
  attributedAt: Schema.String
}) {}

/** Hand-written (or API-written) override for one capture. Partial: set only
 * the fields being corrected. `estimatedStartTime` is a UTC instant. */
export const correctionKey = (captureId: string) => `correction/${captureId}.json`

export class Correction extends Schema.Class<Correction>("Correction")({
  estimatedStartTime: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String)
}) {}

// --- day index: the one derived view over all attributions ------------------

/** One file answering “which captures (with usable transcripts) belong to
 * which day”, so serving never scans the corpus. Keyed by a hash of the
 * current attribution + transcript sets; any change stales it. */
export const dayIndexKey = (inputHash: string) => `index/${DAY_INDEX_VERSION}/${inputHash}.json`

export class DayEntry extends Schema.Class<DayEntry>("DayEntry")({
  captureId: Schema.String,
  transcriptKey: Schema.String,
  startTime: Schema.String,
  timeZone: Schema.String,
  channel: Schema.String,
  /** sha256 of the correction file applied to this capture, if any — flows
   * into the journal's input hash so corrections re-journal the day. */
  correctionHash: Schema.NullOr(Schema.String)
}) {}

export class DayIndex extends Schema.Class<DayIndex>("DayIndex")({
  version: Schema.String,
  inputHash: Schema.String,
  builtAt: Schema.String,
  days: Schema.Record(Schema.String, Schema.Array(DayEntry))
}) {}
