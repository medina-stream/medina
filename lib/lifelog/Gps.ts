/**
 * GPS points: parse-at-the-door ingest and a queryable columnar store.
 *
 * Unlike audio, the HTTP envelope around GPS batches is scaffolding, not
 * signal — the points are what matters. So gps-* posts are parsed
 * immediately into rows (raw body preserved as a column for traceability)
 * and appended to a transient inbox of NDJSON files; the compaction pass
 * merges inbox rows into per-UTC-day parquet partitions
 * (`gps/points-v1/day=YYYY-MM-DD/points.parquet`) and deletes what it
 * consumed. DuckDB is the stateless query engine over the partitions —
 * there is no database file.
 *
 * A body that fails to parse falls back to blob capture, so nothing is
 * silently dropped.
 *
 * The store is the artifact store (the `Files` seam), like every other
 * pipeline artifact since the milestone-3 flip: inbox files and
 * partitions are bucket artifacts, and DuckDB — a local-files-only
 * engine — works on scratch materializations of them. This module used
 * raw filesystem calls until Nov 9, 2026, which silently kept the whole
 * points store on medina-dev's local disk after everything else had
 * moved to the bucket (the seam fix that step 7 of the Cloudflare
 * migration is built on; see docs/cloudflare-migration.md §4.3).
 */
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import * as Files from "../Files.ts"
import { dataPath } from "./Resources.ts"
import type { Source, SourceReport } from "../Resource.ts"
import { queryJson as duckdb, quote } from "../connectors/DuckDB.ts"

export { queryJson as duckdb, quote } from "../connectors/DuckDB.ts"

export const GPS_VERSION = "points-v1"

const INBOX_PREFIX = "gps/inbox"
export const gpsPartitionKey = (day: string) => `gps/${GPS_VERSION}/day=${day}/points.parquet`

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
  // Epoch seconds (with optional fraction) vs epoch millis, decided by the
  // shape of the digits -- not string length, which a fraction breaks.
  const seconds = value.match(/^(\d{10})(\.\d+)?$/)
  const ms = seconds
    ? Number(seconds[1] + (seconds[2] ?? "")) * 1000
    : /^\d{13}(\.\d+)?$/.test(value)
      ? Number(value)
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

/** Append parsed points to the transient inbox (one NDJSON file per post).
 * A single seam write (`Files.putBytes`): tmp + rename on the local
 * store, one object PUT in the bucket — either way a reader never sees
 * a half-written file, which matters because queries scan the inbox
 * with `read_ndjson_auto` and one torn file would fail the whole scan. */
export const gpsInboxWrite = Effect.fn("gpsInboxWrite")(function*(points: ReadonlyArray<GpsPoint>) {
  const lines = points.map((point) => JSON.stringify(point)).join("\n") + "\n"
  const name = `${new Date().toISOString().replace(/[:.]/g, "")}-${
    createHash("sha256").update(lines).digest("hex").slice(0, 8)
  }.ndjson`
  yield* Files.putBytes(dataPath(`${INBOX_PREFIX}/${name}`), new TextEncoder().encode(lines))
  return points.length
})

// --- scratch materialization ---------------------------------------------------

/**
 * DuckDB reads and writes local paths only, so store-resident inputs are
 * materialized into a fresh scratch directory (the layout under it
 * mirrors the artifact keys) and outputs are stored back through the
 * seam. The scratch is the caller's to remove (`removeScratch`).
 */
export interface ScratchArtifacts {
  readonly dir: string
  /** Local path for an artifact key (whether or not it was found). */
  readonly pathFor: (key: string) => string
  /** Keys that existed and were materialized. */
  readonly found: ReadonlySet<string>
}

export const materializeArtifacts = (
  keys: ReadonlyArray<string>,
  into?: string
): Effect.Effect<ScratchArtifacts, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = into ?? `${tmpdir()}/medina-gps-scratch-${Date.now()}-${Math.random().toString(36).slice(2)}`
    yield* fs.makeDirectory(dir, { recursive: true })
    // Bounded concurrency: a post-gap inbox can hold thousands of small
    // files, and sequential round trips would dominate the pass.
    const results = yield* Effect.forEach(
      keys,
      (key) => Effect.map(Files.getFile(dataPath(key), `${dir}/${key}`), (got) => [key, got] as const),
      { concurrency: 8 }
    )
    const found = new Set(results.filter(([, got]) => got).map(([key]) => key))
    return { dir, pathFor: (key: string) => `${dir}/${key}`, found }
  }).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))))

