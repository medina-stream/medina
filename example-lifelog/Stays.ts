import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Files from "../lib/Files.ts"
import type { Source, SourceReport } from "../lib/Resource.ts"
import { dataPath } from "./Resources.ts"
import { duckdb, haversineMeters, quote } from "./Gps.ts"

export const STAYS_VERSION = "stays-v1"
export const DEFAULT_STAY_RADIUS_M = 150
export const STAYS_BASIS_KEY = `gps/${STAYS_VERSION}/basis.json`
const POINTS_ROOT = "gps/points-v1"
const STAYS_ROOT = `gps/${STAYS_VERSION}`

export interface StayPoint { readonly ts: string; readonly lat: number; readonly lon: number }
export interface StayRow {
  readonly first_point_ts: string
  readonly last_point_ts: string
  readonly lat: number
  readonly lon: number
  readonly radius_m: number
  readonly point_count: number
  readonly observed_duration_s: number
}

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const percentile90 = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(0.9 * sorted.length) - 1] ?? 0
}

const finishStay = (members: ReadonlyArray<StayPoint>): StayRow => {
  const center = { lat: median(members.map((point) => point.lat)), lon: median(members.map((point) => point.lon)) }
  const first = members[0]!
  const last = members.at(-1)!
  return {
    first_point_ts: first.ts,
    last_point_ts: last.ts,
    lat: center.lat,
    lon: center.lon,
    radius_m: members.length === 1 ? 0 : percentile90(members.map((point) => haversineMeters(center, point))),
    point_count: members.length,
    observed_duration_s: Math.max(0, Math.round((Date.parse(last.ts) - Date.parse(first.ts)) / 1000))
  }
}

/** Sequential temporal stay detection over globally ordered observations. */
export const detectStays = (input: ReadonlyArray<StayPoint>, radiusM = DEFAULT_STAY_RADIUS_M): ReadonlyArray<StayRow> => {
  const points = [...input].sort((a, b) => a.ts.localeCompare(b.ts))
  if (points.length === 0) return []
  const stays: Array<StayRow> = []
  let members: Array<StayPoint> = []
  for (const point of points) {
    if (members.length > 0) {
      const center = { lat: median(members.map((member) => member.lat)), lon: median(members.map((member) => member.lon)) }
      if (haversineMeters(center, point) > radiusM) {
        stays.push(finishStay(members))
        members = []
      }
    }
    members.push(point)
  }
  stays.push(finishStay(members))
  return stays
}

export class StaysBasis extends Schema.Class<StaysBasis>("StaysBasis")({
  version: Schema.String,
  basisHash: Schema.String,
  computedAt: Schema.String,
  days: Schema.Number,
  stays: Schema.Number
}) {}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const radius = () => {
  const configured = Number(process.env.STAY_RADIUS_M ?? DEFAULT_STAY_RADIUS_M)
  if (!Number.isFinite(configured) || configured <= 0) throw new Error("STAY_RADIUS_M must be a positive number")
  return configured
}

const pointPartitions = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const files = (yield* Files.listFiles(dataPath(POINTS_ROOT))).filter((path) => /^day=\d{4}-\d{2}-\d{2}\/points\.parquet$/.test(path))
  const hashes: Array<{ relative: string; hash: string }> = []
  for (const relative of files) hashes.push({ relative, hash: sha256(yield* fs.readFile(dataPath(`${POINTS_ROOT}/${relative}`))) })
  return hashes
})

export const staysBasisHash = Effect.gen(function*() {
  const files = yield* pointPartitions
  return sha256([STAYS_VERSION, String(radius()), ...files.map(({ relative, hash }) => `${relative}\t${hash}`)].join("\n"))
})

