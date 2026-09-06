/**
 * Server handlers for the journals RPC group.
 *
 * The read handlers are read-only, like the request path they mirror:
 * `currentJournals`, `journalCachedForDay` and `pipelineStatus` never
 * materialize, so serving costs no LLM calls.
 *
 * `SavePlaces` is the exception -- the one RPC that writes. Authorization is
 * a parameter (`canWrite`) rather than something this module decides:
 * `lib/` describes capabilities, and who may use them is application
 * policy. `example-lifelog/main.ts` supplies the Tailscale-backed check.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import type * as Headers from "effect/unstable/http/Headers"
import { dayEvent, eventHub } from "../RuntimeEvents.ts"
import { dayHub, publishDay } from "./DayEvents.ts"
import { journalCachedForDay } from "./Journal.ts"
import {
  ApiError,
  DayRow,
  JournalEntry,
  JournalsGroup,
  LastRun,
  PipelineStatus,
  PipelineTiming,
  SourceStatus,
  StageStatus,
  StatusTotals
} from "./JournalApi.ts"
import { forwardGeocode, listPlaces, placeCandidates, replacePlaces } from "./Movement.ts"
import { PlaceCandidate } from "./Places.ts"
import { currentJournals, dayPreviews, pipelineStatus } from "./Views.ts"

const toApiError = (error: unknown) => new ApiError({ message: String(error) })

/**
 * Whether a request may write, and why not if it may not. Returning the
 * reason (rather than a boolean) is what lets the client show "writes are
 * disabled: set INGEST_OWNER" instead of a bare refusal.
 */
export interface WriteAccess {
  readonly allowed: boolean
  readonly reason: string
}

export interface JournalHandlerOptions<R> {
  /**
   * Consulted per write; reads are never gated.
   *
   * Takes the request headers rather than reading `HttpServerRequest`,
   * which keeps these handlers transport-agnostic -- the same group can be
   * served over websockets or in-process without an HTTP request in scope.
   * The application decides what the headers mean (see `main.ts`, which
   * resolves them to a Tailscale login).
   *
   * Generic in its requirements so those flow into the returned layer
   * instead of being erased. Failures are absorbed as refusals: a check
   * that cannot answer must not read as permission granted.
   */
  readonly canWrite: (headers: Headers.Headers) => Effect.Effect<WriteAccess, unknown, R>
}

/**
 * The live feed: pipeline progress and day updates as one stream.
 *
 * Defined once and used by both the RPC stream and the SSE endpoint, so the
 * two cannot show different things. Day updates arrive from their own hub
 * (see `DayEvents.ts`) but reach subscribers as ordinary events carrying
 * `day`, which is what lets the UI refresh just the affected row.
 */
export const liveEvents = Stream.merge(
  Stream.fromPubSub(eventHub),
  Stream.map(Stream.fromPubSub(dayHub), dayEvent)
)

export const makeJournalsHandlers = <R>({ canWrite }: JournalHandlerOptions<R>) =>
  JournalsGroup.toLayer({
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
      ),
    GetStatus: () =>
      Effect.map(pipelineStatus, (status) =>
        new PipelineStatus({
          pipeline: new PipelineTiming(status.pipeline),
          lastRun: status.lastRun === null ? null : new LastRun({
            startedAt: status.lastRun.startedAt,
            finishedAt: status.lastRun.finishedAt,
            sources: status.lastRun.sources.map((source) => new SourceStatus(source)),
            stages: status.lastRun.stages.map((stage) => new StageStatus(stage)),
            failures: [...status.lastRun.failures]
          }),
          totals: new StatusTotals(status.totals)
        })).pipe(
          Effect.mapError(toApiError),
          Effect.withSpan("rpc.GetStatus")
        ),
    ListPlaces: () =>
      Effect.map(listPlaces, (places) => [...places]).pipe(
        Effect.mapError(toApiError),
        Effect.withSpan("rpc.ListPlaces")
      ),
    ListPlaceCandidates: () =>
      Effect.map(placeCandidates, (candidates) =>
        candidates.map((candidate) => new PlaceCandidate({ ...candidate, days: [...candidate.days] }))).pipe(
          Effect.mapError(toApiError),
          Effect.withSpan("rpc.ListPlaceCandidates")
        ),
    SearchAddress: ({ query }) => {
      const trimmed = query.trim()
      if (!trimmed) return Effect.succeed([])
      return Effect.map(forwardGeocode(trimmed), (results) => [...results]).pipe(
        Effect.mapError(toApiError),
        Effect.withSpan("rpc.SearchAddress")
      )
    },
    SavePlaces: ({ places }, { headers }) =>
      Effect.gen(function*() {
        // A check that fails is a check that did not pass: map the failure
        // to a refusal rather than letting it surface as a server error.
        const access = yield* Effect.catchCause(
          canWrite(headers),
          () => Effect.succeed({ allowed: false, reason: "could not verify write access" })
        )
        if (!access.allowed) return yield* Effect.fail(new ApiError({ message: access.reason }))
        yield* Effect.mapError(replacePlaces(places), toApiError)
        yield* Effect.log(`places replaced: ${places.length} places`)
        return { saved: places.length }
      }).pipe(Effect.withSpan("rpc.SavePlaces", { attributes: { places: places.length } })),
    StreamEvents: () => liveEvents
  })

/** Re-broadcast a day update so SSE and RPC subscribers stay in step. */
export { publishDay }
