import { describe, expect, test } from "bun:test"
import * as Schema from "effect/Schema"
import { ApiError, DayRow, GetJournal, JournalEntry, ListDays, ListJournals } from "./JournalApi.ts"
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
      new DayRow({ day: "2026-09-02", stale: false, preview: "A full day." }),
      new DayRow({ day: "2026-09-01", stale: true, preview: "" })
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
