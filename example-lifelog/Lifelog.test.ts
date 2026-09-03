import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { journalInputHash } from "./Lifelog.ts"
import { dayPage, journalPage } from "./Pages.tsx"
import { DayEntry, Journal } from "./Resources.ts"
import { withinEagerWindow } from "./Time.ts"

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const entry = (correctionHash: string | null) => new DayEntry({
  captureId: "capture", transcriptKey: "transcript/key.json",
  startTime: "2026-08-29T12:00:00Z", timeZone: "America/Chicago",
  channel: "lifelog-audio-1", correctionHash
})

describe("journalInputHash", () => {
  test("preserves the transcript-only composition without usable movement", () => {
    expect(journalInputHash([entry(null)], null)).toBe(sha256("transcript/key.json"))
    expect(journalInputHash([], null)).toBe(sha256(""))
  })

  test("covers both correction and selected movement bases", () => {
    expect(journalInputHash([entry("correction")], "movement-basis")).toBe(
      sha256("transcript/key.json:correction\nmovement:movement-basis")
    )
    expect(journalInputHash([entry("correction")], "other-basis")).not.toBe(
      journalInputHash([entry("correction")], "movement-basis")
    )
  })

  test("a day's note joins the basis without disturbing note-less days", () => {
    // The compatibility freeze: days with no note must hash exactly as before,
    // or every existing journal on disk goes stale at once.
    expect(journalInputHash([entry(null)], null, null)).toBe(sha256("transcript/key.json"))
    expect(journalInputHash([entry(null)], "movement-basis", null)).toBe(
      sha256("transcript/key.json\nmovement:movement-basis")
    )
    // Editing the note for a day restates its evidence, so the journal re-derives.
    expect(journalInputHash([entry(null)], null, "blob-a")).not.toBe(
      journalInputHash([entry(null)], null, "blob-b")
    )
    expect(journalInputHash([entry(null)], null, "blob-a")).toBe(
      sha256("transcript/key.json\nnote:blob-a")
    )
  })
})

describe("journal pages", () => {
  test("escapes report text rather than emitting it as markup", () => {
    const journal = new Journal({
      version: "journal-v5", day: "2026-08-29", inputHash: "hash", transcriptKeys: [],
      model: null, generatedAt: "2026-08-29T00:00:00Z", status: "completed",
      report: "You said <script>alert(1)</script> & left."
    })
    const html = dayPage(journal)
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).toContain("&amp; left.")
  })

  test("marks a day whose journal lags its inputs", () => {
    const journal = new Journal({
      version: "journal-v5", day: "2026-08-29", inputHash: "hash", transcriptKeys: [],
      model: null, generatedAt: "2026-08-29T00:00:00Z", status: "completed", report: "A day."
    })
    expect(journalPage([{ journal, stale: true }])).toContain("rewriting")
    expect(journalPage([{ journal, stale: false }])).not.toContain("rewriting")
  })
})

describe("eager window", () => {
  const days = ["2026-08-01", "2026-08-28", "2026-09-01", "2026-09-03"]

  test("unset means every day is enumerated eagerly", () => {
    expect(withinEagerWindow(days, null, (day) => day)).toEqual(days)
  })

  test("a window narrows what is pre-generated, keeping day order", () => {
    expect(withinEagerWindow(days, "2026-08-28", (day) => day))
      .toEqual(["2026-08-28", "2026-09-01", "2026-09-03"])
  })
})
