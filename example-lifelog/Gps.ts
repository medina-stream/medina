/**
 * GPS points: parse-at-the-door ingest and a queryable columnar store.
 *
 * Unlike audio, the HTTP envelope around GPS batches is scaffolding, not
 * signal — the points are what matters. So gps-* posts are parsed
 * immediately into rows (raw body preserved as a column for traceability)
 * and appended to a transient inbox of NDJSON files; the hourly pass
 * compacts inbox rows into per-UTC-day parquet partitions
 * (`gps/points-v1/day=YYYY-MM-DD/points.parquet`) and deletes what it
 * consumed. DuckDB is the stateless query engine over the partitions —
 * there is no database file.
 *
 * A body that fails to parse falls back to blob capture, so nothing is
 * silently dropped.
 */
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { dataPath } from "./Resources.ts"
import type { Source, SourceReport } from "../lib/Resource.ts"

export const GPS_VERSION = "points-v1"

const INBOX_PREFIX = "gps/inbox"
const partitionKey = (day: string) => `gps/${GPS_VERSION}/day=${day}/points.parquet`

/** The canonical column list, used explicitly in every SQL statement so
 * input schema drift (or hive-path inference) can never leak extra columns
 * into partitions. */
const COLUMNS = "source, ts, lat, lon, speed, alt, acc, batt, raw" 

export class GpsPoint extends Schema.Class<GpsPoint>("GpsPoint")({
  source: Schema.String,
  /** UTC instant of the fix, full ISO. */
  ts: Schema.String,
  lat: Schema.Number,
  lon: Schema.Number,
  speed: Schema.NullOr(Schema.Number),
  alt: Schema.NullOr(Schema.Number),
  acc: Schema.NullOr(Schema.Number),
  batt: Schema.NullOr(Schema.Number),
  /** The body this point was parsed from, verbatim. */
  raw: Schema.String
}) {}

// --- parsing -----------------------------------------------------------------

