/**
 * Server handlers for the journals RPC group. Read-only, like the request
 * path they mirror: `currentJournals` and `journalCachedForDay` never
 * materialize, so serving costs no LLM calls.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { currentJournals } from "./Views.ts"
import { journalCachedForDay } from "./Journal.ts"
import { ApiError, JournalEntry, JournalsGroup } from "./JournalApi.ts"

const toApiError = (error: unknown) => new ApiError({ message: String(error) })

export const JournalsHandlersLive = JournalsGroup.toLayer({
  ListJournals: ({ limit }) =>
    Effect.map(
      currentJournals,
      (views) => views.slice(0, limit ?? views.length).map((view) => new JournalEntry(view))
    ).pipe(Effect.mapError(toApiError)),
  GetJournal: ({ day }) =>
    Effect.map(journalCachedForDay(day), Option.getOrNull).pipe(Effect.mapError(toApiError))
})
