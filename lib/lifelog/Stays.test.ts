import { describe, expect, test } from "bun:test"
import { detectStays, type StayPoint } from "./Stays.ts"

const point = (ts: string, lat = 41.88, lon = -87.63): StayPoint => ({ ts, lat, lon })

describe("detectStays", () => {
  test("keeps a gap-tolerant stay", () => {
    const stays = detectStays([
      point("2026-08-29T01:00:00.000Z"),
      point("2026-08-29T08:00:00.000Z", 41.8801, -87.6301)
    ])
    expect(stays).toHaveLength(1)
    expect(stays[0]!.observed_duration_s).toBe(7 * 3600)
  })

  test("keeps A to B to A as three temporal stays", () => {
    const stays = detectStays([
      point("2026-08-29T01:00:00.000Z"),
      point("2026-08-29T02:00:00.000Z", 41.90, -87.63),
      point("2026-08-29T03:00:00.000Z")
    ])
    expect(stays).toHaveLength(3)
    expect(stays.map((stay) => stay.lat)).toEqual([41.88, 41.90, 41.88])
  })

  test("keeps a single-point stay", () => {
    expect(detectStays([point("2026-08-29T01:00:00.000Z")])[0]).toMatchObject({
      point_count: 1, observed_duration_s: 0, radius_m: 0
    })
  })

  test("closes a stay on radius spill", () => {
    const stays = detectStays([
      point("2026-08-29T01:00:00.000Z"),
      point("2026-08-29T01:10:00.000Z", 41.8801, -87.63),
      point("2026-08-29T01:20:00.000Z", 41.883, -87.63)
    ])
    expect(stays.map((stay) => stay.point_count)).toEqual([2, 1])
  })

  test("cross-midnight stay retains its first UTC day", () => {
    const stay = detectStays([
      point("2026-08-29T23:55:00.000Z"),
      point("2026-08-30T00:05:00.000Z", 41.8801, -87.6301)
    ])[0]!
    expect(stay.first_point_ts.slice(0, 10)).toBe("2026-08-29")
    expect(stay.last_point_ts.slice(0, 10)).toBe("2026-08-30")
  })
})
