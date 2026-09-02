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
import { execFile } from "node:child_process"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { dataPath } from "./Resources.ts"
import type { Source, SourceReport } from "../lib/Resource.ts"

export const GPS_VERSION = "points-v1"

const INBOX_PREFIX = "gps/inbox"
const partitionKey = (day: string) => `gps/${GPS_VERSION}/day=${day}/points.parquet`

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
 * consumed inbox files. Idempotent: the merge de-duplicates on the full row,
 * partitions are replaced atomically, and a crash before the deletes only
 * means rows get merged again (to no effect) next pass.
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

    // Which days does the batch touch?
    const paths = batch.map((file) => `${inboxDir}/${file}`)
    const listSql = paths.map(quote).join(", ")
    const daysJson = yield* duckdb(
      `SELECT DISTINCT strftime(CAST(ts AS TIMESTAMPTZ) AT TIME ZONE 'UTC', '%Y-%m-%d') AS day
       FROM read_ndjson_auto([${listSql}])`
    )
    const days: Array<string> = JSON.parse(daysJson || "[]").map((row: { day: string }) => row.day)

    let merged = 0
    const failures: Array<{ item: string; error: string }> = []
    for (const day of days) {
      const partition = dataPath(partitionKey(day))
      const partitionDir = partition.slice(0, partition.lastIndexOf("/"))
      yield* fs.makeDirectory(partitionDir, { recursive: true })
      const existing = yield* fs.exists(partition)
      const sources = existing
        ? `SELECT * FROM read_ndjson_auto([${listSql}]) UNION ALL BY NAME SELECT * FROM read_parquet(${quote(partition)})`
        : `SELECT * FROM read_ndjson_auto([${listSql}])`
      const tmp = `${partition}.tmp-${Date.now()}.parquet`
      yield* duckdb(
        `COPY (
           SELECT DISTINCT ON (source, ts, lat, lon) *
           FROM (${sources})
           WHERE strftime(CAST(ts AS TIMESTAMPTZ) AT TIME ZONE 'UTC', '%Y-%m-%d') = ${quote(day)}
           ORDER BY ts
         ) TO ${quote(tmp)} (FORMAT PARQUET, COMPRESSION ZSTD)`
      ).pipe(Effect.catchCause((cause) =>
        Effect.sync(() => {
          failures.push({ item: day, error: String(cause).slice(0, 500) })
        })
      ))
      if (yield* fs.exists(tmp)) {
        yield* fs.rename(tmp, partition)
        merged += 1
      }
    }

    // Only consume the inbox when every touched day merged cleanly.
    if (failures.length === 0) {
      for (const path of paths) yield* fs.remove(path)
      yield* Effect.log(`gps-compact: ${batch.length} inbox files -> ${days.length} day partitions`)
    }
    return {
      discovered: batch.length,
      ingested: merged,
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
    if (yield* fs.exists(partition)) parts.push(`SELECT * FROM read_parquet(${quote(partition)})`)
    if (inbox.length > 0) {
      const listSql = inbox.map((file) => quote(`${inboxDir}/${file}`)).join(", ")
      parts.push(`SELECT * FROM read_ndjson_auto([${listSql}])`)
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
