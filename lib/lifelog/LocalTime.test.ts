import { describe, expect, test } from "bun:test"
import { localDay, localTime, recordingLabel, utteranceClock } from "./LocalTime.ts"

describe("localTime", () => {
  /**
   * The bug this module exists for: a 10:47 PDT recording stored as
   * 17:47Z was labelled "17:47" and the journal reported an afternoon
   * event on a morning that had not happened yet.
   */
  test("renders a UTC instant in the given zone", () => {
    expect(localTime("2026-09-07T17:47:46Z", "America/Los_Angeles")).toBe("10:47")
    expect(localTime("2026-09-07T17:47:46Z", "UTC")).toBe("17:47")
    expect(localTime("2026-09-07T17:47:46Z", "America/New_York")).toBe("13:47")
  })

  test("handles the DST boundary without special casing", () => {
    // PDT (UTC-7) in September, PST (UTC-8) in December.
    expect(localTime("2026-09-07T17:00:00Z", "America/Los_Angeles")).toBe("10:00")
    expect(localTime("2026-12-07T17:00:00Z", "America/Los_Angeles")).toBe("09:00")
  })

  test("crossing local midnight reports the local clock", () => {
    expect(localTime("2026-09-08T04:30:00Z", "America/Los_Angeles")).toBe("21:30")
  })

  test("unusable input is blank rather than Invalid Date", () => {
    expect(localTime("nonsense", "UTC")).toBe("")
    expect(localTime("2026-09-07T17:47:46Z", "Not/AZone")).toBe("")
  })
})

describe("localDay", () => {
  test("the civil day follows the zone, not the instant", () => {
    // 04:30Z on the 8th is still the evening of the 7th in California.
    expect(localDay("2026-09-08T04:30:00Z", "America/Los_Angeles")).toBe("2026-09-07")
    expect(localDay("2026-09-08T04:30:00Z", "UTC")).toBe("2026-09-08")
  })
})

describe("recordingLabel", () => {
  test("names the zone so the model need not infer it", () => {
    expect(recordingLabel("2026-09-07T17:47:46Z", "America/Los_Angeles"))
      .toBe("10:47 America/Los_Angeles")
  })

  test("falls back to the instant rather than losing the time", () => {
    expect(recordingLabel("2026-09-07T17:47:46Z", "Not/AZone")).toBe("2026-09-07T17:47:46Z")
  })
})

describe("utteranceClock", () => {
  /**
   * The second bug: bare `[+00:49:30]` offsets asked the model to add, and
   * it read them as clock times instead -- a 54-minute recording produced
   * "21:13-49:30", an hour that does not exist.
   */
  test("an offset becomes an absolute local clock time", () => {
    const start = "2026-09-07T18:01:12Z" // 11:01 PDT
    expect(utteranceClock(start, "America/Los_Angeles", 0)).toBe("11:01")
    expect(utteranceClock(start, "America/Los_Angeles", 287_100)).toBe("11:05")
    expect(utteranceClock(start, "America/Los_Angeles", 2_970_043)).toBe("11:50")
    expect(utteranceClock(start, "America/Los_Angeles", 3_237_293)).toBe("11:55")
  })

  test("an offset can carry the clock into the next hour", () => {
    expect(utteranceClock("2026-09-07T18:50:00Z", "America/Los_Angeles", 20 * 60_000)).toBe("12:10")
  })

  test("a negative offset is clamped to the start", () => {
    expect(utteranceClock("2026-09-07T18:01:12Z", "America/Los_Angeles", -5000)).toBe("11:01")
  })

  test("unusable input is blank rather than Invalid Date", () => {
    expect(utteranceClock("nonsense", "UTC", 1000)).toBe("")
  })
})
