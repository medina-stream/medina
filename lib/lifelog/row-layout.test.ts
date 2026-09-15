import { describe, expect, it } from "bun:test"
import {
  GHOST_TOMORROW_MS,
  LIVE_HOLD_MS,
  ROW_H,
  TODAY_H,
  TOMORROW_H,
  YESTERDAY_H,
  rowHeight,
  shiftDay
} from "./row-layout.ts"

describe("shiftDay", () => {
  it("shifts within a month", () => {
    expect(shiftDay("2026-09-15", 1)).toBe("2026-09-16")
    expect(shiftDay("2026-09-15", -1)).toBe("2026-09-14")
  })

  it("crosses month and year boundaries", () => {
    expect(shiftDay("2026-09-01", -1)).toBe("2026-08-31")
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01")
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31")
  })

  it("handles leap day", () => {
    expect(shiftDay("2024-02-28", 1)).toBe("2024-02-29")
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29")
  })

  it("rejects non-day strings", () => {
    expect(shiftDay("not-a-day", 1)).toBe("")
    expect(shiftDay("", -1)).toBe("")
  })
})

describe("rowHeight", () => {
  const today = "2026-09-15"
  const yesterday = "2026-09-14"

  it("maps each kind to its fixed height", () => {
    expect(rowHeight({ day: "2026-09-10" }, today, yesterday)).toBe(ROW_H)
    expect(rowHeight({ day: today }, today, yesterday)).toBe(TODAY_H)
    expect(rowHeight({ day: yesterday }, today, yesterday)).toBe(YESTERDAY_H)
    expect(rowHeight({ day: "2026-09-16", ghost: true }, today, yesterday)).toBe(TOMORROW_H)
  })

  it("lets the ghost kind win over a day match", () => {
    expect(rowHeight({ day: today, ghost: true }, today, yesterday)).toBe(TOMORROW_H)
  })

  it("keeps the kinds ordered: ghost < ordinary < yesterday < today", () => {
    expect(TOMORROW_H).toBeLessThan(ROW_H)
    expect(ROW_H).toBeLessThan(YESTERDAY_H)
    expect(YESTERDAY_H).toBeLessThan(TODAY_H)
  })
})

describe("layout timing constants", () => {
  it("are sane", () => {
    expect(GHOST_TOMORROW_MS).toBe(60 * 60 * 1000)
    expect(LIVE_HOLD_MS).toBe(60 * 1000)
  })
})
