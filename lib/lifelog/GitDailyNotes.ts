/**
 * Import one conventionally named text note per civil day from Git.
 * Applications provide the path-to-day rule and recency policy; this module
 * provides incremental blob-SHA freshness and normalized note artifacts.
 */
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Files from "../Files.ts"
import { Git } from "../Git.ts"
import type { Source, SourceReport } from "../Resource.ts"
import { dataPath, ingestId, Note, NOTE_VERSION, noteKey } from "./Resources.ts"

export interface GitDailyNotesOptions {
  readonly repo: string
  readonly dayFromPath: (path: string) => string | null
  readonly windowDays: number
  readonly recheckDays: number
  readonly sourceName?: string
}

const daysBefore = (now: DateTime.Utc, days: number) =>
  DateTime.formatIsoDate(DateTime.subtract(now, { days }))

export const gitDailyNotesSource = (
  options: GitDailyNotesOptions
): Source<Git | FileSystem.FileSystem> => ({
  name: options.sourceName ?? "notes",
  ingest: Effect.gen(function*() {
    const sourceName = options.sourceName ?? "notes"
    const git = yield* Git
    const now = yield* DateTime.now
    const today = DateTime.formatIsoDate(now)
    const oldest = daysBefore(now, options.windowDays)
    const settled = daysBefore(now, options.recheckDays)

    const all = yield* git.listFiles(options.repo)
    // The filename carries the day, so no subprocess is needed to date these.
    const inWindow = all.flatMap((file) => {
      const day = options.dayFromPath(file.path)
      if (day === null) return []
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

        const text = yield* git.readBlob(options.repo, file.blobSha)
        yield* Files.writeJson(
          dataPath(noteKey(file.day)),
          new Note({
            provider: "git",
            version: NOTE_VERSION,
            ingestId: ingestId(sourceName, file.path, file.blobSha),
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