const finite = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const isoOrNull = (value: string | null | undefined): string | null => {
  if (!value) return null
  const ms = /^\d{10,13}(\.\d+)?$/.test(value)
    ? Number(value) * (value.length <= 11 ? 1000 : 1) // epoch seconds vs millis
    : Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** GPSLogger custom-URL bodies: form-encoded lat/lon/time/s/alt/acc/batt. */
const parseFormPoint = (source: string, body: string): GpsPoint | null => {
  if (!/(^|&)lat=/.test(body)) return null
  const params = new URLSearchParams(body)
  const lat = finite(params.get("lat"))
  const lon = finite(params.get("lon") ?? params.get("long") ?? params.get("longitude"))
  const ts = isoOrNull(params.get("time") ?? params.get("timestamp") ?? params.get("tst"))
  if (lat === null || lon === null || ts === null) return null
  return new GpsPoint({
    source,
    ts,
    lat,
    lon,
    speed: finite(params.get("s") ?? params.get("spd") ?? params.get("speed") ?? params.get("vel")),
    alt: finite(params.get("alt") ?? params.get("altitude")),
    acc: finite(params.get("acc") ?? params.get("accuracy")),
    batt: finite(params.get("batt") ?? params.get("battery")),
    raw: body
  })
}

/** Overland-style `{locations: [GeoJSON Feature...]}` and OwnTracks-style
 * single-object JSON bodies. */
const parseJsonPoints = (source: string, body: string): Array<GpsPoint> | null => {
  let parsed: any
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const features = Array.isArray(parsed?.locations)
    ? parsed.locations
    : parsed?._type === "location" || (parsed?.lat !== undefined && parsed?.lon !== undefined)
      ? [parsed]
      : null
  if (!features) return null
  const points: Array<GpsPoint> = []
  for (const feature of features) {
    const geometry = feature?.geometry?.coordinates
    const properties = feature?.properties ?? feature
    const lon = finite(geometry?.[0] ?? properties.lon ?? properties.longitude)
    const lat = finite(geometry?.[1] ?? properties.lat ?? properties.latitude)
    const ts = isoOrNull(String(properties.timestamp ?? properties.time ?? properties.tst ?? ""))
    if (lat === null || lon === null || ts === null) continue
    points.push(
      new GpsPoint({
        source,
        ts,
        lat,
        lon,
        speed: finite(properties.speed ?? properties.vel),
        alt: finite(properties.altitude ?? properties.alt),
        acc: finite(properties.horizontal_accuracy ?? properties.acc ?? properties.accuracy),
        batt: finite(properties.battery_level ?? properties.batt),
        raw: JSON.stringify(feature)
      })
    )
  }
  return points.length ? points : null
}

export const parseGpsBody = (source: string, body: string): Array<GpsPoint> | null => {
  const form = parseFormPoint(source, body)
  if (form) return [form]
  return parseJsonPoints(source, body)
}

// --- inbox -------------------------------------------------------------------

/** Append parsed points to the transient inbox (one NDJSON file per post). */
export const gpsInboxWrite = Effect.fn("gpsInboxWrite")(function*(points: ReadonlyArray<GpsPoint>) {
  const fs = yield* FileSystem.FileSystem
  const lines = points.map((point) => JSON.stringify(point)).join("\n") + "\n"
  const name = `${new Date().toISOString().replace(/[:.]/g, "")}-${
    createHash("sha256").update(lines).digest("hex").slice(0, 8)
  }.ndjson`
  yield* fs.makeDirectory(dataPath(INBOX_PREFIX), { recursive: true })
  yield* fs.writeFileString(dataPath(`${INBOX_PREFIX}/${name}`), lines)
  return points.length
})

// --- compaction --------------------------------------------------------------

const duckdb = (sql: string) =>
  Effect.callback<string, Error>((resume) => {
    execFile("duckdb", ["-json", "-c", sql], { timeout: 120_000, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return resume(Effect.fail(new Error(`duckdb failed: ${stderr || error.message}`)))
      resume(Effect.succeed(stdout))
    })
  })

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`

/**
 * Merge inbox rows into their days' parquet partitions, then delete the
 * consumed inbox files. One DuckDB pass regardless of how many days the
 * batch touches (hive PARTITION_BY into a staging dir, then per-day atomic
 * renames), so a months-long backfill compacts as cheaply as an hourly
 * trickle. Idempotent: the merge de-duplicates on (source, ts, lat, lon),
 * and a crash before the deletes only means rows merge again to no effect.
 */
export const gpsCompactSource: Source<FileSystem.FileSystem> = {
  name: "gps-compact",
  ingest: Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const inboxDir = dataPath(INBOX_PREFIX)
    const files = (yield* fs.exists(inboxDir)) ? yield* fs.readDirectory(inboxDir) : []
    const batch = files.filter((file) => file.endsWith(".ndjson")).sort()
    if (batch.length === 0) {
      return { discovered: 0, ingested: 0, cached: 0, skipped: 0, failures: [] } satisfies SourceReport
    }

    const paths = batch.map((file) => `${inboxDir}/${file}`)
    const listSql = paths.map(quote).join(", ")
    const failures: Array<{ item: string; error: string }> = []

    // Which days does the batch touch, and which of those already have a
    // partition to merge with?
    const daysJson = yield* duckdb(
      `SELECT DISTINCT strftime(CAST(ts AS TIMESTAMPTZ) AT TIME ZONE 'UTC', '%Y-%m-%d') AS day
       FROM read_ndjson_auto([${listSql}], union_by_name=true)`
    ).pipe(Effect.catchCause((cause) =>
      Effect.sync(() => {
        failures.push({ item: "inbox-scan", error: String(cause).slice(0, 500) })
        return "[]"
      })
    ))
    const days: Array<string> = JSON.parse(daysJson || "[]").map((row: { day: string }) => row.day)
    if (days.length === 0) {
      return { discovered: batch.length, ingested: 0, cached: 0, skipped: 0, failures } satisfies SourceReport
    }
    const existing: Array<string> = []
    for (const day of days) {
      const partition = dataPath(partitionKey(day))
      if (yield* fs.exists(partition)) existing.push(partition)
    }

    // One pass: inbox rows + touched partitions, deduped, re-partitioned by
    // UTC day into a staging dir. Staging lives on LOCAL disk: duckdb is a
    // separate process, and network-mount dentry caching means its freshly
    // written directories may not be visible to us for ~a second; local
    // staging avoids the race entirely (and is faster), with this process
    // doing the mount writes itself.
    const staging = `${tmpdir()}/medina-gps-staging-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const existingSql = existing.length
      // hive_partitioning=false: the partition path carries day=YYYY-MM-DD,
      // which would otherwise be inferred as a column and collide with the
      // day we compute for PARTITION_BY (duckdb silently writes day_1=).
      ? ` UNION ALL BY NAME SELECT ${COLUMNS} FROM read_parquet([${existing.map(quote).join(", ")}], union_by_name=true, hive_partitioning=false)`
      : ""
    // Partitions store no day column -- the day lives in the hive path, and
    // PARTITION_BY drops it from the written files, keeping the schema
    // identical between a day's partition and the inbox rows it came from.
    let staged = 0
    yield* duckdb(
      `COPY (
         SELECT ${COLUMNS}, strftime(CAST(ts AS TIMESTAMPTZ) AT TIME ZONE 'UTC', '%Y-%m-%d') AS day
         FROM (
           SELECT DISTINCT ON (source, ts, lat, lon) ${COLUMNS}
           FROM (
             SELECT ${COLUMNS} FROM read_ndjson_auto([${listSql}], union_by_name=true)${existingSql}
           )
           ORDER BY ts
         )
       ) TO ${quote(staging)} (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (day))`
    ).pipe(Effect.catchCause((cause) =>
      Effect.sync(() => {
        failures.push({ item: "compact", error: String(cause).slice(0, 500) })
        return ""
      })
    ))

    if (failures.length === 0) {
      for (const day of days) {
        const stagedFiles = yield* fs.readDirectory(`${staging}/day=${day}`).pipe(
          Effect.orElseSucceed(() => [] as Array<string>)
        )
        const stagedFile = stagedFiles.find((file) => file.endsWith(".parquet"))
        if (!stagedFile) {
          failures.push({ item: day, error: "no staged partition produced" })
          continue
        }
        const partition = dataPath(partitionKey(day))
        yield* fs.makeDirectory(partition.slice(0, partition.lastIndexOf("/")), { recursive: true })
        // copy + rename: staging is on a different filesystem, and the
        // rename keeps partition replacement atomic for concurrent readers.
        const tmp = `${partition}.tmp-${Date.now()}`
        yield* fs.copyFile(`${staging}/day=${day}/${stagedFile}`, tmp)
        yield* fs.rename(tmp, partition)
        staged += 1
      }
    }
    yield* fs.remove(staging, { recursive: true }).pipe(Effect.ignore)

    // Only consume the inbox when every touched day merged cleanly.
    if (failures.length === 0) {
      for (const path of paths) yield* fs.remove(path)
      yield* Effect.log(`gps-compact: ${batch.length} inbox files -> ${days.length} day partitions`)
    }
    return {
      discovered: batch.length,
      ingested: staged,
      cached: 0,
      skipped: 0,
      failures
    } satisfies SourceReport
  })
}

