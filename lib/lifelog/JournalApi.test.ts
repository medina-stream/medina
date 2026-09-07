import { describe, expect, test } from "bun:test"
import * as Schema from "effect/Schema"
import { dayEvent, RuntimeEvent } from "../RuntimeEvents.ts"
import {
  ApiError,
  DayRow,
  GetJournal,
  GetStatus,
  JournalEntry,
  LastRun,
  ListDays,
  ListJournals,
  ListPlaceCandidates,
  ListPlaces,
  PipelineFailure,
  PipelineStatus,
  PipelineTiming,
  SavePlaces,
  SourceStatus,
  StageStatus,
  StatusTotals
} from "./JournalApi.ts"
import { Place, PlaceCandidate } from "./Places.ts"
import { Journal } from "./Resources.ts"

const journal = new Journal({
  version: "journal-v5", day: "2026-09-01", inputHash: "hash", transcriptKeys: [],
  model: null, generatedAt: "2026-09-02T00:00:00Z", status: "completed", report: "A day."
})

describe("journals RPC contract", () => {
  test("ListJournals entries survive a JSON round-trip", () => {
    const entry = new JournalEntry({ journal, stale: true })
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(ListJournals.successSchema)([entry])))
    const decoded = Schema.decodeUnknownSync(ListJournals.successSchema)(json)
    expect(decoded).toEqual([entry])
  })

  test("GetJournal answers journal and null round-trip", () => {
    for (const value of [journal, null] as const) {
      const json = JSON.parse(JSON.stringify(Schema.encodeSync(GetJournal.successSchema)(value)))
      expect(Schema.decodeUnknownSync(GetJournal.successSchema)(json)).toEqual(value)
    }
  })

  test("ListDays rows survive a JSON round-trip, limit/offset intact", () => {
    const rows = [
      new DayRow({ day: "2026-09-02", stale: false, preview: "A full day.", audioSeconds: 15_600 }),
      new DayRow({ day: "2026-09-01", stale: true, preview: "", audioSeconds: 0 })
    ]
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(ListDays.successSchema)(rows)))
    expect(Schema.decodeUnknownSync(ListDays.successSchema)(json)).toEqual(rows)
    expect(Schema.decodeUnknownSync(ListDays.payloadSchema)({ limit: 20, offset: 5 })).toEqual({ limit: 20, offset: 5 })
    expect(Schema.decodeUnknownSync(ListDays.payloadSchema)({} as const)).toEqual({})
  })

  test("failures carry a message", () => {
    const error = new ApiError({ message: "no inputs for 2026-09-01" })
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(ListJournals.errorSchema)(error)))
    expect(Schema.decodeUnknownSync(ListJournals.errorSchema)(json)).toEqual(error)
  })
})

