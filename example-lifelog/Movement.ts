import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel"
import * as Files from "../lib/Files.ts"
import type { Resource } from "../lib/Resource.ts"
import { gpsDay, haversineMeters } from "./Gps.ts"
import { readStaysBasis, staysOverlapping, type StayRow } from "./Stays.ts"
import { dataPath } from "./Resources.ts"
import { homeTimeZone } from "./Time.ts"

export const MOVEMENT_VERSION = "movement-v1"
const MOVEMENT_BASIS_VERSION = "stays-v1-composition-2"
const PLACES_KEY = "gps/places.json"
const DAY_MS = 86_400_000
const STAY_RADIUS_M = 200
const GAP_MS = 3 * 60 * 60_000

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
export const movementKey = (day: string, basisHash: string) => `gps/${MOVEMENT_VERSION}/${day}/${basisHash}.json`

export interface MovementFix {
  readonly ts: string
  readonly lat: number
  readonly lon: number
}

export type RawMovementSegment =
  | { readonly kind: "stay"; readonly start: string; readonly end: string; readonly lat: number; readonly lon: number; readonly fixes: number }
  | { readonly kind: "travel"; readonly start: string; readonly end: string; readonly distanceMeters: number; readonly mode: "walk" | "bike" | "drive"; readonly fixes: number }
  | { readonly kind: "gap"; readonly start: string; readonly end: string; readonly fixes: number }

const pathDistance = (points: ReadonlyArray<MovementFix>) => {
  let meters = 0
  for (let index = 1; index < points.length; index++) meters += haversineMeters(points[index - 1]!, points[index]!)
  return meters
}

const transitSegments = (points: ReadonlyArray<MovementFix>): ReadonlyArray<RawMovementSegment> => {
  const result: Array<RawMovementSegment> = []
  const emitTravel = (slice: ReadonlyArray<MovementFix>) => {
    if (slice.length < 2) return
    const elapsed = Date.parse(slice.at(-1)!.ts) - Date.parse(slice[0]!.ts)
    const distanceMeters = pathDistance(slice)
    const speed = distanceMeters / Math.max(1, elapsed / 1000)
    result.push({ kind: "travel", start: slice[0]!.ts, end: slice.at(-1)!.ts, distanceMeters,
      mode: speed < 2.5 ? "walk" : speed < 7 ? "bike" : "drive", fixes: slice.length })
  }
  let chunkStart = 0
  for (let index = 0; index + 1 < points.length; index++) {
    const left = points[index]!
    const right = points[index + 1]!
    if (Date.parse(right.ts) - Date.parse(left.ts) <= GAP_MS || haversineMeters(left, right) <= STAY_RADIUS_M) continue
    emitTravel(points.slice(chunkStart, index + 1))
    result.push({ kind: "gap", start: left.ts, end: right.ts, fixes: 2 })
    chunkStart = index + 1
  }
  emitTravel(points.slice(chunkStart))
  return result
}

/** Compose materialized stays with travel/gap evidence from raw points. */
export const composeMovement = (stays: ReadonlyArray<StayRow>, input: ReadonlyArray<MovementFix>): ReadonlyArray<RawMovementSegment> => {
  const points = [...input].sort((a, b) => a.ts.localeCompare(b.ts))
  const ordered = [...stays].sort((a, b) => a.first_point_ts.localeCompare(b.first_point_ts))
  // stays-v1 faithfully retains every observation. For narrative presentation,
  // only fold a zero-duration singleton when it is bracketed by other stays;
  // its point remains in the raw evidence used for the connecting travel.
  const presented = ordered.filter((stay, index) =>
    stay.point_count !== 1 || stay.observed_duration_s !== 0 || index === 0 || index === ordered.length - 1
  )
  const result: Array<RawMovementSegment> = []
  presented.forEach((stay, index) => {
    result.push({ kind: "stay", start: stay.first_point_ts, end: stay.last_point_ts,
      lat: stay.lat, lon: stay.lon, fixes: stay.point_count })
    const next = presented[index + 1]
    if (!next) return
    const between = points.filter((point) => point.ts >= stay.last_point_ts && point.ts <= next.first_point_ts)
    result.push(...transitSegments(between))
  })
  return result
}

export class Place extends Schema.Class<Place>("Place")({
  id: Schema.String,
  name: Schema.String,
  lat: Schema.Number,
  lon: Schema.Number,
  radiusMeters: Schema.Number
}) {}
const Places = Schema.Array(Place)

