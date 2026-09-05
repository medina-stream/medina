import { describe, expect, test } from "bun:test"
import { PREVIEW_CHARS, previewText } from "./Views.ts"

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
