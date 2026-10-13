import { tmpdir } from "node:os"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Files from "../Files.ts"
import { sha256 } from "../Hash.ts"
import type { Source, SourceReport } from "../Resource.ts"
import { dataPath } from "./Resources.ts"
import { duckdb, haversineMeters, quote } from "./Gps.ts"
import { cachedFileHash, cachedFileHashes, flushFileHashes } from "./FileHashes.ts"

export const STAYS_VERSION = "stays-v1"
export const DEFAULT_STAY_RADIUS_M = 150
export const STAYS_BASIS_KEY = `gps/${STAYS_VERSION}/basis.json`
const POINTS_ROOT = "gps/points-v1"
const STAYS_ROOT = `gps/${STAYS_VERSION}`
const DAY_MS = 86_400_000

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

/**
 * Incremental median over a stream: two heaps keep the lower and upper
 * halves balanced, so `add` is O(log n) and `median` is O(1) — where the
 * old per-point sorted copy made a long stay O(n^2 log n).
 */
export class RunningMedian {
  // Max-heap (lower half) and min-heap (upper half); sizes differ by <= 1,
  // with the lower half holding the extra element when the count is odd.
  private low: Array<number> = []
  private high: Array<number> = []

  private static siftUp(heap: Array<number>, index: number, before: (a: number, b: number) => boolean) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (!before(heap[index]!, heap[parent]!)) return
      ;[heap[index], heap[parent]] = [heap[parent]!, heap[index]!]
      index = parent
    }
  }

  private static siftDown(heap: Array<number>, index: number, before: (a: number, b: number) => boolean) {
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let best = index
      if (left < heap.length && before(heap[left]!, heap[best]!)) best = left
      if (right < heap.length && before(heap[right]!, heap[best]!)) best = right
      if (best === index) return
      ;[heap[index], heap[best]] = [heap[best]!, heap[index]!]
      index = best
    }
  }

  private static push(heap: Array<number>, value: number, before: (a: number, b: number) => boolean) {
    heap.push(value)
    RunningMedian.siftUp(heap, heap.length - 1, before)
  }

  private static pop(heap: Array<number>, before: (a: number, b: number) => boolean): number {
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      RunningMedian.siftDown(heap, 0, before)
    }
    return top
  }

  add(value: number) {
    const beforeLow = (a: number, b: number) => a > b
    const beforeHigh = (a: number, b: number) => a < b
    if (this.low.length === 0 || value <= this.low[0]!) RunningMedian.push(this.low, value, beforeLow)
    else RunningMedian.push(this.high, value, beforeHigh)
    if (this.low.length > this.high.length + 1) {
      RunningMedian.push(this.high, RunningMedian.pop(this.low, beforeLow), beforeHigh)
    } else if (this.high.length > this.low.length) {
      RunningMedian.push(this.low, RunningMedian.pop(this.high, beforeHigh), beforeLow)
    }
  }

  median(): number {
    if (this.low.length === 0) return Number.NaN
    return this.low.length > this.high.length
      ? this.low[0]!
      : (this.low[0]! + this.high[0]!) / 2
  }

  get size() {
    return this.low.length + this.high.length
  }
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

/**
 * Incremental stay detector: feed points in chronological order, collect
 * finished stays from `finish()`. The cluster center is the running
 * median (O(log n) per point), and only the open cluster is retained —
 * so detection can stream one UTC-day partition at a time, carrying the
 * open cluster across midnight, without holding the GPS history.
 */
export class StayDetector {
  private members: Array<StayPoint> = []
  private latMedian = new RunningMedian()
  private lonMedian = new RunningMedian()
  private readonly radiusM: number

  constructor(radiusM = DEFAULT_STAY_RADIUS_M) {
    this.radiusM = radiusM
  }

  add(point: StayPoint): StayRow | null {
    let finished: StayRow | null = null
    if (this.members.length > 0) {
      const center = { lat: this.latMedian.median(), lon: this.lonMedian.median() }
      if (haversineMeters(center, point) > this.radiusM) {
        finished = finishStay(this.members)
        this.members = []
        this.latMedian = new RunningMedian()
        this.lonMedian = new RunningMedian()
      }
    }
    this.members.push(point)
    this.latMedian.add(point.lat)
    this.lonMedian.add(point.lon)
    return finished
  }

  finish(): Array<StayRow> {
    if (this.members.length === 0) return []
    const stay = finishStay(this.members)
    this.members = []
    this.latMedian = new RunningMedian()
    this.lonMedian = new RunningMedian()
    return [stay]
  }
}

/** Sequential temporal stay detection over globally ordered observations. */
export const detectStays = (input: ReadonlyArray<StayPoint>, radiusM = DEFAULT_STAY_RADIUS_M): ReadonlyArray<StayRow> => {
  const points = [...input].sort((a, b) => a.ts.localeCompare(b.ts))
  const detector = new StayDetector(radiusM)
  const stays: Array<StayRow> = []
  for (const point of points) {
    const finished = detector.add(point)
    if (finished !== null) stays.push(finished)
  }
  stays.push(...detector.finish())
  return stays
}

/**
 * Stay detection partitioned by UTC day: each chunk is one day's points,
 * and the open cluster carries over into the next day (a stay is still
 * partitioned by its first point's day, and a cross-midnight stay stays
 * whole). Equivalent to `detectStays` over the concatenated days.
 */
