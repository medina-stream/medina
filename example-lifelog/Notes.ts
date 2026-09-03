/**
 * The notes source: the day's own journal note from the notes git checkout,
 * which is evidence the journal writes from alongside transcripts and
 * movement.
 *
 * Only `Journal/YYYY-MM-DD.md` inside the recent window is ingested. The
 * checkout holds thousands of other markdown files; nothing derives from
 * them, so ingesting them cost a `git log` subprocess each to date a file no
 * resource ever read. Scope is enforced here, at the door.
 *
 * Edits are followed only for the last couple of days. A note for a settled
 * day that changes later does not re-ingest: re-journaling old history
 * because a typo was fixed is not worth the LLM call. Recent days do follow
 * edits, since that is when notes are actually being written.
 */
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Files from "../lib/Files.ts"
import { Git } from "../lib/Git.ts"
import type { Source, SourceReport } from "../lib/Resource.ts"
import { dataPath, ingestId, Note, NOTE_VERSION, noteKey } from "./Resources.ts"

const NOTES_SOURCE_NAME = "notes"

/** How far back journal notes are ingested at all. */
export const NOTE_WINDOW_DAYS = 90

/** How far back edits to an already-ingested note are still followed. */
export const NOTE_RECHECK_DAYS = 2

const JOURNAL_NOTE = /^Journal\/(\d{4}-\d{2}-\d{2})\.md$/

const daysBefore = (now: DateTime.Utc, days: number) =>
  DateTime.formatIsoDate(DateTime.subtract(now, { days }))

export const notesSource = (repo: string): Source<Git | FileSystem.FileSystem> => ({
  name: NOTES_SOURCE_NAME,
  ingest: Effect.gen(function*() {
    const git = yield* Git
    const now = yield* DateTime.now
    const today = DateTime.formatIsoDate(now)
    const oldest = daysBefore(now, NOTE_WINDOW_DAYS)
    const settled = daysBefore(now, NOTE_RECHECK_DAYS)

    const all = yield* git.listFiles(repo)
    // The filename carries the day, so no subprocess is needed to date these.
    const inWindow = all.flatMap((file) => {
      const match = file.path.match(JOURNAL_NOTE)
      if (!match) return []
      const day = match[1]!
      if (day < oldest || day > today) return []
      return [{ ...file, day }]
    })

    // One listing tells us which days are already ingested, so deciding what
    // to do costs no per-file round trips.
    const present = new Set(
      (yield* Files.listFiles(dataPath(`note/${NOTE_VERSION}`)))
        .flatMap((entry) => entry.endsWith(".json") ? [entry.replace(/\.json$/, "")] : [])
    )

    const failures: Array<{ item: string; error: string }> = []
    const outcomes = yield* Effect.forEach(inWindow, (file) =>
      Effect.gen(function*() {
        // Settled days: having any version of the note is enough.
        if (file.day < settled && present.has(file.day)) return "cached" as const
        // Recent days: compare the blob sha, so an edit re-ingests.
        if (present.has(file.day)) {
          const existing = yield* Files.readJson(Note, dataPath(noteKey(file.day)))
          if (Option.isSome(existing) && existing.value.blobSha === file.blobSha) return "cached" as const
        }

        const text = yield* git.readBlob(repo, file.blobSha)
        yield* Files.writeJson(
          dataPath(noteKey(file.day)),
          new Note({
            provider: "git",
            version: NOTE_VERSION,
            ingestId: ingestId(NOTES_SOURCE_NAME, file.path, file.blobSha),
            day: file.day,
            path: file.path,
            blobSha: file.blobSha,
            capturedAt: `${file.day}T00:00:00`,
            importedAt: new Date().toISOString(),
            text
          })
        )
        return "ingested" as const
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`note ingest failed for ${file.path}`, cause).pipe(
            Effect.tap(() => Effect.sync(() => failures.push({ item: file.path, error: String(cause).slice(0, 500) }))),
            Effect.as("failed" as const)
          )
        )
      ), { concurrency: 8 })

    const count = (outcome: string) => outcomes.filter((entry) => entry === outcome).length
    return {
      discovered: inWindow.length,
      ingested: count("ingested"),
      cached: count("cached"),
      // Out of scope, rather than work that failed to happen.
      skipped: all.length - inWindow.length,
      failures
    } satisfies SourceReport
  })
})

/** The ingested note for a day, if there is one. */
export const noteForDay = (day: string) => Files.readJson(Note, dataPath(noteKey(day)))

/** A note's blob sha, for journal input hashing: editing the note for a
 * recent day restates the day's evidence, so its journal must re-derive. */
export const noteBasisHash = (day: string) =>
  Effect.map(noteForDay(day), (note) => Option.isSome(note) ? note.value.blobSha : null)
