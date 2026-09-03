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

export const JournalsGroup = RpcGroup.make(ListJournals, GetJournal)
