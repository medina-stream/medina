import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { journalInputHash } from "./Lifelog.ts"
import { DayEntry } from "./Resources.ts"

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
})
