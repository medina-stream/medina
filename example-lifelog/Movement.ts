import { createHash } from "node:crypto"
import * as Cache from "effect/Cache"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel"
import * as Files from "../lib/Files.ts"
import type { Resource } from "../lib/Resource.ts"
import { gpsDay, haversineMeters } from "./Gps.ts"
import { readStaysBasis, staysDayBasisHash, staysOverlappingDay, type StayRow } from "./Stays.ts"
import { dataPath } from "./Resources.ts"
import { eagerSinceDay, homeTimeZone, withinEagerWindow } from "./Time.ts"

export const MOVEMENT_VERSION = "movement-v1"
const MOVEMENT_BASIS_VERSION = "stays-v1-composition-2"
/** The user-owned place list, at the mount root so it is easy to find and
 * edit by hand. The previous `gps/places.json` location still reads (never
 * writes) so an existing list is not silently dropped. */
const PLACES_KEY = "places.json"
const LEGACY_PLACES_KEY = "gps/places.json"
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
export const Places = Schema.Array(Place)

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

class ForwardResult extends Schema.Class<ForwardResult>("ForwardResult")({
  name: Schema.String, lat: Schema.Number, lon: Schema.Number
}) {}
const ForwardResults = Schema.Array(ForwardResult)

let lastFwdGeocodeAt = 0

/** Address search via Nominatim: up to 5 matches for a query. Same 1 req/s
 * discipline and write-once disk cache as reverse geocoding, so the places
 * UI can refine pins without leaning on the public API every keystroke.
 * Never fails — no matches is an empty list. */
