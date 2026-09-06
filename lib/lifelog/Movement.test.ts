import { describe, expect, test } from "bun:test"
import { composeMovement, mergePlaceSuggestions, Movement, renderMovementTimeline, utcPartitionLocalDays, type MovementFix } from "./Movement.ts"
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

  test("folds only bracketed zero-duration singleton stays into travel", () => {
    const stays = [stay(0, 20, 41.88, -87.63), stay(30, 30, 41.895, -87.63, 1), stay(40, 60, 41.91, -87.63)]
    const points = [fix(20, 41.88, -87.63), fix(30, 41.895, -87.63), fix(40, 41.91, -87.63)]
    const segments = composeMovement(stays, points)
    expect(segments.map((segment) => segment.kind)).toEqual(["stay", "travel", "stay"])
    expect(segments[1]?.kind === "travel" && segments[1].fixes).toBe(3)
  })
})

describe("renderMovementTimeline", () => {
  test("renders compact named stays, travel distances, and gaps without coordinates", () => {
    const movement = new Movement({
      version: "movement-v1", day: "2026-08-29", basisHash: "basis", timeZone: "America/Chicago",
      generatedAt: "2026-08-30T00:00:00Z", narrative: "must not appear", suggestions: [],
      segments: [
        { kind: "stay", startTime: "a", endTime: "b", startLocal: "00:00", endLocal: "08:47",
          lat: 37.1, lon: -122.1, placeId: "home", placeName: "Steiner Street, Cow Hollow",
          geocodedName: "fallback", dwellMinutes: 527, fixes: 20 },
        { kind: "travel", startTime: "b", endTime: "c", startLocal: "08:47", endLocal: "08:53",
          distanceMeters: 1049, mode: "bike", fixes: 4 },
        { kind: "gap", startTime: "c", endTime: "d", startLocal: "08:53", endLocal: "10:00", fixes: 2 }
      ]
    })
    expect(renderMovementTimeline(movement)).toBe([
      "00:00-08:47 stay at Steiner Street, Cow Hollow (527 min)",
      "08:47-08:53 bike 1.0 km",
      "08:53-10:00 gap in GPS evidence"
    ].join("\n"))
  })

  test("falls back to a geocoded stay name", () => {
    const movement = new Movement({
      version: "movement-v1", day: "2026-08-29", basisHash: "basis", timeZone: "UTC",
      generatedAt: "2026-08-30T00:00:00Z", narrative: null, suggestions: [],
      segments: [{ kind: "stay", startTime: "a", endTime: "b", startLocal: "12:00", endLocal: "12:15",
        lat: 1, lon: 2, placeId: null, placeName: null, geocodedName: "Market Street",
        dwellMinutes: 15, fixes: 2 }]
    })
    expect(renderMovementTimeline(movement)).toBe("12:00-12:15 stay at Market Street (15 min)")
  })
})

describe("mergePlaceSuggestions", () => {
  test("nearby clusters across days fold into one dwell-weighted centroid", () => {
    const merged = mergePlaceSuggestions([
      { lat: 41.88, lon: -87.63, geocodedName: "Cafe", dwellMinutes: 60, day: "2026-08-29" },
      { lat: 41.8801, lon: -87.6301, geocodedName: null, dwellMinutes: 30, day: "2026-08-30" }
    ])
    expect(merged.length).toBe(1)
    expect(merged[0]!.dwellMinutes).toBe(90)
    expect(merged[0]!.days).toEqual(["2026-08-29", "2026-08-30"])
    expect(merged[0]!.geocodedName).toBe("Cafe")
    expect(merged[0]!.lat).toBeCloseTo(41.88003, 4)
  })

  test("distant clusters stay separate, longest dwell first", () => {
    const merged = mergePlaceSuggestions([
      { lat: 41.88, lon: -87.63, geocodedName: null, dwellMinutes: 20, day: "2026-08-29" },
      { lat: 42.0, lon: -87.7, geocodedName: "Far", dwellMinutes: 120, day: "2026-08-29" }
    ])
    expect(merged.length).toBe(2)
    expect(merged[0]!.geocodedName).toBe("Far")
    expect(merged[1]!.days).toEqual(["2026-08-29"])
  })
})

describe("utcPartitionLocalDays", () => {
  test("a UTC partition maps to the local days its milliseconds touch", () => {
    // Chicago (UTC-5 in September): the UTC day starts at 19:00 local the day before.
    expect(utcPartitionLocalDays("2026-09-02", "America/Chicago")).toEqual(["2026-09-01", "2026-09-02"])
    // UTC: exactly one day.
    expect(utcPartitionLocalDays("2026-09-02", "UTC")).toEqual(["2026-09-02"])
    // Tokyo (UTC+9): the UTC day ends at 09:00 local the next day.
    expect(utcPartitionLocalDays("2026-09-02", "Asia/Tokyo")).toEqual(["2026-09-02", "2026-09-03"])
  })
})
