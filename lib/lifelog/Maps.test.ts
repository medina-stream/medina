import { describe, expect, test } from "bun:test"
import { MAP_H, MAP_W, MAP_ZOOM, mapTiles, nudgeLatLon, TILE_SIZE } from "./Maps.ts"

describe("mapTiles", () => {
  test("covers the viewport, and the center pixel sits at the middle", () => {
    const tiles = mapTiles(41.88, -87.63)
    expect(tiles.length).toBeGreaterThan(0)
    // Every pixel of the viewport is covered by some tile.
    for (const [x, y] of [[0, 0], [MAP_W - 1, 0], [0, MAP_H - 1], [MAP_W - 1, MAP_H - 1], [MAP_W / 2, MAP_H / 2]]) {
      const covering = tiles.filter((tile) =>
        x! >= tile.left && x! < tile.left + TILE_SIZE && y! >= tile.top && y! < tile.top + TILE_SIZE)
      expect(covering.length).toBe(1)
    }
  })

  test("tile urls are well-formed and in range", () => {
    const zoom = 3
    for (const tile of mapTiles(41.88, -87.63, zoom)) {
      const match = tile.url.match(/^https:\/\/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png$/)
      expect(match).not.toBeNull()
      const [, z, x, y] = match!
      expect(Number(z)).toBe(zoom)
      expect(Number(x)).toBeGreaterThanOrEqual(0)
      expect(Number(x)).toBeLessThan(2 ** zoom)
      expect(Number(y)).toBeGreaterThanOrEqual(0)
      expect(Number(y)).toBeLessThan(2 ** zoom)
    }
  })

  test("x wraps at the antimeridian instead of going out of range", () => {
    for (const tile of mapTiles(0, 179.99, 4)) {
      const x = Number(tile.url.split("/").at(-2))
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(16)
    }
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
