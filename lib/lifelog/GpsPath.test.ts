import { describe, expect, test } from "bun:test"
import { localDayBounds, selectLocalDay, type GpsPathPoint } from "./GpsPath.ts"

const LA = "America/Los_Angeles"

describe("localDayBounds", () => {
  test("a plain PDT day starts at 07:00 UTC", () => {
    const bounds = localDayBounds("2026-09-22", LA)
    expect(bounds?.start.toISOString()).toBe("2026-09-22T07:00:00.000Z")
    expect(bounds?.end.toISOString()).toBe("2026-09-23T07:00:00.000Z")
  })

  test("spring-forward day is 23 hours", () => {
    const bounds = localDayBounds("2026-03-08", LA)
    expect(bounds?.start.toISOString()).toBe("2026-03-08T08:00:00.000Z")
    expect(bounds?.end.toISOString()).toBe("2026-03-09T07:00:00.000Z")
    expect(bounds!.end.getTime() - bounds!.start.getTime()).toBe(23 * 3_600_000)
  })

  test("fall-back day is 25 hours", () => {
    const bounds = localDayBounds("2026-11-01", LA)
    expect(bounds?.start.toISOString()).toBe("2026-11-01T07:00:00.000Z")
    expect(bounds?.end.toISOString()).toBe("2026-11-02T08:00:00.000Z")
    expect(bounds!.end.getTime() - bounds!.start.getTime()).toBe(25 * 3_600_000)
  })

  test("rejects malformed and impossible days", () => {
    expect(localDayBounds("nope", LA)).toBeNull()
    expect(localDayBounds("2026-13-01", LA)).toBeNull()
    expect(localDayBounds("2026-02-30", LA)).toBeNull()
    expect(localDayBounds("2026-9-2", LA)).toBeNull()
  })
})

const point = (ts: string, lat = 37.8, lon = -122.43, source = "capture/x"): GpsPathPoint => ({
  source,
  ts,
  lat,
  lon,
  speed: null,
  alt: null,
  acc: 10,
  batt: null
})

describe("selectLocalDay", () => {
  const start = new Date("2026-09-22T07:00:00.000Z")
  const end = new Date("2026-09-23T07:00:00.000Z")

  test("orders chronologically and drops duplicates", () => {
    const a = point("2026-09-22T10:00:00.000Z")
    const b = point("2026-09-22T08:00:00.000Z")
    const out = selectLocalDay([a, b, a], start, end)
    expect(out.map((p) => p.ts)).toEqual(["2026-09-22T08:00:00.000Z", "2026-09-22T10:00:00.000Z"])
  })

  test("keeps only fixes inside [start, end)", () => {
    const inside = point("2026-09-22T07:00:00.000Z")
    const before = point("2026-09-22T06:59:59.000Z")
    const atEnd = point("2026-09-23T07:00:00.000Z")
    const out = selectLocalDay([before, inside, atEnd], start, end)
    expect(out).toEqual([inside])
  })

  test("same fix from two sources is not a duplicate", () => {
    const a = point("2026-09-22T10:00:00.000Z", 37.8, -122.43, "capture/a")
    const b = point("2026-09-22T10:00:00.000Z", 37.8, -122.43, "capture/b")
    expect(selectLocalDay([a, b], start, end)).toHaveLength(2)
  })
})
