/**
 * Place shapes: the named locations a person cares about, and the
 * unnamed ones the pipeline noticed.
 *
 * Split out of `Movement.ts` so the browser can import these without the
 * DuckDB/filesystem machinery that computes them. `Movement.ts` re-exports
 * them, so server callers are unaffected.
 */
import * as Schema from "effect/Schema"

/**
 * A named place. `radiusMeters` is the match distance: a stay within it is
 * attributed to this place, which is why editing places restates journals.
 */
export class Place extends Schema.Class<Place>("Place")({
  id: Schema.String,
  name: Schema.String,
  lat: Schema.Number,
  lon: Schema.Number,
  radiusMeters: Schema.Number
}) {}

export const Places = Schema.Array(Place)

/**
 * A recurring stay that matches no known place -- offered to the UI as a
 * naming suggestion. `days` carries the civil days it was observed, so the
 * UI can show why it is worth naming.
 */
export class PlaceCandidate extends Schema.Class<PlaceCandidate>("PlaceCandidate")({
  lat: Schema.Number,
  lon: Schema.Number,
  geocodedName: Schema.NullOr(Schema.String),
  dwellMinutes: Schema.Number,
  days: Schema.Array(Schema.String)
}) {}

/** One forward-geocoding hit for the place editor's address search. */
export class GeocodeResult extends Schema.Class<GeocodeResult>("GeocodeResult")({
  name: Schema.String,
  lat: Schema.Number,
  lon: Schema.Number
}) {}