export const detectStaysByDay = (
  days: ReadonlyArray<ReadonlyArray<StayPoint>>,
  radiusM = DEFAULT_STAY_RADIUS_M
): ReadonlyArray<StayRow> => {
  const detector = new StayDetector(radiusM)
  const stays: Array<StayRow> = []
  for (const dayPoints of days) {
    const points = [...dayPoints].sort((a, b) => a.ts.localeCompare(b.ts))
    for (const point of points) {
      const finished = detector.add(point)
      if (finished !== null) stays.push(finished)
    }
  }
  stays.push(...detector.finish())
  return stays
}

export class StaysBasis extends Schema.Class<StaysBasis>("StaysBasis")({
  version: Schema.String,
  basisHash: Schema.String,
  computedAt: Schema.String,
  days: Schema.Number,
  stays: Schema.Number
}) {}

const radius = () => {
  const configured = Number(process.env.STAY_RADIUS_M ?? DEFAULT_STAY_RADIUS_M)
  if (!Number.isFinite(configured) || configured <= 0) throw new Error("STAY_RADIUS_M must be a positive number")
  return configured
}

const pointPartitions = Effect.gen(function*() {
  const files = (yield* Files.listFiles(dataPath(POINTS_ROOT))).filter((path) => /^day=\d{4}-\d{2}-\d{2}\/points\.parquet$/.test(path))
  const hashes = yield* cachedFileHashes(files.map((relative) => dataPath(`${POINTS_ROOT}/${relative}`)))
  return files.map((relative, index) => ({ relative, hash: hashes[index]! }))
})

/** The UTC-day partitions that can hold stays overlapping the local day
 * [start, end). A stay is partitioned by the UTC day of its first point; since
 * the longest observed stay is < 24h, a stay overlapping [start, end) must
 * have started no earlier than start − 24h. So the candidate partitions span
 * from the UTC day before `start` through the UTC day of `end − 1ms` — at
 * most three partitions, usually two. */
const stayCandidateDays = (start: number, end: number) => {
  const first = new Date(start - DAY_MS).toISOString().slice(0, 10)
  const last = new Date(end - 1).toISOString().slice(0, 10)
  const days: Array<string> = []
  for (let t = new Date(`${first}T00:00:00Z`); t.getTime() <= new Date(`${last}T00:00:00Z`).getTime(); t.setUTCDate(t.getUTCDate() + 1)) {
    days.push(t.toISOString().slice(0, 10))
  }
  return days
}

/** Paths and content hashes for the stay partitions that can overlap a local
 * day. Only the 2-3 relevant partitions are read, so a change to one
 * partition stales only the days whose window it can reach. */
const stayPartitionsFor = (start: number, end: number) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const present: Array<{ relative: string; path: string }> = []
    for (const day of stayCandidateDays(start, end)) {
      const relative = `day=${day}/stays.parquet`
      const path = dataPath(`${STAYS_ROOT}/${relative}`)
      if (yield* fs.exists(path)) present.push({ relative, path })
    }
    const hashes = yield* Effect.forEach(present, ({ path }) => cachedFileHash(path), { concurrency: 4 })
    yield* flushFileHashes
    return present.map(({ relative }, index) => ({ relative, hash: hashes[index]! }))
  })

/** A per-day stays basis hash: covers only the stay partitions that can
 * overlap the local day window, plus the stay version and radius. A new GPS
 * point on day D re-materializes stays; only partitions near D change, so
 * only days whose window includes D get a new basis — not all 49. */
export const staysDayBasisHash = (start: number, end: number) =>
  Effect.gen(function*() {
    const partitions = yield* stayPartitionsFor(start, end)
    return sha256([STAYS_VERSION, String(radius()), ...partitions.map(({ relative, hash }) => `${relative}\t${hash}`)].join("\n"))
  })

/** Stays whose observed interval overlaps [start, end), reading only the 2-3
 * relevant partitions instead of the whole corpus. */
export const staysOverlappingDay = (start: number, end: number) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const files: Array<string> = []
    for (const day of stayCandidateDays(start, end)) {
      const path = dataPath(`${STAYS_ROOT}/day=${day}/stays.parquet`)
      if (yield* fs.exists(path)) files.push(path)
    }
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

export const staysBasisHash = Effect.gen(function*() {
  const files = yield* pointPartitions
  return sha256([STAYS_VERSION, String(radius()), ...files.map(({ relative, hash }) => `${relative}\t${hash}`)].join("\n"))
})

const materializeStays = (basisHash: string) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const partitions = yield* pointPartitions
  // One UTC-day partition at a time, in day order: only that day's points
  // (plus the open cluster carried over from the previous day) are in
  // memory, never the whole GPS history as one JSON string. Partitions
  // are disjoint by ts day, so per-partition de-duplication matches the
  // old whole-corpus DISTINCT ON.
  const detector = new StayDetector(radius())
  const stays: Array<StayRow> = []
  for (const { relative } of partitions) {
    const path = dataPath(`${POINTS_ROOT}/${relative}`)
    const pointsJson = yield* duckdb(
      `SELECT DISTINCT ON (source, ts, lat, lon)
         strftime(CAST(ts AS TIMESTAMPTZ) AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%g') || 'Z' AS ts, lat, lon
       FROM read_parquet(${quote(path)}, union_by_name=true, hive_partitioning=false)
       ORDER BY ts, source, lat, lon`
    )
    const dayPoints = JSON.parse(pointsJson || "[]") as Array<StayPoint>
    for (const point of dayPoints) {
      const finished = detector.add(point)
      if (finished !== null) stays.push(finished)
    }
  }
  stays.push(...detector.finish())
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
    const temporary = `${destination}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
