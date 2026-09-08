/**
 * The typed RPC surface served at POST /rpc and consumed by the home-page
 * SPA. Schemas are the contract: both ends encode and decode against these,
 * so a shape change breaks the build instead of the page.
 *
 * This module is dependency-light on purpose (schemas only) so the browser
 * bundle can import the group without dragging in server code. That
 * constraint is load-bearing in a second way: `effect/Config` reads
 * `import.meta.env`, which a classic `<script>` cannot parse, so anything
 * reachable from here must stay free of it (see `client.bundle.test.ts`).
 *
 * Everything the UI needs comes through this group. The alternative --
 * hand-written interfaces over `fetch` -- had already drifted: the client
 * described pipeline stages as possibly `disabled`, which the server's
 * `RunReport` says they can never be. One definition per shape is the
 * point.
 */
import * as Schema from "effect/Schema"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import { RuntimeEvent } from "../RuntimeEvents.ts"
import { GeocodeResult, Place, PlaceCandidate } from "./Places.ts"
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
  preview: Schema.String,
  /** Seconds of recorded audio behind this day's journal. */
  audioSeconds: Schema.Number
}) {}

/** One matching transcript passage. Times are offsets into the recording;
 * `startTime` and `timeZone` let clients display them as a local clock. */
export class TranscriptSearchHit extends Schema.Class<TranscriptSearchHit>("TranscriptSearchHit")({
  day: Schema.String,
  captureId: Schema.String,
  startTime: Schema.String,
  timeZone: Schema.String,
  speaker: Schema.NullOr(Schema.String),
  startMs: Schema.Number,
  endMs: Schema.Number,
  excerpt: Schema.String
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

/** Local full-text search over normalized transcript passages. The index is
 * built by the pipeline; this read never invokes a vendor or an LLM. */
export const SearchTranscripts = Rpc.make("SearchTranscripts", {
  payload: {
    query: Schema.String,
    limit: Schema.optional(Schema.Number)
  },
  success: Schema.Array(TranscriptSearchHit),
  error: ApiError
})

/**
 * Pipeline health, as `/status` reports it.
 *
 * Sources and stages carry different vocabularies on purpose: a source can
 * be `disabled` (not configured, or excluded by `MEDINA_SOURCES`), while a
 * stage always runs. Modelling them separately is what makes the difference
 * checkable -- the hand-written client interface these replace used one
 * type for both and quietly claimed stages could be disabled.
 */
export const SourceHealth = Schema.Literals(["disabled", "healthy", "empty", "degraded", "failing"])
export type SourceHealth = typeof SourceHealth["Type"]

export const StageHealth = Schema.Literals(["healthy", "empty", "degraded", "failing"])
export type StageHealth = typeof StageHealth["Type"]

/** Per-read counters shared by sources and stages. */
const counts = {
  discovered: Schema.Number,
  ingested: Schema.Number,
  cached: Schema.Number,
  skipped: Schema.Number
}

export class SourceStatus extends Schema.Class<SourceStatus>("SourceStatus")({
  name: Schema.String,
  status: SourceHealth,
  message: Schema.NullOr(Schema.String),
  ...counts
}) {}

export class StageStatus extends Schema.Class<StageStatus>("StageStatus")({
  name: Schema.String,
  status: StageHealth,
  message: Schema.NullOr(Schema.String),
  ...counts
}) {}

export class PipelineFailure extends Schema.Class<PipelineFailure>("PipelineFailure")({
  stage: Schema.String,
  item: Schema.String,
  error: Schema.String
}) {}

/** Timing of the pipeline loop. All instants are ISO-8601 or null. */
export class PipelineTiming extends Schema.Class<PipelineTiming>("PipelineTiming")({
  running: Schema.Boolean,
  currentStartedAt: Schema.NullOr(Schema.String),
  lastStartedAt: Schema.NullOr(Schema.String),
  lastFinishedAt: Schema.NullOr(Schema.String),
  nextRunAt: Schema.NullOr(Schema.String)
}) {}

export class LastRun extends Schema.Class<LastRun>("LastRun")({
  startedAt: Schema.String,
  finishedAt: Schema.String,
  sources: Schema.Array(SourceStatus),
  stages: Schema.Array(StageStatus),
  failures: Schema.Array(PipelineFailure)
}) {}

/** How much of the corpus has a journal reflecting its current inputs. */
export class StatusTotals extends Schema.Class<StatusTotals>("StatusTotals")({
  days: Schema.Number,
  transcripts: Schema.Number,
  current: Schema.Number,
  stale: Schema.Number
}) {}

export class PipelineStatus extends Schema.Class<PipelineStatus>("PipelineStatus")({
  pipeline: PipelineTiming,
  lastRun: Schema.NullOr(LastRun),
  totals: StatusTotals
}) {}

export const GetStatus = Rpc.make("GetStatus", {
  payload: {},
  success: PipelineStatus,
  error: ApiError
})

/** The place editor's three reads and one write. */
export const ListPlaces = Rpc.make("ListPlaces", {
  payload: {},
  success: Schema.Array(Place),
  error: ApiError
})

export const ListPlaceCandidates = Rpc.make("ListPlaceCandidates", {
  payload: {},
  success: Schema.Array(PlaceCandidate),
  error: ApiError
})

export const SearchAddress = Rpc.make("SearchAddress", {
  payload: { query: Schema.String },
  success: Schema.Array(GeocodeResult),
  error: ApiError
})

/**
 * Replace the whole place list. Whole-list, not per-place: the list is
 * content-addressed as a unit, and saving it restates the days it affects.
 *
 * This is the one RPC that writes, so it is the one that can be refused --
 * `ApiError` carries the reason (not the owner, or no owner configured).
 */
export const SavePlaces = Rpc.make("SavePlaces", {
  payload: { places: Schema.Array(Place) },
  success: Schema.Struct({ saved: Schema.Number }),
  error: ApiError
})

/**
 * Live pipeline progress, as a stream rather than a request.
 *
 * Replaces a hand-rolled `EventSource` whose payload was `JSON.parse`d into
 * `unknown` and duck-typed at the use site. Events are hints: a receiver
 * re-fetches through the RPCs above, so freshness rules stay in one place.
 */
export const StreamEvents = Rpc.make("StreamEvents", {
  payload: {},
  success: RuntimeEvent,
  error: ApiError,
  stream: true
})

export const JournalsGroup = RpcGroup.make(
  ListJournals,
  GetJournal,
  ListDays,
  SearchTranscripts,
  GetStatus,
  ListPlaces,
  ListPlaceCandidates,
  SearchAddress,
  SavePlaces,
  StreamEvents
)