export const forwardGeocode = (query: string): Effect.Effect<ReadonlyArray<ForwardResult>, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const key = `gps/geocode-fwd-v1/${sha256(query.trim().toLowerCase())}.json`
    const path = dataPath(key)
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(path)) {
      try {
        return yield* Schema.decodeUnknownEffect(ForwardResults)(JSON.parse(yield* fs.readFileString(path))).pipe(
          Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ForwardResult>))
        )
      } catch {
        return [] as ReadonlyArray<ForwardResult>
      }
    }
    const wait = Math.max(0, 1000 - (Date.now() - lastFwdGeocodeAt))
    if (wait > 0) yield* Effect.sleep(`${wait} millis`)
    const response = yield* Effect.tryPromise({
      try: () => fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`, {
        headers: { "user-agent": "medina-lifelog/1.0 (sco@scottraymond.net)" },
        // The public API sometimes blackholes requests instead of refusing
        // them; fail fast so one search can't stall the request path.
        signal: AbortSignal.timeout(15_000)
      }),
      catch: () => new Error("geocode request failed")
    }).pipe(Effect.catchCause(() => Effect.succeed(null)))
    lastFwdGeocodeAt = Date.now()
    if (!response || !response.ok) return [] as ReadonlyArray<ForwardResult>
    const json = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new Error("geocode parse failed")
    }).pipe(Effect.catchCause(() => Effect.succeed([] as Array<unknown>)))
    const results = (Array.isArray(json) ? json : []).flatMap((entry): Array<ForwardResult> => {
      if (typeof entry !== "object" || entry === null) return []
      const record = entry as Record<string, unknown>
      const lat = Number(record.lat)
      const lon = Number(record.lon)
      if (typeof record.display_name !== "string" || !Number.isFinite(lat) || !Number.isFinite(lon)) return []
      return [new ForwardResult({ name: record.display_name, lat, lon })]
    }).slice(0, 5)
    yield* Files.writeJson(path, Schema.encodeSync(ForwardResults)([...results])).pipe(
      Effect.catchCause(() => Effect.void)
    )
    return results
  }).pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ForwardResult>)))

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
      headers: { "user-agent": "medina-lifelog/1.0 (sco@scottraymond.net)" },
      // Same blackholing as forward search: fail fast so one lookup can't
      // stall movement materialization (this already catches to null below).
      signal: AbortSignal.timeout(15_000)
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
  for (const key of [PLACES_KEY, LEGACY_PLACES_KEY]) {
    const path = dataPath(key)
    if (!(yield* fs.exists(path))) continue
    const text = yield* fs.readFileString(path)
    const places = yield* Schema.decodeUnknownEffect(Places)(JSON.parse(text)).pipe(
      Effect.mapError((error) => new Error(String(error)))
    )
    return { places, hash: sha256(text) }
  }
  return { places: [] as ReadonlyArray<Place>, hash: sha256("") }
})

/** The current place list, for the editing endpoint. Empty when no list
 * exists yet — the candidates endpoint is how the first places get found. */
export const listPlaces = Effect.map(readPlaces, ({ places }) => places)

/** Whole-list replace for the editing endpoint: the validated request body
 * becomes the new `places.json`. The movement basis already hashes places
 * content, so saving re-derives affected days on the next pipeline pass. */
export const replacePlaces = (places: ReadonlyArray<Place>) =>
  Files.writeJson(dataPath(PLACES_KEY), Schema.encodeSync(Places)([...places]))

/** One unnamed stay cluster worth naming, aggregated across days. */
export interface PlaceCandidate {
  readonly lat: number
  readonly lon: number
  readonly geocodedName: string | null
  readonly dwellMinutes: number
  readonly days: ReadonlyArray<string>
}

/** Merge raw suggestions across days: nearby clusters fold into one
 * dwell-weighted centroid (the same math materialization uses within a day).
 * Pure — safe to test. */
export const mergePlaceSuggestions = (
  suggestions: ReadonlyArray<{ lat: number; lon: number; geocodedName: string | null; dwellMinutes: number; day: string }>
): Array<PlaceCandidate> => {
  const merged: Array<{ lat: number; lon: number; geocodedName: string | null; dwellMinutes: number; days: Array<string> }> = []
  for (const suggestion of suggestions) {
    const existing = merged.find((candidate) => haversineMeters(candidate, suggestion) <= STAY_RADIUS_M)
    if (existing) {
      const total = existing.dwellMinutes + suggestion.dwellMinutes
      existing.lat = total === 0 ? (existing.lat + suggestion.lat) / 2 : (existing.lat * existing.dwellMinutes + suggestion.lat * suggestion.dwellMinutes) / total
      existing.lon = total === 0 ? (existing.lon + suggestion.lon) / 2 : (existing.lon * existing.dwellMinutes + suggestion.lon * suggestion.dwellMinutes) / total
      existing.dwellMinutes = total
      existing.geocodedName ??= suggestion.geocodedName
      if (!existing.days.includes(suggestion.day)) existing.days.push(suggestion.day)
    } else {
      merged.push({
        lat: suggestion.lat, lon: suggestion.lon, geocodedName: suggestion.geocodedName,
        dwellMinutes: suggestion.dwellMinutes, days: [suggestion.day]
      })
    }
  }
  return merged.sort((a, b) => b.dwellMinutes - a.dwellMinutes)
}

/** Newest-per-day suggestions merged across days, minus anything the place
 * list already covers. Reads run concurrently — the corpus is hundreds of
 * small files on a network mount, where sequential round trips stall. */
const computePlaceCandidates = (entries: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const byDay = new Map<string, Array<string>>()
    for (const entry of entries) {
      const [day, file] = entry.split("/")
      if (!day || !file || !file.endsWith(".json")) continue
      byDay.set(day, [...(byDay.get(day) ?? []), entry])
    }
    const perDay = yield* Effect.forEach([...byDay], ([day, keys]) =>
      Effect.gen(function*() {
        const movements = (yield* Effect.forEach(
          keys,
          (key) => Files.readJson(Movement, dataPath(`gps/${MOVEMENT_VERSION}/${key}`)),
          { concurrency: 8 }
        )).flatMap((movement) => Option.isSome(movement) ? [movement.value] : [])
        const newest = movements.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt)).at(-1)
        return (newest?.suggestions ?? []).map((suggestion) => ({ ...suggestion, day }))
      }), { concurrency: 8 })
    const { places } = yield* readPlaces
    return mergePlaceSuggestions(perDay.flat()).filter((candidate) =>
      !places.some((place) => haversineMeters(candidate, place) <= place.radiusMeters)
    )
  })

/** Memoized candidates, keyed on exactly what can change them: the places
 * content hash (PUT /places rewrites it) and the movement file listing
 * (content-addressed names, so the same names mean the same bytes). One
 * listing per call stays cheap; the full read happens only when something
 * actually changed. */
let placeCandidatesMemo: { key: string; value: ReadonlyArray<PlaceCandidate> } | null = null

/** Candidate places: unnamed stay clusters from the newest movement per day,
 * merged across days and minus anything the place list already covers.
 * Read-only over small JSON files — serving never touches derivation. */
export const placeCandidates: Effect.Effect<ReadonlyArray<PlaceCandidate>, Error, FileSystem.FileSystem> =
  Effect.gen(function*() {
    const entries = yield* Files.listFiles(dataPath(`gps/${MOVEMENT_VERSION}`))
    const { hash } = yield* readPlaces
    const key = `${hash}\n${[...entries].sort().join("\n")}`
    if (placeCandidatesMemo?.key === key) return placeCandidatesMemo.value
    const value = yield* computePlaceCandidates(entries)
    placeCandidatesMemo = { key, value }
    return value
  })

/** Content hashes for the point partitions covering a set of UTC days. */
const pointPartitionHashes = (utcDays: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const hashes: Array<string> = []
    for (const day of utcDays) {
      const path = dataPath(`gps/points-v1/day=${day}/points.parquet`)
      if (yield* fs.exists(path)) hashes.push(`${day}:${sha256(yield* fs.readFile(path))}`)
    }
    return hashes
  })

/** The UTC day range a local day spans: [first, last] inclusive. */
const localDayUtcRange = (day: string, zone: string) => {
  const start = localMidnightUtc(day, zone)
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const next = new Date(Date.UTC(year, month - 1, date) + DAY_MS).toISOString().slice(0, 10)
  const end = localMidnightUtc(next, zone)
  return [new Date(start).toISOString().slice(0, 10), new Date(end - 1).toISOString().slice(0, 10)] as const
}

/** A per-day movement basis hash: covers only the stay partitions that can
 * overlap this local day, the point partitions for the UTC days the local
 * day spans, places, and the zone. One new GPS point on day D changes only
 * D's point partition and the stay partitions near D — so only days whose
 * window includes D get a new basis, not all 49. */
export const movementDayBasisHash = (day: string) =>
  Effect.gen(function*() {
    const zone = yield* homeTimeZone
    const [firstUtc, lastUtc] = localDayUtcRange(day, zone)
    const start = localMidnightUtc(day, zone)
    const [year, month, date] = day.split("-").map(Number) as [number, number, number]
    const next = new Date(Date.UTC(year, month - 1, date) + DAY_MS).toISOString().slice(0, 10)
    const end = localMidnightUtc(next, zone)
    const utcDays = [...new Set([firstUtc, lastUtc])]
    const pointHashes = yield* pointPartitionHashes(utcDays)
    const stayHash = yield* staysDayBasisHash(start, end)
    const places = yield* readPlaces
    return sha256(`${MOVEMENT_VERSION}\n${MOVEMENT_BASIS_VERSION}\n${zone}\n${stayHash}\n${pointHashes.join("\n")}\n${places.hash}`)
  })


/** Batch per-day basis hashes for eager enumeration. One pass reads every
 * stay and point partition on disk and indexes them by UTC day, so each
 * day's hash is composed from the index without re-reading files. The
 * result is a Map keyed by local day. */
export const movementDayBasisHashes = (days: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const zone = yield* homeTimeZone
    const places = yield* readPlaces
    const fs = yield* FileSystem.FileSystem

    // Index all stay partitions by UTC day.
    const stayEntries = (yield* Files.listFiles(dataPath("gps/stays-v1")))
      .filter((path) => /^day=\d{4}-\d{2}-\d{2}\/stays\.parquet$/.test(path))
    const stayHashByDay = new Map<string, string>()
    for (const relative of stayEntries) {
      const day = relative.split("/")[0]!.replace("day=", "")
      stayHashByDay.set(day, sha256(yield* fs.readFile(dataPath(`gps/stays-v1/${relative}`))))
    }

    // Index all point partitions by UTC day.
    const pointEntries = (yield* Files.listFiles(dataPath("gps/points-v1")))
      .filter((path) => /^day=\d{4}-\d{2}-\d{2}\/points\.parquet$/.test(path))
    const pointHashByDay = new Map<string, string>()
    for (const relative of pointEntries) {
      const day = relative.split("/")[0]!.replace("day=", "")
      pointHashByDay.set(day, sha256(yield* fs.readFile(dataPath(`gps/points-v1/${relative}`))))
    }

    const radiusStr = String(process.env.STAY_RADIUS_M ?? "150")
    const result = new Map<string, string>()
    for (const day of days) {
      const [firstUtc, lastUtc] = localDayUtcRange(day, zone)
      // Stay partitions that can overlap: firstUtc-1 through lastUtc.
      const stayDays: Array<string> = []
      const prev = new Date(`${firstUtc}T00:00:00Z`)
      prev.setUTCDate(prev.getUTCDate() - 1)
      stayDays.push(prev.toISOString().slice(0, 10))
      for (let t = new Date(`${firstUtc}T00:00:00Z`); t.getTime() <= new Date(`${lastUtc}T00:00:00Z`).getTime(); t.setUTCDate(t.getUTCDate() + 1)) {
        stayDays.push(t.toISOString().slice(0, 10))
      }
      const stayParts = stayDays
        .filter((d) => stayHashByDay.has(d))
        .map((d) => `day=${d}/stays.parquet\t${stayHashByDay.get(d)}`)
      const stayHash = sha256(["stays-v1", radiusStr, ...stayParts].join("\n"))

      // Point partitions for the local day's UTC days.
      const utcDays = [...new Set([firstUtc, lastUtc])]
      const pointParts = utcDays.filter((d) => pointHashByDay.has(d)).map((d) => `${d}:${pointHashByDay.get(d)}`)

      result.set(day, sha256(`${MOVEMENT_VERSION}\n${MOVEMENT_BASIS_VERSION}\n${zone}\n${stayHash}\n${pointParts.join("\n")}\n${places.hash}`))
    }
    return result
  })

export const movementBasis = (day: string) => Effect.gen(function*() {
  const zone = yield* homeTimeZone
  const start = localMidnightUtc(day, zone)
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const next = new Date(Date.UTC(year, month - 1, date) + DAY_MS).toISOString().slice(0, 10)
  const end = localMidnightUtc(next, zone)
  const points = yield* pointsForLocalDay(day, zone)
  const stays = yield* staysOverlappingDay(start, end)
  const places = yield* readPlaces
  const basisHash = yield* movementDayBasisHash(day)
  return { zone, start, end, points, stays, places: places.places, basisHash }
}).pipe(Effect.withSpan("movement.basis", { attributes: { day } }))

/**
 * Read-path movement summary for the journal key: whether the day counts
 * as moving, plus its basis hash (null when it does not). `hasMovement`
 * MUST be partition membership — the same test the batch enumeration
 * uses — not an in-range point count: the two disagree on days whose
 * partitions hold no in-range points, forking the journal key so the
 * pipeline writes one file and reads look for another, forever.
 */
export interface MovementRead {
  readonly hasMovement: boolean
  readonly movementHash: string | null
}

const movementReadCache = Effect.runSync(Cache.makeWith(
  (day: string) =>
    Effect.gen(function*() {
      const hasMovement = (yield* movementDays).includes(day)
      return {
        hasMovement,
        movementHash: hasMovement ? yield* movementDayBasisHash(day) : null
      } satisfies MovementRead
    }),
  {
    capacity: 512,
    // Failures must not poison reads: a transient failure expires almost
    // immediately, while successes ride out the calm between ingests.
    // Movement inputs only change when new GPS lands, far slower than the
    // pipeline's hourly convergence.
    timeToLive: (exit) => Exit.isSuccess(exit) ? "10 minutes" : "1 second",
    requireServicesAt: "lookup"
  }
))

/**
 * Cached movement derivation for the read path only (`journalCachedForDay`
 * via the lazy journal instance). Materialization — the pipeline's
 * `movementInstance`/`movementBasis` calls — stays exact and never touches
 * this cache, so ingest-time updates cannot be shadowed by it. Worst case
 * a detail view keys off minutes-old movement while the list already flags
 * the day stale; the next pass converges both.
 */
export const movementReadForDay = (day: string) => Cache.get(movementReadCache, day)

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

/** Per-day: the instance key uses the day's own basis hash, so a change
 * to one partition stales only nearby days — not the whole corpus. The
 * heavy per-day point/stay reads happen inside materialize, when it runs. */
const movementInstance = (day: string) => Effect.map(movementDayBasisHash(day), (basisHash) => ({
  key: movementKey(day, basisHash), label: day, dependencies: [PLACES_KEY, "gps/stays-v1/basis.json"],
  materialize: Effect.flatMap(movementBasis(day), (basis) => materializeMovement(day, basis)).pipe(
    Effect.mapError((error) => error instanceof Error ? error : new Error(String(error)))
  )
}))

export const movementResource: Resource<FileSystem.FileSystem | LanguageModel.LanguageModel> = {
  name: "movement",
  instances: Effect.gen(function*() {
    const zone = yield* homeTimeZone
    const days = new Set<string>([localDay(new Date(), zone), ...yield* movementDays])
    const since = yield* eagerSinceDay
    const recent = withinEagerWindow(days, since, (day) => day).sort().slice(-14)
    return yield* Effect.forEach(recent, movementInstance)
  }),
  instance: (day) => /^\d{4}-\d{2}-\d{2}$/.test(day) ? movementInstance(day) : Effect.fail(new Error(`not a day: ${day}`))
}

/** Memo for movementDays keyed on the stays basis hash, which covers the
 * content of every points partition — serving must not re-scan parquet on
 * each request. A new day appears once staysSource has seen the new points
 * (each hourly pass, before movement/journal run). */
let movementDaysMemo: { key: string; days: ReadonlyArray<string> } | null = null

/**
 * The local civil days a UTC partition's points can fall in: the local day
 * of its first and last millisecond (one day, or two across midnight).
 * Pure and deterministic — safe to test.
 */
export const utcPartitionLocalDays = (utcDay: string, zone: string): ReadonlyArray<string> => {
  const [year, month, date] = utcDay.split("-").map(Number) as [number, number, number]
  // Parts, not a formatted string: component order varies by locale build.
  const format = new Intl.DateTimeFormat("en", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
  const localDay = (utcMs: number): string => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(utcMs)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    )
    return `${parts.year}-${parts.month}-${parts.day}`
  }
  const start = Date.UTC(year, month - 1, date)
  const first = localDay(start)
  const last = localDay(start + DAY_MS - 1)
  return first === last ? [first] : [first, last]
}

/** Every local civil day represented by a GPS point, from the partition
 * directory listing — no DuckDB, so this stays cheap on every GET. Matches
 * the old DISTINCT scan exactly (any point in the local window counts).
 * Intentionally broader than movementResource's recent eager window:
 * movement-only days are journal inputs too. */
export const movementDays = Effect.gen(function*() {
  const memoKey = `${(yield* readStaysBasis).basisHash}\n${yield* homeTimeZone}`
  if (movementDaysMemo?.key === memoKey) return movementDaysMemo.days
  const fs = yield* FileSystem.FileSystem
  const zone = yield* homeTimeZone
  const root = dataPath("gps/points-v1")
  const entries = (yield* fs.exists(root)) ? yield* fs.readDirectory(root) : []
  const days = [...new Set(entries.flatMap((entry) => {
    const match = /^day=(\d{4}-\d{2}-\d{2})$/.exec(entry)
    return match ? utcPartitionLocalDays(match[1]!, zone) : []
  }))].sort()
  movementDaysMemo = { key: memoKey, days }
  return days
})

export const movementForDay = (day: string) => Effect.gen(function*() {
  const instance = yield* movementResource.instance!(day)
  const existing = yield* Files.readJson(Movement, dataPath(instance.key))
  if (Option.isSome(existing)) return existing.value
  yield* instance.materialize
  return Option.getOrThrow(yield* Files.readJson(Movement, dataPath(instance.key)))
})

/** Read-only dereference for the request path: return the current movement
 * when it is already on disk, `None` when it is stale or missing. Never
 * materializes — the hourly pipeline pass is the sole materializer, so
 * serving a stale day costs no LLM narrative or geocoding calls. */
export const movementCachedForDay = (day: string) => Effect.gen(function*() {
  const instance = yield* movementResource.instance!(day)
  return yield* Files.readJson(Movement, dataPath(instance.key))
})
