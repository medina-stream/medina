import { describe, expect, test } from "bun:test"
import { composeMovement, type MovementFix } from "./Movement.ts"
import type { StayRow } from "./Stays.ts"

const fix = (minutes: number, lat: number, lon: number): MovementFix => ({
  ts: new Date(Date.UTC(2026, 7, 29, 12, minutes)).toISOString(), lat, lon
})
const stay = (start: number, end: number, lat: number, lon: number, count = 2): StayRow => ({
  first_point_ts: fix(start, lat, lon).ts, last_point_ts: fix(end, lat, lon).ts,
  lat, lon, radius_m: 0, point_count: count, observed_duration_s: (end - start) * 60
})

describe("composeMovement", () => {
  test("uses materialized stays and classifies observed travel between them", () => {
    const stays = [stay(0, 20, 41.88, -87.63, 3), stay(50, 70, 41.91, -87.63, 3)]
    const points = [fix(20, 41.88, -87.63), fix(30, 41.895, -87.63), fix(40, 41.91, -87.63), fix(50, 41.91, -87.63)]
    const segments = composeMovement(stays, points)
    expect(segments.map((segment) => segment.kind)).toEqual(["stay", "travel", "stay"])
    expect(segments[1]?.kind === "travel" && segments[1].mode).toBe("walk")
  })

  test("uses a gap for sparse distant evidence between stays", () => {
    const stays = [stay(0, 0, 41.88, -87.63, 1), stay(390, 390, 41.90, -87.63, 1)]
    const segments = composeMovement(stays, [fix(0, 41.88, -87.63), fix(390, 41.90, -87.63)])
    expect(segments.map((segment) => segment.kind)).toEqual(["stay", "gap", "stay"])
  })
})
