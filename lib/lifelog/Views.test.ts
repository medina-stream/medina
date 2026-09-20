import { describe, expect, test } from "bun:test"
import { mergeCoverage, PREVIEW_CHARS, previewText, startMinutesInZone } from "./Views.ts"

describe("previewText", () => {
  test("short reports pass through untouched", () => {
    expect(previewText("A quiet day.")).toBe("A quiet day.")
    expect(previewText("")).toBe("")
  })

  test("only the summary line shows, not the chronology", () => {
    expect(previewText("A full day out.\n\n9:00–10:30 — Home: slow morning.\n\n11:00–12:00 — Gym: lifted.")).toBe(
      "A full day out."
    )
  })

  test("leading blank lines are skipped and inner whitespace flattens", () => {
    expect(previewText("\n  Morning   run.\n\nAfternoon read.")).toBe("Morning run.")
  })

  test("long reports truncate to one preview with an ellipsis", () => {
    const report = `${"word ".repeat(100).trim()}\nsecond paragraph`
    const preview = previewText(report)
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_CHARS)
    expect(preview.endsWith("…")).toBe(true)
    expect(preview).not.toContain("\n")
  })

  test("a report of exactly the limit is not truncated", () => {
    const report = "x".repeat(PREVIEW_CHARS)
    expect(previewText(report)).toBe(report)
  })
})

describe("startMinutesInZone", () => {
  test("a UTC instant converts to zone wall-clock minutes", () => {
    // 2026-09-18 is PDT (UTC-7): 16:30Z -> 9:30 local.
    expect(startMinutesInZone("2026-09-18T16:30:00Z", "America/Los_Angeles")).toBeCloseTo(570, 1)
  })

  test("a naive local wall clock is read directly", () => {
    expect(startMinutesInZone("2026-09-18T09:30:45", "America/Los_Angeles")).toBeCloseTo(570.75, 2)
  })

  test("midnight is zero, end of day approaches 1440", () => {
    expect(startMinutesInZone("2026-09-18T00:00:00Z", "UTC")).toBe(0)
    expect(startMinutesInZone("2026-09-18T23:59:00Z", "UTC")).toBe(1439)
  })
})

describe("mergeCoverage", () => {
  test("overlapping and touching segments merge", () => {
    expect(mergeCoverage([[60, 120], [100, 180], [300, 360]])).toEqual([[60, 180], [300, 360]])
  })

  test("unsorted input sorts and near-adjacent segments merge", () => {
    // Clock-aligned 15-minute captures touch at the boundary.
    expect(mergeCoverage([[120, 135], [0, 15], [15, 30]])).toEqual([[0, 30], [120, 135]])
  })

  test("empty input stays empty", () => {
    expect(mergeCoverage([])).toEqual([])
  })
})
