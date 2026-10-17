import { describe, expect, test } from "bun:test"
import { detectStays, detectStaysByDay, RunningMedian, type StayPoint } from "./Stays.ts"

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

  test("a long stay's center is the full-cluster median", () => {
    // 2,001 points jittered around one spot: the exit test must see the
    // running median, and the finished stay the same center as a naive
    // median over all members.
    const points = Array.from({ length: 2001 }, (_, index) =>
      point(new Date(Date.UTC(2026, 7, 29, 0, 0, index * 10)).toISOString(),
        41.88 + (index % 7) * 0.00001, -87.63 - (index % 5) * 0.00001))
    const stays = detectStays(points)
    expect(stays).toHaveLength(1)
    expect(stays[0]!.point_count).toBe(2001)
    const sortedLat = points.map((entry) => entry.lat).sort((a, b) => a - b)
    expect(stays[0]!.lat).toBe(sortedLat[1000]!)
  })
})

describe("RunningMedian", () => {
  test("matches the naive median after every insertion", () => {
    const running = new RunningMedian()
    const values: Array<number> = []
    let seed = 42
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let index = 0; index < 500; index++) {
      const value = next() * 100
      values.push(value)
      running.add(value)
      const sorted = [...values].sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      const expected = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
      expect(running.median()).toBeCloseTo(expected, 10)
    }
  })
})

describe("detectStaysByDay", () => {
  test("matches whole-history detection across day boundaries", () => {
    const day1 = [point("2026-08-29T23:50:00.000Z"), point("2026-08-29T23:55:00.000Z", 41.8801, -87.6301)]
    const day2 = [
      point("2026-08-30T00:05:00.000Z", 41.8801, -87.6301),
      point("2026-08-30T02:00:00.000Z", 41.90, -87.63),
      point("2026-08-30T03:00:00.000Z")
    ]
    expect(detectStaysByDay([day1, day2])).toEqual(detectStays([...day1, ...day2]))
    // The cross-midnight cluster is one stay, partitioned by its first day.
    expect(detectStaysByDay([day1, day2])[0]!.first_point_ts.slice(0, 10)).toBe("2026-08-29")
  })

  test("empty days contribute nothing", () => {
    expect(detectStaysByDay([[], [point("2026-08-29T01:00:00.000Z")], []])).toEqual(
      detectStays([point("2026-08-29T01:00:00.000Z")])
    )
  })
})
