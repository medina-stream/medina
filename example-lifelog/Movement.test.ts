import { describe, expect, test } from "bun:test"
import { segmentMovement, type MovementFix } from "./Movement.ts"

const fix = (minutes: number, lat: number, lon: number): MovementFix => ({
  ts: new Date(Date.UTC(2026, 7, 29, 12, minutes)).toISOString(), lat, lon
})

describe("segmentMovement", () => {
  test("finds stays and classifies travel between them", () => {
    const segments = segmentMovement([
      fix(0, 41.88, -87.63), fix(10, 41.8801, -87.6301), fix(20, 41.88, -87.63),
      fix(30, 41.895, -87.63), fix(40, 41.91, -87.63),
      fix(50, 41.91, -87.63), fix(60, 41.9101, -87.6301), fix(70, 41.91, -87.63)
    ])
    expect(segments.map((segment) => segment.kind)).toEqual(["stay", "travel", "stay"])
    expect(segments[1]?.kind === "travel" && segments[1].mode).toBe("bike")
  })

  test("does not invent travel across a sparse gap", () => {
    const segments = segmentMovement([
      fix(0, 41.88, -87.63), { ts: "2026-08-29T18:30:00.000Z", lat: 41.90, lon: -87.63 }
    ])
    expect(segments).toHaveLength(1)
    expect(segments[0]?.kind).toBe("gap")
  })

  test("represents a single-fix day", () => {
    expect(segmentMovement([fix(0, 41.88, -87.63)])).toEqual([
      { kind: "stay", start: fix(0, 0, 0).ts, end: fix(0, 0, 0).ts, lat: 41.88, lon: -87.63, fixes: 1 }
    ])
  })
})