const materializeStays = (basisHash: string) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const partitions = yield* pointPartitions
  const paths = partitions.map(({ relative }) => dataPath(`${POINTS_ROOT}/${relative}`))
  const pointsJson = paths.length === 0 ? "[]" : yield* duckdb(
    `SELECT DISTINCT ON (source, ts, lat, lon)
       strftime(CAST(ts AS TIMESTAMPTZ) AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%g') || 'Z' AS ts, lat, lon
     FROM read_parquet([${paths.map(quote).join(", ")}], union_by_name=true, hive_partitioning=false)
     ORDER BY ts, source, lat, lon`
  )
  const stays = detectStays(JSON.parse(pointsJson || "[]"), radius())
  const work = `${tmpdir()}/medina-stays-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const ndjson = `${work}/stays.ndjson`
  const staging = `${work}/staging`
  yield* fs.makeDirectory(work, { recursive: true })
  yield* fs.writeFileString(ndjson, stays.map((stay) => JSON.stringify({ ...stay, day: stay.first_point_ts.slice(0, 10) })).join("\n") + (stays.length ? "\n" : ""))
  if (stays.length > 0) yield* duckdb(
    `COPY (
       SELECT CAST(first_point_ts AS TIMESTAMP) AS first_point_ts,
              CAST(last_point_ts AS TIMESTAMP) AS last_point_ts,
              CAST(lat AS DOUBLE) AS lat, CAST(lon AS DOUBLE) AS lon,
              CAST(radius_m AS DOUBLE) AS radius_m, CAST(point_count AS INTEGER) AS point_count,
              CAST(observed_duration_s AS BIGINT) AS observed_duration_s, CAST(day AS DATE) AS day
       FROM read_ndjson_auto(${quote(ndjson)})
     ) TO ${quote(staging)} (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (day))`
  )

  const days = [...new Set(stays.map((stay) => stay.first_point_ts.slice(0, 10)))].sort()
  for (const day of days) {
    const stagedFiles = yield* fs.readDirectory(`${staging}/day=${day}`)
    const stagedFile = stagedFiles.find((file) => file.endsWith(".parquet"))
    if (!stagedFile) return yield* Effect.fail(new Error(`no staged stays partition produced for ${day}`))
    const destination = dataPath(`${STAYS_ROOT}/day=${day}/stays.parquet`)
    yield* fs.makeDirectory(destination.slice(0, destination.lastIndexOf("/")), { recursive: true })
    const temporary = `${destination}.tmp-${Date.now()}`
    yield* fs.copyFile(`${staging}/day=${day}/${stagedFile}`, temporary)
    yield* fs.rename(temporary, destination)
  }
  yield* Files.writeJson(dataPath(STAYS_BASIS_KEY), new StaysBasis({
    version: STAYS_VERSION, basisHash, computedAt: new Date().toISOString(), days: days.length, stays: stays.length
  }))
  yield* fs.remove(work, { recursive: true }).pipe(Effect.ignore)
  return { days: days.length, stays: stays.length }
})

export const staysSource: Source<FileSystem.FileSystem> = {
  name: "gps-stays",
  ingest: Effect.gen(function*() {
    const basisHash = yield* staysBasisHash
    const stored = yield* Files.readJson(StaysBasis, dataPath(STAYS_BASIS_KEY))
    if (Option.isSome(stored) && stored.value.basisHash === basisHash) {
      return { discovered: 1, ingested: 0, cached: 1, skipped: 0, failures: [] } satisfies SourceReport
    }
    const result = yield* materializeStays(basisHash)
    yield* Effect.log(`gps-stays: ${result.stays} stays -> ${result.days} day partitions`)
    return { discovered: 1, ingested: result.days, cached: 0, skipped: 0, failures: [] } satisfies SourceReport
  })
}

export const staysDay = (day: string) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const previous = new Date(`${day}T00:00:00.000Z`)
  previous.setUTCDate(previous.getUTCDate() - 1)
  const selections: Array<string> = []
  for (const [partitionDay, carried] of [[day, false], [previous.toISOString().slice(0, 10), true]] as const) {
    const path = dataPath(`${STAYS_ROOT}/day=${partitionDay}/stays.parquet`)
    if (yield* fs.exists(path)) selections.push(
      `SELECT strftime(first_point_ts, '%Y-%m-%dT%H:%M:%S.%g') || 'Z' AS first_point_ts,
              strftime(last_point_ts, '%Y-%m-%dT%H:%M:%S.%g') || 'Z' AS last_point_ts,
              lat, lon, radius_m, point_count, observed_duration_s, ${carried} AS carried
       FROM read_parquet(${quote(path)}, hive_partitioning=false)
       ${carried ? `WHERE last_point_ts >= CAST(${quote(`${day}T00:00:00Z`)} AS TIMESTAMP)` : ""}`
    )
  }
  if (selections.length === 0) return []
  return JSON.parse(yield* duckdb(`${selections.join(" UNION ALL BY NAME ")} ORDER BY first_point_ts`)) as Array<StayRow & { carried: boolean }>
})

export const readStaysBasis = Effect.gen(function*() {
  const basis = yield* Files.readJson(StaysBasis, dataPath(STAYS_BASIS_KEY))
  return Option.getOrElse(basis, () => new StaysBasis({
    version: STAYS_VERSION, basisHash: "missing", computedAt: "", days: 0, stays: 0
  }))
})

/** Stays whose observed interval overlaps [start, end), regardless of their partition day. */
export const staysOverlapping = (start: number, end: number) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const files = (yield* Files.listFiles(dataPath(STAYS_ROOT)))
    .filter((path) => /^day=\d{4}-\d{2}-\d{2}\/stays\.parquet$/.test(path))
    .map((path) => dataPath(`${STAYS_ROOT}/${path}`))
  if (files.length === 0) return []
  const startIso = new Date(start).toISOString()
  const endIso = new Date(end).toISOString()
  const json = yield* duckdb(
    `SELECT strftime(first_point_ts, '%Y-%m-%dT%H:%M:%S.%g') || 'Z' AS first_point_ts,
            strftime(last_point_ts, '%Y-%m-%dT%H:%M:%S.%g') || 'Z' AS last_point_ts,
            lat, lon, radius_m, point_count, observed_duration_s
     FROM read_parquet([${files.map(quote).join(", ")}], union_by_name=true, hive_partitioning=false)
     WHERE last_point_ts >= CAST(${quote(startIso)} AS TIMESTAMP)
       AND first_point_ts < CAST(${quote(endIso)} AS TIMESTAMP)
     ORDER BY first_point_ts`
  )
  return JSON.parse(json || "[]") as Array<StayRow>
})