// --- queries -----------------------------------------------------------------

/** All points for one UTC day, chronological. */
export const gpsDay = (day: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const partition = dataPath(partitionKey(day))
    const inboxDir = dataPath(INBOX_PREFIX)
    const inbox = (yield* fs.exists(inboxDir))
      ? (yield* fs.readDirectory(inboxDir)).filter((file) => file.endsWith(".ndjson"))
      : []
    // Points still in the inbox are part of the day too — readers should not
    // have to wait for the hourly compaction.
    const parts: Array<string> = []
    if (yield* fs.exists(partition)) {
      parts.push(`SELECT ${COLUMNS} FROM read_parquet(${quote(partition)}, hive_partitioning=false)`)
    }
    if (inbox.length > 0) {
      const listSql = inbox.map((file) => quote(`${inboxDir}/${file}`)).join(", ")
      parts.push(`SELECT ${COLUMNS} FROM read_ndjson_auto([${listSql}], union_by_name=true)`)
    }
    if (parts.length === 0) return []
    const json = yield* duckdb(
      `SELECT DISTINCT ON (source, ts, lat, lon)
         source,
         strftime(CAST(ts AS TIMESTAMPTZ) AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%g') || 'Z' AS ts,
         lat, lon, speed, alt, acc, batt
       FROM (${parts.join(" UNION ALL BY NAME ")})
       WHERE strftime(CAST(ts AS TIMESTAMPTZ) AT TIME ZONE 'UTC', '%Y-%m-%d') = ${quote(day)}
       ORDER BY ts`
    )
    return JSON.parse(json || "[]") as Array<{
      source: string
      ts: string
      lat: number
      lon: number
      speed: number | null
      alt: number | null
      acc: number | null
      batt: number | null
    }>
  })
// --- "my location": the end-user view ------------------------------------------

/**
 * A simple summary of recent GPS evidence: the last known fix plus what the
 * trailing points say about movement. Computed on demand from the point
 * store (partitions + inbox) — a view, not a materialized resource, since
 * "where am I" changes with every ping. Deliberately unfancy; forecasting
 * and place-naming come later, carefully.
 */

const EARTH_RADIUS_M = 6_371_000

export const haversineMeters = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const rad = (deg: number) => (deg * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

const utcDay = (date: Date) => date.toISOString().slice(0, 10)

export const locationSummary = Effect.gen(function*() {
  const now = new Date()
  const today = utcDay(now)
  const yesterday = utcDay(new Date(now.getTime() - 86_400_000))
  // Trailing window across the UTC-midnight seam.
  const points = [...(yield* gpsDay(yesterday)), ...(yield* gpsDay(today))]
  if (points.length === 0) return null

  const last = points.at(-1)!
  const lastMs = Date.parse(last.ts)
  const ageSeconds = Math.max(0, Math.round((now.getTime() - lastMs) / 1000))

  // Movement, judged from the last 15 minutes of fixes before the last one.
  const windowStart = lastMs - 15 * 60 * 1000
  const recent = points.filter((point) => Date.parse(point.ts) >= windowStart)
  const first = recent[0]!
  const displacementM = Math.round(haversineMeters(first, last))
  const spanSeconds = Math.max(1, (lastMs - Date.parse(first.ts)) / 1000)
  // Path distance catches pacing-in-circles that displacement misses.
  let pathM = 0
  for (let i = 1; i < recent.length; i++) pathM += haversineMeters(recent[i - 1]!, recent[i]!)

  const state = ageSeconds > 3600
    ? ("stale" as const)
    : displacementM > 100 || pathM > 250
      ? ("moving" as const)
      : ("stationary" as const)

  return {
    lat: last.lat,
    lon: last.lon,
    ts: last.ts,
    ageSeconds,
    state,
    recent: {
      windowMinutes: 15,
      fixes: recent.length,
      displacementMeters: displacementM,
      pathMeters: Math.round(pathM),
      averageSpeedMps: Number((pathM / spanSeconds).toFixed(2))
    },
    source: last.source
  }
})