describe("pipeline status contract", () => {
  const source = new SourceStatus({
    name: "notes", status: "disabled", message: "NOTES_REPO_URL is required",
    discovered: 0, ingested: 0, cached: 0, skipped: 0
  })
  const stage = new StageStatus({
    name: "gps-stays", status: "healthy", message: null,
    discovered: 3, ingested: 1, cached: 2, skipped: 0
  })

  test("status survives a JSON round-trip", () => {
    const status = new PipelineStatus({
      pipeline: new PipelineTiming({
        running: false, currentStartedAt: null, lastStartedAt: "2026-09-06T00:00:00Z",
        lastFinishedAt: "2026-09-06T00:01:00Z", nextRunAt: "2026-09-06T01:01:00Z"
      }),
      lastRun: new LastRun({
        startedAt: "2026-09-06T00:00:00Z", finishedAt: "2026-09-06T00:01:00Z",
        sources: [source], stages: [stage],
        failures: [new PipelineFailure({ stage: "ingest:notes", item: "a.md", error: "boom" })]
      }),
      totals: new StatusTotals({ days: 63, transcripts: 68, current: 63, stale: 0 })
    })
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(GetStatus.successSchema)(status)))
    expect(Schema.decodeUnknownSync(GetStatus.successSchema)(json)).toEqual(status)
  })

  test("a day with no run yet is expressible", () => {
    const empty = new PipelineStatus({
      pipeline: new PipelineTiming({
        running: true, currentStartedAt: "2026-09-06T00:00:00Z",
        lastStartedAt: null, lastFinishedAt: null, nextRunAt: null
      }),
      lastRun: null,
      totals: new StatusTotals({ days: 0, transcripts: 0, current: 0, stale: 0 })
    })
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(GetStatus.successSchema)(empty)))
    expect(Schema.decodeUnknownSync(GetStatus.successSchema)(json)).toEqual(empty)
  })

  /**
   * The drift this whole migration was meant to end: the hand-written client
   * interface used one type for sources and stages, so it claimed a stage
   * could be `disabled`. Only a source can be.
   */
  test("only sources can be disabled", () => {
    expect(Schema.decodeUnknownSync(SourceStatus)({ ...source, status: "disabled" })).toBeDefined()
    expect(() => Schema.decodeUnknownSync(StageStatus)({ ...stage, status: "disabled" })).toThrow()
  })
})

describe("places contract", () => {
  const place = new Place({ id: "home-1", name: "Home", lat: 37.79, lon: -122.43, radiusMeters: 150 })

  test("places round-trip through save and list", () => {
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(ListPlaces.successSchema)([place])))
    expect(Schema.decodeUnknownSync(ListPlaces.successSchema)(json)).toEqual([place])
    const payload = Schema.decodeUnknownSync(SavePlaces.payloadSchema)({ places: [place] })
    expect(payload.places).toEqual([place])
  })

  test("candidates keep the days that justify them", () => {
    const candidate = new PlaceCandidate({
      lat: 37.8, lon: -122.4, geocodedName: "Somewhere", dwellMinutes: 95,
      days: ["2026-09-01", "2026-09-03"]
    })
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(ListPlaceCandidates.successSchema)([candidate])))
    expect(Schema.decodeUnknownSync(ListPlaceCandidates.successSchema)(json)).toEqual([candidate])
  })

  test("a refused save is a typed error, not a status code", () => {
    const refusal = new ApiError({ message: "forbidden: not you" })
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(SavePlaces.errorSchema)(refusal)))
    expect(Schema.decodeUnknownSync(SavePlaces.errorSchema)(json)).toEqual(refusal)
  })
})

// A streaming RPC's `successSchema` is the stream declaration, so these
// encode against the element schema -- which is the thing that actually
// crosses the wire, one event at a time.
describe("live events contract", () => {
  test("a pipeline event round-trips", () => {
    const event = new RuntimeEvent({
      at: "2026-09-06T21:32:29Z", type: "source", message: "notes: 0 new, 19 cached",
      name: "notes", status: "complete", day: null
    })
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(RuntimeEvent)(event)))
    expect(Schema.decodeUnknownSync(RuntimeEvent)(json)).toEqual(event)
  })

  /** The UI refreshes one row when `day` is set, so it has to survive. */
  test("a day event carries its day", () => {
    const event = dayEvent("2026-09-06")
    expect(event.day).toBe("2026-09-06")
    expect(event.type).toBe("day")
    const json = JSON.parse(JSON.stringify(Schema.encodeSync(RuntimeEvent)(event)))
    expect(Schema.decodeUnknownSync(RuntimeEvent)(json).day).toBe("2026-09-06")
  })

  test("progress vocabulary excludes health words", () => {
    // `healthy`/`empty` describe a source's settled health, not a step's
    // progress; publishing them here is what the schema now prevents.
    expect(() => Schema.decodeUnknownSync(RuntimeEvent)({
      at: "2026-09-06T21:32:29Z", type: "source", message: "x",
      name: "notes", status: "healthy", day: null
    })).toThrow()
  })
})
