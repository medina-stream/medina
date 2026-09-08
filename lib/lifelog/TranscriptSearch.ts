/**
 * Local full-text index over normalized transcript passages.
 *
 * The index is a pipeline artifact, not a request-path cache: searching never
 * transcribes, asks an LLM, or walks the corpus. A small latest.json pointer
 * swaps only after the SQLite file has been atomically published.
 */
import { Database } from "bun:sqlite"
import { mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Resource } from "../Resource.ts"
import * as Files from "../Files.ts"
import { sha256 } from "../Hash.ts"
import { dayTranscripts, currentDayIndex } from "./DayIndex.ts"
import { StartTimeRulesService } from "./StartTimeRules.ts"
import {
  dataPath,
  type DayIndex,
  TRANSCRIPT_SEARCH_VERSION,
  transcriptSearchKey,
  transcriptSearchIndexKey,
  transcriptSearchLatestKey
} from "./Resources.ts"

const MAX_RESULTS = 50

export class TranscriptSearchIndex extends Schema.Class<TranscriptSearchIndex>("TranscriptSearchIndex")({
  version: Schema.String,
  inputHash: Schema.String,
  key: Schema.String,
  builtAt: Schema.String
}) {}

export interface TranscriptSearchResult {
  readonly day: string
  readonly captureId: string
  readonly startTime: string
  readonly timeZone: string
  readonly speaker: string | null
  readonly startMs: number
  readonly endMs: number
  readonly excerpt: string
}

type SearchDocument = Omit<TranscriptSearchResult, "excerpt">

const indexBasis = Effect.map(currentDayIndex, (index) => ({
  index,
  inputHash: sha256(`${TRANSCRIPT_SEARCH_VERSION}\n${index.inputHash}`)
}))

const documentsForIndex = Effect.fn("documentsForTranscriptSearch")(function*(index: DayIndex) {
  const documents: Array<SearchDocument & { text: string }> = []
  for (const day of Object.keys(index.days)) {
    const inputs = yield* dayTranscripts(index, day)
    for (const { entry, transcript } of inputs) {
      const utterances = transcript.utterances.length > 0
        ? transcript.utterances
        : transcript.text?.trim()
          ? [{ speaker: null, startMs: 0, endMs: 0, text: transcript.text, confidence: null }]
          : []
      for (const utterance of utterances) {
        if (!utterance.text.trim()) continue
        documents.push({
          day,
          captureId: entry.captureId,
          startTime: entry.startTime,
          timeZone: entry.timeZone,
          speaker: utterance.speaker,
          startMs: utterance.startMs,
          endMs: utterance.endMs,
          text: utterance.text
        })
      }
    }
  }
  return documents
})

const publishIndex = (key: string, inputHash: string, documents: ReadonlyArray<SearchDocument & { text: string }>) =>
  Effect.try({
    try: () => {
      const path = dataPath(key)
      const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
      mkdirSync(dirname(path), { recursive: true })
      try {
        const db = new Database(tmp, { create: true })
        try {
          db.run("PRAGMA journal_mode = OFF")
          db.run("CREATE TABLE passages (id INTEGER PRIMARY KEY, day TEXT NOT NULL, capture_id TEXT NOT NULL, start_time TEXT NOT NULL, time_zone TEXT NOT NULL, speaker TEXT, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL)")
          db.run("CREATE VIRTUAL TABLE passages_fts USING fts5(text, tokenize = 'unicode61')")
          const metadata = db.prepare("INSERT INTO passages (day, capture_id, start_time, time_zone, speaker, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
          const fullText = db.prepare("INSERT INTO passages_fts (rowid, text) VALUES (?, ?)")
          const insert = db.transaction((rows: ReadonlyArray<SearchDocument & { text: string }>) => {
            for (const row of rows) {
              const result = metadata.run(row.day, row.captureId, row.startTime, row.timeZone, row.speaker, row.startMs, row.endMs)
              fullText.run(Number(result.lastInsertRowid), row.text)
            }
          })
          insert(documents)
        } finally {
          db.close()
        }
        renameSync(tmp, path)
      } catch (error) {
        rmSync(tmp, { force: true })
        throw error
      }
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause))
  }).pipe(
    Effect.andThen(Files.writeJson(
      dataPath(transcriptSearchLatestKey),
      new TranscriptSearchIndex({
        version: TRANSCRIPT_SEARCH_VERSION,
        inputHash,
        key,
        builtAt: new Date().toISOString()
      })
    )),
    Effect.andThen(Files.writeJson(
      dataPath(transcriptSearchIndexKey(inputHash)),
      new TranscriptSearchIndex({
        version: TRANSCRIPT_SEARCH_VERSION,
        inputHash,
        key,
        builtAt: new Date().toISOString()
      })
    ))
  )

export const transcriptSearchResource: Resource<FileSystem.FileSystem | StartTimeRulesService> = {
  name: "transcript-search",
  instances: Effect.map(indexBasis, ({ index, inputHash }) => [{
    key: transcriptSearchIndexKey(inputHash),
    label: inputHash.slice(0, 12),
    dependencies: Object.values(index.days).flat().map((entry) => entry.transcriptKey),
    materialize: Effect.flatMap(documentsForIndex(index), (documents) =>
      publishIndex(transcriptSearchKey(inputHash), inputHash, documents)
    )
  }])
}

/** Turns untrusted user text into FTS terms rather than accepting FTS query
 * syntax. This gives predictable AND semantics and avoids malformed queries. */
const ftsQuery = (query: string) =>
  query.match(/"[^"\r\n]+"|[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)?.map((part) => {
    const term = part.startsWith('"') ? part.slice(1, -1) : part
    return `"${term.replaceAll('"', '""')}"`
  }).join(" AND ") ?? ""

export const searchTranscripts = (query: string, requestedLimit?: number) =>
  Effect.gen(function*() {
    const fts = ftsQuery(query)
    if (!fts) return [] as ReadonlyArray<TranscriptSearchResult>
    const latest = yield* Files.readJson(TranscriptSearchIndex, dataPath(transcriptSearchLatestKey))
    if (Option.isNone(latest)) return [] as ReadonlyArray<TranscriptSearchResult>
    const path = dataPath(latest.value.key)
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(path))) return [] as ReadonlyArray<TranscriptSearchResult>
    const limit = Math.max(1, Math.min(Math.floor(requestedLimit ?? 20), MAX_RESULTS))
    return yield* Effect.try({
      try: () => {
        const db = new Database(path, { readonly: true })
        try {
          const rows = db.query<{
            day: string; captureId: string; startTime: string; timeZone: string; speaker: string | null
            startMs: number; endMs: number; excerpt: string
          }, [string, number]>(
            "SELECT p.day, p.capture_id AS captureId, p.start_time AS startTime, p.time_zone AS timeZone, p.speaker, p.start_ms AS startMs, p.end_ms AS endMs, snippet(passages_fts, 0, '', '', '…', 18) AS excerpt FROM passages_fts JOIN passages p ON p.id = passages_fts.rowid WHERE passages_fts MATCH ? ORDER BY bm25(passages_fts), p.start_time, p.start_ms LIMIT ?"
          ).all(fts, limit)
          return rows.map((row) => ({ ...row, speaker: row.speaker ?? null }))
        } finally {
          db.close()
        }
      },
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause))
    })
  })
