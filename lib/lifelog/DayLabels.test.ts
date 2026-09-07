import { describe, expect, test } from "bun:test"
import { audioLabel, compactDay, relativeDay } from "./DayLabels.ts"

describe("compactDay", () => {
  test("drops the separators", () => {
    expect(compactDay("2026-09-01")).toBe("20260901")
    expect(compactDay("2026-12-31")).toBe("20261231")
  })

  test("leaves anything that is not a day alone", () => {
    expect(compactDay("")).toBe("")
    expect(compactDay("not-a-day")).toBe("not-a-day")
  })
})

describe("relativeDay", () => {
  // 2026-09-06 is a Sunday.
  const today = "2026-09-06"

  test("names the days around today", () => {
    expect(relativeDay("2026-09-06", today)).toBe("Today")
    expect(relativeDay("2026-09-05", today)).toBe("Yesterday")
    expect(relativeDay("2026-09-07", today)).toBe("Tomorrow")
  })

  test("uses the weekday within the last week", () => {
    expect(relativeDay("2026-09-04", today)).toBe("Friday")
    expect(relativeDay("2026-08-31", today)).toBe("Monday")
  })

  test("uses Last <day> for the week before that", () => {
    expect(relativeDay("2026-08-30", today)).toBe("Last Sun")
    expect(relativeDay("2026-08-25", today)).toBe("Last Tue")
  })

  test("falls back to a date, with the year only when it differs", () => {
    expect(relativeDay("2026-08-03", today)).toBe("Aug 3")
    expect(relativeDay("2025-12-24", today)).toBe("Dec 24, 2025")
  })

  test("a non-day is blank rather than Invalid Date", () => {
    expect(relativeDay("nope", today)).toBe("")
    expect(relativeDay(today, "nope")).toBe("")
  })

  /** Day arithmetic must not depend on the host zone. */
  test("boundaries hold regardless of local offset", () => {
    expect(relativeDay("2026-01-01", "2026-01-02")).toBe("Yesterday")
    expect(relativeDay("2025-12-31", "2026-01-01")).toBe("Yesterday")
  })
})

describe("audioLabel", () => {
  test("formats hours, minutes and seconds", () => {
    expect(audioLabel(4 * 3600 + 20 * 60)).toBe("4h 20m")
    expect(audioLabel(2 * 3600)).toBe("2h")
    expect(audioLabel(35 * 60)).toBe("35m")
    expect(audioLabel(40)).toBe("40s")
  })

  test("nothing recorded shows nothing", () => {
    expect(audioLabel(0)).toBe("")
    expect(audioLabel(0.4)).toBe("")
    expect(audioLabel(Number.NaN)).toBe("")
  })

  test("a minute-ish duration never rounds down to 0m", () => {
    expect(audioLabel(61)).toBe("1m")
  })
})