class StaySegment extends Schema.Class<StaySegment>("MovementStay")({
  kind: Schema.Literal("stay"), startTime: Schema.String, endTime: Schema.String,
  startLocal: Schema.String, endLocal: Schema.String, lat: Schema.Number, lon: Schema.Number,
  placeId: Schema.NullOr(Schema.String), placeName: Schema.NullOr(Schema.String), geocodedName: Schema.NullOr(Schema.String),
  dwellMinutes: Schema.Number, fixes: Schema.Number
}) {}
class TravelSegment extends Schema.Class<TravelSegment>("MovementTravel")({
  kind: Schema.Literal("travel"), startTime: Schema.String, endTime: Schema.String,
  startLocal: Schema.String, endLocal: Schema.String, distanceMeters: Schema.Number,
  mode: Schema.Literals(["walk", "bike", "drive"]), fixes: Schema.Number
}) {}
class GapSegment extends Schema.Class<GapSegment>("MovementGap")({
  kind: Schema.Literal("gap"), startTime: Schema.String, endTime: Schema.String,
  startLocal: Schema.String, endLocal: Schema.String, fixes: Schema.Number
}) {}
export const MovementSegment = Schema.Union([StaySegment, TravelSegment, GapSegment])

/** Compact GPS evidence for the journal prompt. Coordinates and movement's
 * own narrative intentionally never cross this boundary. */
export const renderMovementTimeline = (movement: Movement) => movement.segments.map((segment) => {
  const times = `${segment.startLocal}-${segment.endLocal}`
  if (segment.kind === "stay") {
    const place = segment.placeName ?? segment.geocodedName
    return `${times} stay${place ? ` at ${place}` : ""} (${segment.dwellMinutes} min)`
  }
  if (segment.kind === "travel") {
    return `${times} ${segment.mode} ${(segment.distanceMeters / 1000).toFixed(1)} km`
  }
  return `${times} gap in GPS evidence`
}).join("\n")

class PlaceSuggestion extends Schema.Class<PlaceSuggestion>("PlaceSuggestion")({
  lat: Schema.Number, lon: Schema.Number, geocodedName: Schema.NullOr(Schema.String), dwellMinutes: Schema.Number
}) {}

export class Movement extends Schema.Class<Movement>("Movement")({
  version: Schema.String, day: Schema.String, basisHash: Schema.String, timeZone: Schema.String,
  generatedAt: Schema.String, segments: Schema.Array(MovementSegment), narrative: Schema.NullOr(Schema.String),
  suggestions: Schema.Array(PlaceSuggestion)
}) {}

const localParts = (instant: Date, zone: string) => Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
)
const localDay = (instant: Date, zone: string) => {
  const p = localParts(instant, zone)
  return `${p.year}-${p.month}-${p.day}`
}
const localTime = (iso: string, zone: string) => {
  const p = localParts(new Date(iso), zone)
  return `${p.hour}:${p.minute}`
}
/** Interpret local midnight in an IANA zone. Two passes resolve normal DST offsets. */
const localMidnightUtc = (day: string, zone: string) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const target = Date.UTC(year, month - 1, date)
  let guess = target
  for (let index = 0; index < 3; index++) {
    const p = localParts(new Date(guess), zone)
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
    guess += target - represented
  }
  return guess
}

const pointsForLocalDay = (day: string, zone: string) => Effect.gen(function*() {
  const start = localMidnightUtc(day, zone)
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const next = new Date(Date.UTC(year, month - 1, date) + DAY_MS).toISOString().slice(0, 10)
  const end = localMidnightUtc(next, zone)
  const utcDays = [...new Set([new Date(start).toISOString().slice(0, 10), new Date(end - 1).toISOString().slice(0, 10)])]
  const rows = (yield* Effect.forEach(utcDays, gpsDay)).flat()
  return rows.filter((point) => {
    const ms = Date.parse(point.ts)
    return ms >= start && ms < end
  }).sort((a, b) => a.ts.localeCompare(b.ts))
})

let lastGeocodeAt = 0
const shortGeocodeName = (response: any): string | null => {
  const address = response?.address ?? {}
  const named = address.amenity ?? address.shop ?? address.leisure
  if (named) return String(named)
  const road = address.road ?? address.pedestrian
  const area = address.suburb ?? address.neighbourhood
  if (road && area) return `${road}, ${area}`
  if (road || area) return String(road ?? area)
  const display = typeof response?.display_name === "string" ? response.display_name.split(",").slice(0, 3).join(",").trim() : ""
  return display || null
}

