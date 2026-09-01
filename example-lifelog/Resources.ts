/**
 * Resource shapes and keys: what gets materialized into the data dir, plus
 * capture-time rules.
 *
 * The schemas intentionally match the JSON written by the previous
 * Cloudflare implementation, so existing transcripts and journals under
 * `data/artifacts` are reused as-is instead of re-processing audio.
 */
import * as Schema from "effect/Schema"
import { join } from "node:path"

/** Where the data lives: a plain directory (local disk, or a mounted
 * filesystem such as an Archil disk). Keys below are paths relative to it. */
export const DATA_DIR = process.env.DATA_DIR ?? "data/artifacts"

export const dataPath = (key: string) => join(DATA_DIR, key)

export const TRANSCRIPT_VERSION = "assemblyai-u35p-v1"
export const JOURNAL_VERSION = "journal-v4"
export const NOTE_VERSION = "notes-git-v1"

export const noteKey = (ingestId: string) => `note/${NOTE_VERSION}/${ingestId}.json`

/** One note file as of a git commit, captured from the notes checkout. */
export class Note extends Schema.Class<Note>("Note")({
  provider: Schema.Literal("git"),
  version: Schema.String,
  ingestId: Schema.String,
  path: Schema.String,
  blobSha: Schema.String,
  capturedAt: Schema.NullOr(Schema.String),
  importedAt: Schema.String,
  text: Schema.String
}) {}

export const transcriptKey = (ingestId: string) => `transcript/${TRANSCRIPT_VERSION}/${ingestId}.json`
export const vendorKey = (ingestId: string) => `transcript/${TRANSCRIPT_VERSION}/${ingestId}.assemblyai.json`
export const journalKey = (day: string, inputHash: string) => `journal/${JOURNAL_VERSION}/${day}/${inputHash}.json`

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

/** The calendar day a capture belongs to, in the capture's own local time. */
export const captureDay = (capturedAt: string) => capturedAt.slice(0, 10)

export const ingestId = (sourceName: string, fileId: string, checksum: string) =>
  `${sourceName}-${fileId}-${checksum}`.replace(/[^a-zA-Z0-9_-]/g, "")
