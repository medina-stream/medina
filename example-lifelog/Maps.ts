/**
 * Shared map helpers: keyless OSM static thumbnails plus the pixel math that
 * turns a click on one back into coordinates. Pure and DOM-free, so the
 * browser bundle and tests both import from here.
 */

export const MAP_W = 400
export const MAP_H = 220
export const MAP_ZOOM = 15

/** A static thumbnail centered on the pin, with the pin drawn on top. */
export const staticMapUrl = (lat: number, lon: number, zoom: number = MAP_ZOOM): string => {
  const params = new URLSearchParams({
    center: `${lat.toFixed(5)},${lon.toFixed(5)}`,
    zoom: String(zoom),
    size: `${MAP_W}x${MAP_H}`,
    maptype: "mapnik",
    markers: `${lat.toFixed(5)},${lon.toFixed(5)},red`
  })
  return `https://staticmap.openstreetmap.de/staticmap.php?${params}`
}

/** Coordinates of a click `dx`/`dy` pixels right/down from the image center,
 * for a thumbnail centered on (`centerLat`, `centerLon`) at `zoom`.
 * Standard slippy-map projection, inverted. */
export const nudgeLatLon = (
  centerLat: number, centerLon: number, zoom: number, dx: number, dy: number
): { lat: number; lon: number } => {
  const scale = 256 * 2 ** zoom
  const centerX = (centerLon + 180) / 360 * scale
  const sinLat = Math.sin(centerLat * Math.PI / 180)
  const centerY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale
  const lon = (centerX + dx) / scale * 360 - 180
  const n = Math.PI * (1 - 2 * (centerY + dy) / scale)
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lat, lon }
}
