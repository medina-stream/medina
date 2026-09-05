import { describe, expect, test } from "bun:test"
import { MAP_H, MAP_W, MAP_ZOOM, nudgeLatLon, staticMapUrl } from "./Maps.ts"

describe("staticMapUrl", () => {
  test("centers on the pin with a marker", () => {
    const url = staticMapUrl(41.88, -87.63)
    expect(url).toContain("center=41.88000%2C-87.63000")
    expect(url).toContain("markers=41.88000%2C-87.63000%2Cred")
    expect(url).toContain(`size=${MAP_W}x${MAP_H}`)
  })
})

describe("nudgeLatLon", () => {
  test("a centered click returns the center", () => {
    const { lat, lon } = nudgeLatLon(41.88, -87.63, MAP_ZOOM, 0, 0)
    expect(lat).toBeCloseTo(41.88, 6)
    expect(lon).toBeCloseTo(-87.63, 6)
  })

  test("clicks move the pin in the clicked direction, symmetrically", () => {
    const east = nudgeLatLon(41.88, -87.63, MAP_ZOOM, 100, 0)
    const west = nudgeLatLon(41.88, -87.63, MAP_ZOOM, -100, 0)
    expect(east.lon).toBeGreaterThan(-87.63)
    expect(west.lon).toBeLessThan(-87.63)
    expect(east.lon + west.lon).toBeCloseTo(2 * -87.63, 6)
    const south = nudgeLatLon(41.88, -87.63, MAP_ZOOM, 0, 50)
    expect(south.lat).toBeLessThan(41.88)
  })
})
