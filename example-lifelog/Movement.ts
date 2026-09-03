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
import { dataPath } from "./Resources.ts"
import { homeTimeZone } from "./Lifelog.ts"

export const MOVEMENT_VERSION = "movement-v1"
const PLACES_KEY = "gps/places.json"
const DAY_MS = 86_400_000
const STAY_RADIUS_M = 200
const STAY_MIN_MS = 15 * 60_000
const GAP_MS = 3 * 60 * 60_000

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const movementKey = (day: string, basisHash: string) => `gps/${MOVEMENT_VERSION}/${day}/${basisHash}.json`

export interface MovementFix {
  readonly ts: string
  readonly lat: number
  readonly lon: number
}

export type RawMovementSegment =
  | { readonly kind: "stay"; readonly start: string; readonly end: string; readonly lat: number; readonly lon: number; readonly fixes: number }
  | { readonly kind: "travel"; readonly start: string; readonly end: string; readonly distanceMeters: number; readonly mode: "walk" | "bike" | "drive"; readonly fixes: number }
  | { readonly kind: "gap"; readonly start: string; readonly end: string; readonly fixes: number }

const centroid = (points: ReadonlyArray<MovementFix>) => ({
  lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
  lon: points.reduce((sum, point) => sum + point.lon, 0) / points.length
})

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

/** Pure stay/travel segmentation. Fixes are sorted defensively. */
export const segmentMovement = (input: ReadonlyArray<MovementFix>): ReadonlyArray<RawMovementSegment> => {
  const points = [...input].sort((a, b) => a.ts.localeCompare(b.ts))
  if (points.length === 0) return []
  if (points.length === 1) {
    const point = points[0]!
    return [{ kind: "stay", start: point.ts, end: point.ts, lat: point.lat, lon: point.lon, fixes: 1 }]
  }

  const stays: Array<{ start: number; end: number; lat: number; lon: number }> = []
  for (let start = 0; start < points.length;) {
    let end = start
    let center = centroid(points.slice(start, end + 1))
    while (end + 1 < points.length && haversineMeters(center, points[end + 1]!) <= STAY_RADIUS_M) {
      end += 1
      center = centroid(points.slice(start, end + 1))
    }
    if (end > start && Date.parse(points[end]!.ts) - Date.parse(points[start]!.ts) >= STAY_MIN_MS) {
      stays.push({ start, end, ...center })
      start = end + 1
    } else {
      start += 1
    }
  }

  if (stays.length === 0) {
    return transitSegments(points)
  }

  const result: Array<RawMovementSegment> = []
  const emitBetween = (from: number, to: number) => {
    if (to <= from) return
    result.push(...transitSegments(points.slice(from, to + 1)))
  }
  if (stays[0]!.start > 0) emitBetween(0, stays[0]!.start)
  stays.forEach((stay, index) => {
    const first = points[stay.start]!
    const last = points[stay.end]!
    result.push({ kind: "stay", start: first.ts, end: last.ts, lat: stay.lat, lon: stay.lon, fixes: stay.end - stay.start + 1 })
    const next = stays[index + 1]
    if (next) emitBetween(stay.end, next.start)
  })
  const lastStay = stays.at(-1)!
  if (lastStay.end < points.length - 1) emitBetween(lastStay.end, points.length - 1)
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

const movementBasis = (day: string) => Effect.gen(function*() {
  const zone = yield* homeTimeZone
  const points = yield* pointsForLocalDay(day, zone)
  const places = yield* readPlaces
  const pointsHash = sha256(points.map((p) => `${p.source}\t${p.ts}\t${p.lat}\t${p.lon}\t${p.speed ?? ""}\t${p.alt ?? ""}\t${p.acc ?? ""}\t${p.batt ?? ""}`).join("\n"))
  const basisHash = sha256(`${MOVEMENT_VERSION}\n${zone}\n${pointsHash}\n${places.hash}`)
  return { zone, points, places: places.places, basisHash }
})

interface MovementBasis {
  readonly zone: string
  readonly points: ReadonlyArray<MovementFix & { readonly source: string; readonly speed: number | null; readonly alt: number | null; readonly acc: number | null; readonly batt: number | null }>
  readonly places: ReadonlyArray<Place>
  readonly basisHash: string
}

const materializeMovement = (day: string, basis: MovementBasis) => Effect.gen(function*() {
  const raw = segmentMovement(basis.points)
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
      segments.push(new StaySegment({ kind: "stay", startTime: segment.start, endTime: segment.end,
        startLocal: localTime(segment.start, basis.zone), endLocal: localTime(segment.end, basis.zone),
        lat: segment.lat, lon: segment.lon, placeId: nearest?.id ?? null,
        placeName: nearest?.name ?? geocodedName, geocodedName, dwellMinutes, fixes: segment.fixes }))
      if (!nearest) {
        const existing = suggestionCandidates.find((candidate) => haversineMeters(candidate, segment) <= STAY_RADIUS_M)
        if (existing) {
          const total = existing.dwellMinutes + dwellMinutes
          existing.lat = (existing.lat * existing.dwellMinutes + segment.lat * dwellMinutes) / Math.max(1, total)
          existing.lon = (existing.lon * existing.dwellMinutes + segment.lon * dwellMinutes) / Math.max(1, total)
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
  key: movementKey(day, basis.basisHash), label: day, dependencies: [PLACES_KEY],
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

export const movementForDay = (day: string) => Effect.gen(function*() {
  const instance = yield* movementResource.instance!(day)
  const existing = yield* Files.readJson(Movement, dataPath(instance.key))
  if (Option.isSome(existing)) return existing.value
  yield* instance.materialize
  return Option.getOrThrow(yield* Files.readJson(Movement, dataPath(instance.key)))
})
