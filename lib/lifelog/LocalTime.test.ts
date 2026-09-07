import { describe, expect, test } from "bun:test"
import { localDay, localTime, recordingLabel } from "./LocalTime.ts"

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
