/**
 * Server handlers for the journals RPC group. Read-only, like the request
 * path they mirror: `currentJournals` and `journalCachedForDay` never
 * materialize, so serving costs no LLM calls.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { currentJournals, dayPreviews } from "./Views.ts"
import { journalCachedForDay } from "./Journal.ts"
import { ApiError, DayRow, JournalEntry, JournalsGroup } from "./JournalApi.ts"

const toApiError = (error: unknown) => new ApiError({ message: String(error) })

export const JournalsHandlersLive = JournalsGroup.toLayer({
  ListJournals: ({ limit }) =>
    Effect.map(
      currentJournals,
      (views) => views.slice(0, limit ?? views.length).map((view) => new JournalEntry(view))
    ).pipe(
      Effect.mapError(toApiError),
      Effect.withSpan("rpc.ListJournals", { attributes: { limit: limit ?? -1 } })
    ),
  GetJournal: ({ day }) =>
    Effect.map(journalCachedForDay(day), Option.getOrNull).pipe(
      Effect.mapError(toApiError),
      Effect.withSpan("rpc.GetJournal", { attributes: { day } })
    ),
  ListDays: ({ limit, offset }) =>
    Effect.map(
      dayPreviews,
      (rows) => {
        const start = offset ?? 0
        const end = limit === undefined ? rows.length : start + limit
        return rows.slice(start, end).map((row) => new DayRow(row))
      }
    ).pipe(
      Effect.mapError(toApiError),
      Effect.withSpan("rpc.ListDays", { attributes: { limit: limit ?? -1, offset: offset ?? 0 } })
    )
})