const reverseGeocode = (lat: number, lon: number) => Effect.gen(function*() {
  const roundedLat = lat.toFixed(4)
  const roundedLon = lon.toFixed(4)
  const key = `gps/geocode-v1/${roundedLat}_${roundedLon}.json`
  const fs = yield* FileSystem.FileSystem
  const path = dataPath(key)
  if (yield* fs.exists(path)) {
    try { return shortGeocodeName(JSON.parse(yield* fs.readFileString(path))) } catch { return null }
  }
  const wait = Math.max(0, 1000 - (Date.now() - lastGeocodeAt))
  if (wait > 0) yield* Effect.sleep(`${wait} millis`)
  const response = yield* Effect.tryPromise({
    try: () => fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${roundedLat}&lon=${roundedLon}`, {
      headers: { "user-agent": "medina-lifelog/1.0 (sco@scottraymond.net)" }
    }),
    catch: (error) => new Error(String(error))
  })
  lastGeocodeAt = Date.now()
  if (!response.ok) return null
  const json = yield* Effect.tryPromise({ try: () => response.json(), catch: (error) => new Error(String(error)) })
  if (!(yield* fs.exists(path))) yield* Files.writeJson(path, json)
  return shortGeocodeName(json)
}).pipe(Effect.catchCause(() => Effect.succeed(null)))

const narrative = (segments: ReadonlyArray<unknown>) => {
  if (segments.length === 0) return Effect.succeed<string | null>(null)
  return LanguageModel.generateText({
    prompt: [
      { role: "system", content: "Write one compact, factual paragraph describing the owner's movements in plain past tense (for example: ‘Walked from home to the gym at 8:30’). Use only the supplied segments. Do not use first person, address the owner, add a heading, or speculate beyond the data." },
      { role: "user", content: JSON.stringify(segments) }
    ]
  }).pipe(
    OpenAiLanguageModel.withConfigOverride({ max_output_tokens: 250 }),
    Effect.map((response) => response.text.trim() || null),
    Effect.catchCause(() => Effect.succeed(null))
  )
}

const readPlaces = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = dataPath(PLACES_KEY)
  if (!(yield* fs.exists(path))) return { places: [] as ReadonlyArray<Place>, hash: sha256("") }
  const text = yield* fs.readFileString(path)
  const places = yield* Schema.decodeUnknownEffect(Places)(JSON.parse(text)).pipe(
    Effect.mapError((error) => new Error(String(error)))
  )
  return { places, hash: sha256(text) }
})

export const movementBasis = (day: string) => Effect.gen(function*() {
  const zone = yield* homeTimeZone
  const start = localMidnightUtc(day, zone)
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const next = new Date(Date.UTC(year, month - 1, date) + DAY_MS).toISOString().slice(0, 10)
  const end = localMidnightUtc(next, zone)
  const points = yield* pointsForLocalDay(day, zone)
  const stays = yield* staysOverlapping(start, end)
  const staysBasis = yield* readStaysBasis
  const places = yield* readPlaces
  const basisHash = sha256(`${MOVEMENT_VERSION}\n${MOVEMENT_BASIS_VERSION}\n${zone}\n${staysBasis.basisHash}\n${places.hash}`)
  return { zone, start, end, points, stays, places: places.places, basisHash }
})

interface MovementBasis {
  readonly zone: string
  readonly start: number
  readonly end: number
  readonly points: ReadonlyArray<MovementFix & { readonly source: string; readonly speed: number | null; readonly alt: number | null; readonly acc: number | null; readonly batt: number | null }>
  readonly stays: ReadonlyArray<StayRow>
  readonly places: ReadonlyArray<Place>
  readonly basisHash: string
}

const materializeMovement = (day: string, basis: MovementBasis) => Effect.gen(function*() {
  const raw = composeMovement(basis.stays, basis.points)
  const segments: Array<StaySegment | TravelSegment | GapSegment> = []
  const suggestionCandidates: Array<{ lat: number; lon: number; geocodedName: string | null; dwellMinutes: number }> = []
  for (const segment of raw) {
    if (segment.kind === "stay") {
      const nearest = [...basis.places]
        .map((place) => ({ place, meters: haversineMeters(segment, place) }))
        .filter(({ place, meters }) => meters <= place.radiusMeters)
        .sort((a, b) => a.meters - b.meters)[0]?.place ?? null
      const geocodedName = yield* reverseGeocode(segment.lat, segment.lon)
      const dwellMinutes = Math.round((Date.parse(segment.end) - Date.parse(segment.start)) / 60_000)
      const visibleStart = new Date(Math.max(Date.parse(segment.start), basis.start)).toISOString()
      const visibleEnd = new Date(Math.min(Date.parse(segment.end), basis.end)).toISOString()
      segments.push(new StaySegment({ kind: "stay", startTime: segment.start, endTime: segment.end,
        startLocal: localTime(visibleStart, basis.zone), endLocal: localTime(visibleEnd, basis.zone),
        lat: segment.lat, lon: segment.lon, placeId: nearest?.id ?? null,
        placeName: nearest?.name ?? geocodedName, geocodedName, dwellMinutes, fixes: segment.fixes }))
      if (!nearest) {
        const existing = suggestionCandidates.find((candidate) => haversineMeters(candidate, segment) <= STAY_RADIUS_M)
        if (existing) {
          const total = existing.dwellMinutes + dwellMinutes
          existing.lat = total === 0 ? (existing.lat + segment.lat) / 2 : (existing.lat * existing.dwellMinutes + segment.lat * dwellMinutes) / total
          existing.lon = total === 0 ? (existing.lon + segment.lon) / 2 : (existing.lon * existing.dwellMinutes + segment.lon * dwellMinutes) / total
          existing.dwellMinutes = total
          existing.geocodedName ??= geocodedName
        } else suggestionCandidates.push({ lat: segment.lat, lon: segment.lon, geocodedName, dwellMinutes })
      }
    } else if (segment.kind === "travel") {
      segments.push(new TravelSegment({ kind: "travel", startTime: segment.start, endTime: segment.end,
        startLocal: localTime(segment.start, basis.zone), endLocal: localTime(segment.end, basis.zone),
        distanceMeters: Math.round(segment.distanceMeters), mode: segment.mode, fixes: segment.fixes }))
    } else {
      segments.push(new GapSegment({ kind: "gap", startTime: segment.start, endTime: segment.end,
        startLocal: localTime(segment.start, basis.zone), endLocal: localTime(segment.end, basis.zone), fixes: segment.fixes }))
    }
  }
  const suggestions = suggestionCandidates.map((suggestion) => new PlaceSuggestion(suggestion))
  const output = new Movement({ version: MOVEMENT_VERSION, day, basisHash: basis.basisHash, timeZone: basis.zone,
    generatedAt: new Date().toISOString(), segments, narrative: yield* narrative(segments), suggestions })
  yield* Files.writeJson(dataPath(movementKey(day, basis.basisHash)), output)
})

const movementInstance = (day: string) => Effect.map(movementBasis(day), (basis) => ({
  key: movementKey(day, basis.basisHash), label: day, dependencies: [PLACES_KEY, "gps/stays-v1/basis.json"],
  materialize: materializeMovement(day, basis)
}))

export const movementResource: Resource<FileSystem.FileSystem | LanguageModel.LanguageModel> = {
  name: "movement",
  instances: Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const zone = yield* homeTimeZone
    const root = dataPath("gps/points-v1")
    const entries = (yield* fs.exists(root)) ? yield* fs.readDirectory(root) : []
    const utcDays = entries.map((entry) => entry.match(/^day=(\d{4}-\d{2}-\d{2})$/)?.[1]).filter((day): day is string => !!day).sort().slice(-16)
    const days = new Set<string>([localDay(new Date(), zone)])
    for (const utcDay of utcDays) for (const point of yield* gpsDay(utcDay)) days.add(localDay(new Date(point.ts), zone))
    const recent = [...days].sort().slice(-14)
    return yield* Effect.forEach(recent, movementInstance)
  }),
  instance: (day) => /^\d{4}-\d{2}-\d{2}$/.test(day) ? movementInstance(day) : Effect.fail(new Error(`not a day: ${day}`))
}

/** Every local civil day represented by a GPS point. This is intentionally
 * broader than movementResource's recent eager window: movement-only days
 * are journal inputs too. */
export const movementDays = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const zone = yield* homeTimeZone
  const root = dataPath("gps/points-v1")
  const entries = (yield* fs.exists(root)) ? yield* fs.readDirectory(root) : []
  const utcDays = entries
    .map((entry) => entry.match(/^day=(\d{4}-\d{2}-\d{2})$/)?.[1])
    .filter((day): day is string => !!day)
    .sort()
  const days = new Set<string>()
  for (const utcDay of utcDays) {
    for (const point of yield* gpsDay(utcDay)) days.add(localDay(new Date(point.ts), zone))
  }
  return [...days].sort()
})

export const movementForDay = (day: string) => Effect.gen(function*() {
  const instance = yield* movementResource.instance!(day)
  const existing = yield* Files.readJson(Movement, dataPath(instance.key))
  if (Option.isSome(existing)) return existing.value
  yield* instance.materialize
  return Option.getOrThrow(yield* Files.readJson(Movement, dataPath(instance.key)))
})