export const removeScratch = (scratch: ScratchArtifacts) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(scratch.dir, { recursive: true }).pipe(Effect.ignore)
  })

// --- compaction --------------------------------------------------------------

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
    const batch = (yield* Files.listFiles(dataPath(INBOX_PREFIX)))
      .filter((file) => file.endsWith(".ndjson"))
    if (batch.length === 0) {
      return { discovered: 0, ingested: 0, cached: 0, skipped: 0, failures: [] } satisfies SourceReport
    }

    const failures: Array<{ item: string; error: string }> = []

    // Materialize the batch (and, below, the partitions it touches) into
    // local scratch: DuckDB is a separate process that reads paths, and
    // the inbox and partitions are store artifacts, not local files.
    const inboxKeys = batch.map((file) => `${INBOX_PREFIX}/${file}`)
    const scratch = yield* materializeArtifacts(inboxKeys)
    const report = yield* Effect.gen(function*() {
      // A listed file that will not materialize means the batch changed
      // under us (another compactor consumed it): fail the pass without
      // touching anything, and let the next pass re-derive from the
      // listing. Merging is idempotent, so a retry is harmless.
      for (const key of inboxKeys) {
        if (!scratch.found.has(key)) failures.push({ item: key, error: "inbox file vanished before read" })
      }
      if (failures.length > 0) {
        return { discovered: batch.length, ingested: 0, cached: 0, skipped: 0, failures } satisfies SourceReport
      }
      const paths = inboxKeys.map((key) => scratch.pathFor(key))
      const listSql = paths.map(quote).join(", ")

      // Which days does the batch touch, and which of those already have
      // a partition to merge with?
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
      // Into the same scratch: the outer ensuring removes both at once.
      const partitions = yield* materializeArtifacts(days.map((day) => gpsPartitionKey(day)), scratch.dir)
      const existing = days
        .filter((day) => partitions.found.has(gpsPartitionKey(day)))
        .map((day) => partitions.pathFor(gpsPartitionKey(day)))

      // One pass: inbox rows + touched partitions, deduped, re-partitioned
      // by UTC day into a staging dir inside the scratch. Staging is local
      // because DuckDB is a separate process; this process stores the
      // results back through the seam itself.
      const staging = `${scratch.dir}/staging`
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
          // One seam write per partition: the store registers it, and a
          // reader either sees the old partition or the new one, never a
          // partial file — the atomicity the old copy + rename provided.
          yield* Files.putFile(dataPath(gpsPartitionKey(day)), `${staging}/day=${day}/${stagedFile}`)
          staged += 1
        }
      }

      // Only consume the inbox when every touched day merged cleanly.
      if (failures.length === 0) {
        // Another process may have compacted the same idempotent batch
        // first; deleting an absent artifact succeeds by seam semantics.
        for (const key of inboxKeys) yield* Files.remove(dataPath(key))
        yield* Effect.log(`gps-compact: ${batch.length} inbox files -> ${days.length} day partitions`)
      }
      return {
        discovered: batch.length,
        ingested: staged,
        cached: 0,
        skipped: 0,
        failures
      } satisfies SourceReport
    }).pipe(Effect.ensuring(removeScratch(scratch)))
    return report
  })
}

// --- queries -----------------------------------------------------------------

/** All points for one UTC day, chronological. */
export const gpsDay = (day: string) =>
  Effect.gen(function*() {
    // Points still in the inbox are part of the day too — readers should not
    // have to wait for the compaction pass. Partition and inbox are store
    // artifacts; materialize both into scratch for DuckDB.
    const inboxFiles = (yield* Files.listFiles(dataPath(INBOX_PREFIX)))
      .filter((file) => file.endsWith(".ndjson"))
    const keys = [
      gpsPartitionKey(day),
      ...inboxFiles.map((file) => `${INBOX_PREFIX}/${file}`)
    ]
    const scratch = yield* materializeArtifacts(keys)
    const rows = yield* Effect.gen(function*() {
      const parts: Array<string> = []
      if (scratch.found.has(gpsPartitionKey(day))) {
        parts.push(
          `SELECT ${COLUMNS} FROM read_parquet(${quote(scratch.pathFor(gpsPartitionKey(day)))}, hive_partitioning=false)`
        )
      }
      const inboxPaths = inboxFiles
        .map((file) => `${INBOX_PREFIX}/${file}`)
        .filter((key) => scratch.found.has(key))
        .map((key) => scratch.pathFor(key))
      if (inboxPaths.length > 0) {
        const listSql = inboxPaths.map(quote).join(", ")
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
    }).pipe(Effect.ensuring(removeScratch(scratch)))
    return rows
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
