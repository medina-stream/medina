/**
 * Shared map helpers: keyless OSM tile math plus the pixel math that turns a
 * click back into coordinates. Pure and DOM-free, so the browser bundle and
 * tests both import from here.
 *
 * Tiles come from `tile.openstreetmap.org` directly. The previous
 * `staticmap.openstreetmap.de` service is gone -- it now fails to connect
 * outright, which is why place thumbnails rendered as broken images -- and a
 * tile grid has no single point of failure to lose.
 */

/** Logical size of a place thumbnail, in CSS pixels. */
export const MAP_W = 400
export const MAP_H = 220
/**
 * Width the tile grid is generated for: the widest a map box can get (the
 * body's 46rem max, less padding, rounded up). Generating once for the
 * widest case and centring with CSS means one grid serves every viewport,
 * so resizing and rotating need no refetch and no relayout.
 */
export const MAP_COVER = 768
export const MAP_ZOOM = 15
export const TILE_SIZE = 256

/** Web-mercator pixel coordinates at `zoom`, origin at the top-left. */
export const project = (lat: number, lon: number, zoom: number) => {
  const scale = TILE_SIZE * 2 ** zoom
  const sinLat = Math.sin(lat * Math.PI / 180)
  return {
    x: (lon + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale
  }
}

export interface MapTile {
  readonly url: string
  /** Offset within the viewport, in CSS pixels; may be negative. */
  readonly left: number
  readonly top: number
}

/**
 * The tiles covering a `width`x`height` viewport centered on a point, with
 * their offsets. Tiles outside the valid y range are dropped (the poles);
 * x wraps, so panning across the antimeridian still resolves.
 */
export const mapTiles = (
  lat: number,
  lon: number,
  zoom: number = MAP_ZOOM,
  width: number = MAP_W,
  height: number = MAP_H
): Array<MapTile> => {
  const center = project(lat, lon, zoom)
  // Viewport's top-left in world pixels.
  const originX = center.x - width / 2
  const originY = center.y - height / 2
  const count = 2 ** zoom
  const firstCol = Math.floor(originX / TILE_SIZE)
  const firstRow = Math.floor(originY / TILE_SIZE)
  const lastCol = Math.floor((originX + width) / TILE_SIZE)
  const lastRow = Math.floor((originY + height) / TILE_SIZE)
  const tiles: Array<MapTile> = []
  for (let row = firstRow; row <= lastRow; row++) {
    if (row < 0 || row >= count) continue
    for (let col = firstCol; col <= lastCol; col++) {
      const wrapped = ((col % count) + count) % count
      tiles.push({
        url: `https://tile.openstreetmap.org/${zoom}/${wrapped}/${row}.png`,
        left: col * TILE_SIZE - originX,
        top: row * TILE_SIZE - originY
      })
    }
  }
  return tiles
}

/** Coordinates of a click `dx`/`dy` pixels right/down from the image center,
 * for a thumbnail centered on (`centerLat`, `centerLon`) at `zoom`.
 * Standard slippy-map projection, inverted. */
export const nudgeLatLon = (
  centerLat: number, centerLon: number, zoom: number, dx: number, dy: number
): { lat: number; lon: number } => {
  const scale = TILE_SIZE * 2 ** zoom
  const center = project(centerLat, centerLon, zoom)
  const lon = (center.x + dx) / scale * 360 - 180
  const n = Math.PI * (1 - 2 * (center.y + dy) / scale)
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lat, lon }
}
