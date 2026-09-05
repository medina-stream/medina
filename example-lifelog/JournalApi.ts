/**
 * The typed RPC surface served at POST /rpc and consumed by the home-page
 * SPA. Schemas are the contract: both ends encode and decode against these,
 * so a shape change breaks the build instead of the page.
 *
 * This module is dependency-light on purpose (schemas only) so the browser
 * bundle can import the group without dragging in server code.
 */
import * as Schema from "effect/Schema"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import { Journal } from "./Resources.ts"

/** One journal to show, plus whether it reflects the current input set. */
export class JournalEntry extends Schema.Class<JournalEntry>("JournalEntry")({
  journal: Journal,
  stale: Schema.Boolean
}) {}

/**
 * One row of the days table: identity, freshness, and a truncated report
 * preview. The preview is what the table shows, so scrolling needs no
 * per-day requests — only the day detail view fetches a full journal.
 */
export class DayRow extends Schema.Class<DayRow>("DayRow")({
  day: Schema.String,
  stale: Schema.Boolean,
  preview: Schema.String
}) {}

/** Every RPC in this group fails the same way: a human-readable message. */
export class ApiError extends Schema.Class<ApiError>("ApiError")({
  message: Schema.String
}) {}

export const ListJournals = Rpc.make("ListJournals", {
  payload: { limit: Schema.optional(Schema.Number) },
  success: Schema.Array(JournalEntry),
  error: ApiError
})

export const GetJournal = Rpc.make("GetJournal", {
  payload: { day: Schema.String },
  // Nullable, not Optional: `null` is plain JSON, while `Option` does not
  // survive a JSON round-trip.
  success: Schema.NullOr(Journal),
  error: ApiError
})

/**
 * The virtualized days table, newest first: day + staleness + a truncated
 * preview per row. Served from a process memo with stale-while-revalidate
 * (and an on-disk snapshot for cold boots), so reads never wait on
 * derivation; journals only change on the hourly pipeline pass.
 */
export const ListDays = Rpc.make("ListDays", {
  payload: {
    limit: Schema.optional(Schema.Number),
    offset: Schema.optional(Schema.Number)
  },
  success: Schema.Array(DayRow),
  error: ApiError
})

export const JournalsGroup = RpcGroup.make(ListJournals, GetJournal, ListDays)
