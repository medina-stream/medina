/**
 * The GPS stages on the Medina Worker (migration milestone 4,
 * step 7 — docs/cloudflare-migration.md §4.3 step 7): gps-compact
 * (merge the points inbox into per-UTC-day Parquet partitions) and
 * gps-stays (stay detection over the partitions, with its basis
 * record), ported from lib/lifelog/Gps.ts and lib/lifelog/Stays.ts.
 *
 * Prerequisites that landed on medina-dev first (Nov 9, 2026): the
 * points store routes through the artifact-store seam (it used raw
 * filesystem calls while everything else moved to the bucket in
 * milestone 3, which froze the bucket's copy at Oct 28 and wedged
 * compaction — a single all-inbox DuckDB scan outgrew its timeout
 * at 8,051 files and the all-or-nothing merge could never recover),
 * and compaction merges bounded sub-batches of 500 files. The
 * bucket therefore holds the live points state, and this port
 * reads and writes the same artifacts.
 *
 * The merge is decision-for-decision the server's: inbox rows and
 * the touched days' partition rows unioned, de-duplicated on
 * (source, ts, lat, lon) — first occurrence wins, inbox files in
 * ascending key order before partition rows, matching the server's
 * UNION ALL order — sorted by ts, one partition per UTC day.
 * Partitions are compared as row SETS, never bytes: the server
 * writes DuckDB ZSTD Parquet, this port writes SNAPPY Parquet via
 * hyparquet-writer (timestamps at millisecond precision — every
 * value in the store originates as a JavaScript ISO string, so
 * nothing is lost), and both readers (DuckDB, hyparquet) read
 * either encoding.
 *
 * Stays are the server's own algorithm ported line for line
 * (RunningMedian / StayDetector / finishStay from Stays.ts,
 * haversine from Gps.ts): partitions stream in day order through
 * one detector, a stay is partitioned by its first point's UTC
 * day, and the basis hash is the server's exact construction —
 * sha256 over "stays-v1", the radius, and one "relative\tsha256"
 * line per points partition — so a Worker-computed basis is
 * directly comparable to the stored basis record.
 *
 * SHADOW MODE (the step-7 build): the pass performs nothing.
 * Compaction is checked two-phase through the notebook, because
 * partitions are mutable (unlike the write-once records the media
 * stages diff): a pass whose inbox fits the work bound records,
 * per touched day, the row set the server's partitions must hold
 * once it consumes exactly this batch; a later pass settles each
 * recorded expectation — matched when the feeding inbox files are
 * gone and the partition holds exactly the recorded set,
 * mismatched when they are gone and it holds anything else,
 * pending while they remain. Stays are checked directly: when the
 * stored basis equals the basis computed over the current
 * partitions, the stored stay partitions must equal the stay sets
 * computed here; a differing basis is pending (the server
 * recomputes on its own next pass).
 *
 * LIVE MODE (the step-7 cutover): the pass performs one bounded
 * batch (500 inbox files): write every touched day's merged
 * partition first, delete the batch's inbox files only after all
 * writes land — the server's ordering, idempotent throughout —
 * then recompute stays when the basis moved. Which mode runs is
 * the GPS_MODE deploy variable; shadow is the default and the
 * rollback position.
 *
 * Structure, as in src/archive.ts: the domain (row shapes, the
 * merge, the stay detector, the Parquet codec) sits above the
 * platform layer (Effect services over the R2 binding, the
 * ledger, and the notebook Durable Object).
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { parquetWriteBuffer } from "hyparquet-writer";
import {
  ArtifactLedger,
  NotebookError,
  sha256Hex,
  type ArtifactReadError,
  type DurableObjectNamespaceLike,
  type IndexRequestError,
} from "./capture.ts";
import {
  ArtifactCatalog,
  type CatalogBucketLike,
  type CatalogError,
} from "./catalog.ts";

// ---------------------------------------------------------------------------
// Domain: keys and row shapes (ports of lib/lifelog/Gps.ts / Stays.ts)
// ---------------------------------------------------------------------------

export const GPS_VERSION = "points-v1";
export const STAYS_VERSION = "stays-v1";
export const INBOX_PREFIX = "gps/inbox";
export const POINTS_PREFIX = `gps/${GPS_VERSION}`;
export const STAYS_PREFIX = `gps/${STAYS_VERSION}`;
export const STAYS_BASIS_KEY = `${STAYS_PREFIX}/basis.json`;
export const STAY_RADIUS_M = 150;

export const gpsPartitionKey = (day: string): string =>
  `${POINTS_PREFIX}/day=${day}/points.parquet`;
export const staysPartitionKey = (day: string): string =>
  `${STAYS_PREFIX}/day=${day}/stays.parquet`;

const DAY_PARTITION = /^day=(\d{4}-\d{2}-\d{2})\/points\.parquet$/;
const STAY_PARTITION = /^day=(\d{4}-\d{2}-\d{2})\/stays\.parquet$/;

/** One GPS fix as the store carries it (the server's GpsPoint). */
export interface GpsPointRow {
  readonly source: string;
  /** UTC instant, JavaScript ISO (millisecond precision). */
  readonly ts: string;
  readonly lat: number;
  readonly lon: number;
  readonly speed: number | null;
  readonly alt: number | null;
  readonly acc: number | null;
  readonly batt: number | null;
  readonly raw: string | null;
}

export interface StayRow {
  readonly first_point_ts: string;
  readonly last_point_ts: string;
  readonly lat: number;
  readonly lon: number;
  readonly radius_m: number;
  readonly point_count: number;
  readonly observed_duration_s: number;
}

export interface StaysBasisShape {
  readonly version: string;
  readonly basisHash: string;
  readonly computedAt: string;
  readonly days: number;
  readonly stays: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const nullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? parsed
    : null;
};

/**
 * Parse one inbox file (NDJSON of GpsPoint rows, exactly what
 * gpsInboxWrite and the capture loop's location fixes write).
 * Throws on any malformed line: the server's DuckDB scan fails
 * the whole sub-batch on a file it cannot read, and the port
 * keeps the same all-or-nothing posture per batch.
 */
export const parseInboxText = (text: string): Array<GpsPointRow> => {
  const rows: Array<GpsPointRow> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) throw new Error("inbox row is not an object");
    const { source, ts, lat, lon } = parsed;
    if (typeof source !== "string") throw new Error("inbox row: source");
    if (typeof ts !== "string" || !Number.isFinite(Date.parse(ts))) {
      throw new Error("inbox row: ts");
    }
    if (typeof lat !== "number" || !Number.isFinite(lat)) {
      throw new Error("inbox row: lat");
    }
    if (typeof lon !== "number" || !Number.isFinite(lon)) {
      throw new Error("inbox row: lon");
    }
    rows.push({
      source,
      ts: new Date(Date.parse(ts)).toISOString(),
      lat,
      lon,
      speed: nullableNumber(parsed["speed"]),
      alt: nullableNumber(parsed["alt"]),
      acc: nullableNumber(parsed["acc"]),
      batt: nullableNumber(parsed["batt"]),
      raw: typeof parsed["raw"] === "string" ? parsed["raw"] : null,
    });
  }
  return rows;
};

/** The merge's identity: DISTINCT ON (source, ts, lat, lon). */
export const rowKey = (row: GpsPointRow): string =>
  `${row.source}\u0000${row.ts}\u0000${row.lat}\u0000${row.lon}`;

/**
 * De-duplicate (first occurrence wins) and order by ts — the
 * server's merge. Callers pass inbox rows first (files in
 * ascending key order), then the partition's rows, mirroring the
 * UNION ALL the server's DISTINCT ON scans.
 */
export const mergeRows = (
  rows: ReadonlyArray<GpsPointRow>,
): Array<GpsPointRow> => {
  const seen = new Set<string>();
  const deduped: Array<GpsPointRow> = [];
  for (const row of rows) {
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped.sort(
    (a, b) =>
      Date.parse(a.ts) - Date.parse(b.ts) ||
      a.source.localeCompare(b.source) ||
      a.lat - b.lat ||
      a.lon - b.lon,
  );
};

export const utcDayOf = (tsIso: string): string => tsIso.slice(0, 10);

/** Canonical one-line form of a row, for set comparisons/hashes. */
export const canonicalRow = (row: GpsPointRow): string =>
  JSON.stringify([
    row.source,
    row.ts,
    row.lat,
    row.lon,
    row.speed,
    row.alt,
    row.acc,
    row.batt,
    row.raw,
  ]);

export const canonicalStay = (stay: StayRow): string =>
  JSON.stringify([
    stay.first_point_ts,
    stay.last_point_ts,
    stay.lat,
    stay.lon,
    stay.radius_m,
    stay.point_count,
    stay.observed_duration_s,
  ]);

/** Order-independent fingerprint of a row set. */
export const rowSetHash = async (
  lines: ReadonlyArray<string>,
): Promise<string> =>
  sha256Hex(new TextEncoder().encode([...lines].sort().join("\n")));

// ---------------------------------------------------------------------------
// Domain: stay detection — a line-for-line port of Stays.ts's
// RunningMedian / StayDetector / finishStay and Gps.ts's haversine.
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_000;

export const haversineMeters = (
  a: { readonly lat: number; readonly lon: number },
  b: { readonly lat: number; readonly lon: number },
): number => {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
};

const medianOf = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export class RunningMedian {
  private low: Array<number> = [];
  private high: Array<number> = [];

  private static siftUp(
    heap: Array<number>,
    index: number,
    before: (a: number, b: number) => boolean,
  ) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!before(heap[index]!, heap[parent]!)) return;
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
      index = parent;
    }
  }

  private static siftDown(
    heap: Array<number>,
    index: number,
    before: (a: number, b: number) => boolean,
  ) {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      if (left < heap.length && before(heap[left]!, heap[best]!)) best = left;
      if (right < heap.length && before(heap[right]!, heap[best]!)) {
        best = right;
      }
      if (best === index) return;
      [heap[index], heap[best]] = [heap[best]!, heap[index]!];
      index = best;
    }
  }

  private static push(
    heap: Array<number>,
    value: number,
    before: (a: number, b: number) => boolean,
  ) {
    heap.push(value);
    RunningMedian.siftUp(heap, heap.length - 1, before);
  }

  private static pop(
    heap: Array<number>,
    before: (a: number, b: number) => boolean,
  ): number {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      RunningMedian.siftDown(heap, 0, before);
    }
    return top;
  }

  add(value: number) {
    const beforeLow = (a: number, b: number) => a > b;
    const beforeHigh = (a: number, b: number) => a < b;
    if (this.low.length === 0 || value <= this.low[0]!) {
      RunningMedian.push(this.low, value, beforeLow);
    } else {
      RunningMedian.push(this.high, value, beforeHigh);
    }
    if (this.low.length > this.high.length + 1) {
      RunningMedian.push(
        this.high,
        RunningMedian.pop(this.low, beforeLow),
        beforeHigh,
      );
    } else if (this.high.length > this.low.length) {
      RunningMedian.push(
        this.low,
        RunningMedian.pop(this.high, beforeHigh),
        beforeLow,
      );
    }
  }

  median(): number {
    if (this.low.length === 0) return Number.NaN;
    return this.low.length > this.high.length
      ? this.low[0]!
      : (this.low[0]! + this.high[0]!) / 2;
  }

  get size() {
    return this.low.length + this.high.length;
  }
}

const percentile90 = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1] ?? 0;
};

interface StayPoint {
  readonly ts: string;
  readonly lat: number;
  readonly lon: number;
}

const finishStay = (members: ReadonlyArray<StayPoint>): StayRow => {
  const center = {
    lat: medianOf(members.map((point) => point.lat)),
    lon: medianOf(members.map((point) => point.lon)),
  };
  const first = members[0]!;
  const last = members.at(-1)!;
  return {
    first_point_ts: first.ts,
    last_point_ts: last.ts,
    lat: center.lat,
    lon: center.lon,
    radius_m:
      members.length === 1
        ? 0
        : percentile90(
            members.map((point) => haversineMeters(center, point)),
          ),
    point_count: members.length,
    observed_duration_s: Math.max(
      0,
      Math.round((Date.parse(last.ts) - Date.parse(first.ts)) / 1000),
    ),
  };
};

export class StayDetector {
  private members: Array<StayPoint> = [];
  private latMedian = new RunningMedian();
  private lonMedian = new RunningMedian();
  private readonly radiusM: number;

  constructor(radiusM = STAY_RADIUS_M) {
    this.radiusM = radiusM;
  }

  add(point: StayPoint): StayRow | null {
    let finished: StayRow | null = null;
    if (this.members.length > 0) {
      const center = {
        lat: this.latMedian.median(),
        lon: this.lonMedian.median(),
      };
      if (haversineMeters(center, point) > this.radiusM) {
        finished = finishStay(this.members);
        this.members = [];
        this.latMedian = new RunningMedian();
        this.lonMedian = new RunningMedian();
      }
    }
    this.members.push(point);
    this.latMedian.add(point.lat);
    this.lonMedian.add(point.lon);
    return finished;
  }

  finish(): Array<StayRow> {
    if (this.members.length === 0) return [];
    const stay = finishStay(this.members);
    this.members = [];
    this.latMedian = new RunningMedian();
    this.lonMedian = new RunningMedian();
    return [stay];
  }
}

/**
 * The server's materializeStays feeding order, reproduced: one
 * day partition at a time in ascending day order; within a
 * partition, rows de-duplicated on (source, ts, lat, lon) and
 * ordered by ts, source, lat, lon; the open cluster carries
 * across midnight; a stay belongs to its first point's day.
 * Input: partitions in ascending day order, rows as decoded.
 */
export const computeStays = (
  partitionsInDayOrder: ReadonlyArray<ReadonlyArray<GpsPointRow>>,
  radiusM = STAY_RADIUS_M,
): Array<StayRow> => {
  const detector = new StayDetector(radiusM);
  const stays: Array<StayRow> = [];
  for (const rows of partitionsInDayOrder) {
    const deduped = new Map<string, GpsPointRow>();
    for (const row of rows) {
      const key = rowKey(row);
      if (!deduped.has(key)) deduped.set(key, row);
    }
    const ordered = [...deduped.values()].sort(
      (a, b) =>
        Date.parse(a.ts) - Date.parse(b.ts) ||
        a.source.localeCompare(b.source) ||
        a.lat - b.lat ||
        a.lon - b.lon,
    );
    for (const row of ordered) {
      const finished = detector.add({ ts: row.ts, lat: row.lat, lon: row.lon });
      if (finished !== null) stays.push(finished);
    }
  }
  stays.push(...detector.finish());
  return stays;
};

/**
 * The server's stays basis input, byte for byte: sha256 of the
 * newline-joined ["stays-v1", radius, "relative\thash", …] over
 * every points partition in ascending order. The hashes are the
 * partitions' content sha256 (the server's FileHashes manifest
 * hashes the same bytes).
 */
export const staysBasisText = (
  partitions: ReadonlyArray<{ readonly relative: string; readonly hash: string }>,
  radiusM = STAY_RADIUS_M,
): string =>
  [
    STAYS_VERSION,
    String(radiusM),
    ...partitions.map(({ relative, hash }) => `${relative}\t${hash}`),
  ].join("\n");

// ---------------------------------------------------------------------------
// Domain: the Parquet codec. Server partitions are DuckDB-written
// (ZSTD; ts TIMESTAMP_MICROS; alt/acc/batt occasionally JSON-typed
// strings from per-batch inference drift). Decoding normalizes
// every value into the row shape; encoding writes the canonical
// schema (STRING / TIMESTAMP millis / DOUBLE / INT32 / INT64,
// SNAPPY) — readers on both sides accept either.
// ---------------------------------------------------------------------------

const asyncBufferOf = (bytes: Uint8Array) => {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return {
    byteLength: ab.byteLength,
    slice: async (start: number, end?: number) => ab.slice(start, end),
  };
};

const decodeTimestamp = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") {
    return new Date(Number(value / 1000n)).toISOString();
  }
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return new Date(Date.parse(value)).toISOString();
  throw new Error(`unrecognized timestamp value: ${String(value)}`);
};

const decodeText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
};

export const decodePointsParquet = async (
  bytes: Uint8Array,
): Promise<Array<GpsPointRow>> => {
  const rows = (await parquetReadObjects({
    file: asyncBufferOf(bytes) as never,
    compressors,
  })) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    source: decodeText(row["source"]) ?? "",
    ts: decodeTimestamp(row["ts"]),
    lat: nullableNumber(row["lat"]) ?? Number.NaN,
    lon: nullableNumber(row["lon"]) ?? Number.NaN,
    speed: nullableNumber(row["speed"]),
    alt: nullableNumber(row["alt"]),
    acc: nullableNumber(row["acc"]),
    batt: nullableNumber(row["batt"]),
    raw: decodeText(row["raw"]),
  }));
};

export const encodePointsParquet = (rows: ReadonlyArray<GpsPointRow>): Uint8Array => {
  const buffer = parquetWriteBuffer({
    columnData: [
      { name: "source", data: rows.map((row) => row.source), type: "STRING" },
      {
        name: "ts",
        data: rows.map((row) => new Date(Date.parse(row.ts))),
        type: "TIMESTAMP",
      },
      { name: "lat", data: rows.map((row) => row.lat), type: "DOUBLE" },
      { name: "lon", data: rows.map((row) => row.lon), type: "DOUBLE" },
      { name: "speed", data: rows.map((row) => row.speed), type: "DOUBLE" },
      { name: "alt", data: rows.map((row) => row.alt), type: "DOUBLE" },
      { name: "acc", data: rows.map((row) => row.acc), type: "DOUBLE" },
      { name: "batt", data: rows.map((row) => row.batt), type: "DOUBLE" },
      { name: "raw", data: rows.map((row) => row.raw), type: "STRING" },
    ],
    codec: "SNAPPY",
  });
  return new Uint8Array(buffer as unknown as ArrayBuffer);
};

export const decodeStaysParquet = async (
  bytes: Uint8Array,
): Promise<Array<StayRow>> => {
  const rows = (await parquetReadObjects({
    file: asyncBufferOf(bytes) as never,
    compressors,
  })) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    first_point_ts: decodeTimestamp(row["first_point_ts"]),
    last_point_ts: decodeTimestamp(row["last_point_ts"]),
    lat: nullableNumber(row["lat"]) ?? Number.NaN,
    lon: nullableNumber(row["lon"]) ?? Number.NaN,
    radius_m: nullableNumber(row["radius_m"]) ?? 0,
    point_count: Number(row["point_count"] ?? 0),
    observed_duration_s: Number(row["observed_duration_s"] ?? 0),
  }));
};

export const encodeStaysParquet = (stays: ReadonlyArray<StayRow>): Uint8Array => {
  const buffer = parquetWriteBuffer({
    columnData: [
      {
        name: "first_point_ts",
        data: stays.map((stay) => new Date(Date.parse(stay.first_point_ts))),
        type: "TIMESTAMP",
      },
      {
        name: "last_point_ts",
        data: stays.map((stay) => new Date(Date.parse(stay.last_point_ts))),
        type: "TIMESTAMP",
      },
      { name: "lat", data: stays.map((stay) => stay.lat), type: "DOUBLE" },
      { name: "lon", data: stays.map((stay) => stay.lon), type: "DOUBLE" },
      { name: "radius_m", data: stays.map((stay) => stay.radius_m), type: "DOUBLE" },
      { name: "point_count", data: stays.map((stay) => stay.point_count), type: "INT32" },
      {
        name: "observed_duration_s",
        data: stays.map((stay) => BigInt(stay.observed_duration_s)),
        type: "INT64",
      },
    ],
    codec: "SNAPPY",
  });
  return new Uint8Array(buffer as unknown as ArrayBuffer);
};

// ---------------------------------------------------------------------------
// Reports and shadow expectations
// ---------------------------------------------------------------------------

/**
 * One recorded shadow expectation: once the server consumes this
 * exact inbox batch, the day's partition must hold exactly this
 * row set (compared by hash of the canonical rows).
 */
export interface GpsExpectation {
  readonly day: string;
  readonly rowCount: number;
  readonly setHash: string;
  readonly batchKeys: ReadonlyArray<string>;
  readonly recordedAt: string;
}

export class GpsReport extends Schema.Class<GpsReport>("GpsReport")({
  ranAt: Schema.String,
  mode: Schema.Literals(["cron", "manual"]),
  live: Schema.Boolean,
  /** Inbox files present at pass start. */
  inboxFiles: Schema.Number,
  /** Inbox files in the batch this pass worked (live) or
   * recorded expectations from (shadow). */
  batchFiles: Schema.Number,
  daysTouched: Schema.Number,
  expectationsSettled: Schema.Number,
  expectationsMatched: Schema.Number,
  expectationsPending: Schema.Number,
  expectationsMismatched: Schema.Number,
  /** "match" | "differ" | "absent": the stored stays basis
   * against the basis computed over current partitions. */
  staysBasisState: Schema.String,
  staysDaysCompared: Schema.Number,
  staysDaysMatched: Schema.Number,
  staysDaysMismatched: Schema.Number,
  performedFiles: Schema.Number,
  performedPartitions: Schema.Number,
  performedStaysDays: Schema.Number,
  mismatches: Schema.Array(
    Schema.Struct({
      day: Schema.String,
      kind: Schema.String,
      detail: Schema.String,
    }),
  ),
  errors: Schema.Array(
    Schema.Struct({ item: Schema.String, detail: Schema.String }),
  ),
}) {}

export interface GpsPassOptions {
  readonly mode: "cron" | "manual";
  readonly now: Date;
  /** Inbox files worked per pass (the server's sub-batch bound). */
  readonly limit: number;
  /** An expectation whose batch is still unconsumed after this
   * long is still just pending (server passes run long). */
  readonly staleAfterMs: number;
  /** Live runs only: perform instead of only checking. */
  readonly perform: boolean;
}

// ---------------------------------------------------------------------------
// Platform: typed errors
// ---------------------------------------------------------------------------

export class GpsDataError extends Data.TaggedError("GpsDataError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

type GpsError =
  | GpsDataError
  | CatalogError
  | ArtifactReadError
  | IndexRequestError
  | NotebookError;

// ---------------------------------------------------------------------------
// Platform: services
// ---------------------------------------------------------------------------

export interface GpsDataShape {
    /** Every inbox file key, ascending. */
    readonly inboxKeys: Effect.Effect<ReadonlyArray<string>, CatalogError>;
    /** One artifact's text; null when absent. */
    readonly readText: (
      key: string,
    ) => Effect.Effect<string | null, ArtifactReadError>;
    /** One artifact's bytes; null when absent. */
    readonly readBytes: (
      key: string,
    ) => Effect.Effect<Uint8Array | null, GpsDataError>;
    /** Write bytes through the ledger (bucket, then register). */
    readonly writeBytes: (
      key: string,
      bytes: Uint8Array,
    ) => Effect.Effect<void, ArtifactReadError | IndexRequestError>;
    readonly writeText: (
      key: string,
      text: string,
    ) => Effect.Effect<void, ArtifactReadError | IndexRequestError>;
    /** Delete + unregister through the ledger. */
    readonly removeKey: (
      key: string,
    ) => Effect.Effect<void, ArtifactReadError | IndexRequestError>;
    /** Points partition days present, ascending, with keys. */
    readonly partitionDays: Effect.Effect<
      ReadonlyArray<{ readonly day: string; readonly key: string }>,
      CatalogError
    >;
    /** Stays partition days present, ascending, with keys. */
    readonly staysDays: Effect.Effect<
      ReadonlyArray<{ readonly day: string; readonly key: string }>,
      CatalogError
    >;
}

export class GpsData extends Context.Service<GpsData, GpsDataShape>()(
  "medina-cloudflare/GpsData",
) {}

export class GpsNotebook extends Context.Service<
  GpsNotebook,
  {
    readonly record: (
      report: GpsReport,
    ) => Effect.Effect<void, NotebookError>;
    readonly latest: Effect.Effect<
      Option.Option<GpsReport>,
      NotebookError
    >;
    readonly expectations: Effect.Effect<
      ReadonlyArray<GpsExpectation>,
      NotebookError
    >;
    readonly setExpectations: (
      expectations: ReadonlyArray<GpsExpectation>,
    ) => Effect.Effect<void, NotebookError>;
  }
>()("medina-cloudflare/GpsNotebook") {}

export interface GpsEnv {
  readonly artifacts: CatalogBucketLike & {
    get(
      key: string,
    ): Promise<{
      readonly body: ReadableStream;
      arrayBuffer(): Promise<ArrayBuffer>;
    } | null>;
  };
  readonly notebook: DurableObjectNamespaceLike;
}

export const GPS_SHADOW_DO_NAME = "gps-shadow-v1";

export const gpsPlatformLayer = (
  env: GpsEnv,
): Layer.Layer<
  GpsData | GpsNotebook,
  never,
  ArtifactLedger | ArtifactCatalog
> =>
  Layer.effect(
    GpsData,
    Effect.gen(function* () {
      const ledger = yield* ArtifactLedger;
      const catalog = yield* ArtifactCatalog;
      const daysOf = (
        prefix: string,
        pattern: RegExp,
      ): Effect.Effect<
        ReadonlyArray<{ day: string; key: string }>,
        CatalogError
      > =>
        Effect.map(catalog.listAll(prefix), (objects) =>
          objects
            .map((object) => {
              const match = pattern.exec(
                object.key.slice(prefix.length + 1),
              );
              return match
                ? { day: match[1]!, key: object.key }
                : null;
            })
            .filter(
              (entry): entry is { day: string; key: string } =>
                entry !== null,
            )
            .sort((a, b) => a.day.localeCompare(b.day)),
        );
      return {
        inboxKeys: Effect.map(
          catalog.listAll(INBOX_PREFIX),
          (objects) =>
            objects
              .map((object) => object.key)
              .filter((key) => key.endsWith(".ndjson"))
              .sort(),
        ),
        readText: (key) =>
          Effect.map(ledger.readText(key), (text) =>
            Option.isSome(text) ? text.value : null,
          ),
        readBytes: (key) =>
          Effect.tryPromise({
            try: async () => {
              const object = await env.artifacts.get(key);
              if (object === null) return null;
              return new Uint8Array(await object.arrayBuffer());
            },
            catch: (cause) =>
              new GpsDataError({
                message: `reading ${key} failed`,
                cause,
              }),
          }),
        writeBytes: (key, bytes) => ledger.writeBlob(key, bytes),
        writeText: (key, text) => ledger.writeText(key, text),
        removeKey: (key) => ledger.remove(key),
        partitionDays: daysOf(POINTS_PREFIX, DAY_PARTITION),
        staysDays: daysOf(STAYS_PREFIX, STAY_PARTITION),
      };
    }),
  ).pipe(
    Layer.merge(
      Layer.succeed(GpsNotebook, {
        record: (report) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(GPS_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://gps-shadow/report", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(report),
                }),
              );
              if (!response.ok) {
                throw new Error(
                  `notebook rejected a report: ${response.status}`,
                );
              }
            },
            catch: (cause) =>
              new NotebookError({
                message: "recording a gps report failed",
                cause,
              }),
          }),
        latest: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(GPS_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://gps-shadow/status"),
            );
            if (!response.ok) {
              throw new Error(`notebook status answered ${response.status}`);
            }
            const body = (await response.json()) as {
              lastReport?: GpsReport | null;
            };
            return body.lastReport != null
              ? Option.some(body.lastReport)
              : Option.none<GpsReport>();
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading the gps notebook failed",
              cause,
            }),
        }),
        expectations: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(GPS_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://gps-shadow/expectations"),
            );
            if (!response.ok) {
              throw new Error(
                `notebook expectations answered ${response.status}`,
              );
            }
            const body = (await response.json()) as {
              expectations?: ReadonlyArray<GpsExpectation>;
            };
            return body.expectations ?? [];
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading gps expectations failed",
              cause,
            }),
        }),
        setExpectations: (expectations) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(GPS_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://gps-shadow/expectations", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ expectations }),
                }),
              );
              if (!response.ok) {
                throw new Error(
                  `notebook expectations write answered ${response.status}`,
                );
              }
            },
            catch: (cause) =>
              new NotebookError({
                message: "writing gps expectations failed",
                cause,
              }),
          }),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

const MAX_STORED_FINDINGS = 100;

interface Finding {
  readonly day: string;
  readonly kind: string;
  readonly detail: string;
}

interface ItemError {
  readonly item: string;
  readonly detail: string;
}

/** Read every points partition once: bytes hash + decoded rows. */
const readPartitions = (
  data: Pick<GpsDataShape, "partitionDays" | "readBytes">,
): Effect.Effect<
  Array<{
    readonly day: string;
    readonly key: string;
    readonly hash: string;
    readonly rows: Array<GpsPointRow>;
  }>,
  GpsError
> =>
  Effect.gen(function* () {
    const days = yield* data.partitionDays;
    const partitions = [];
    for (const { day, key } of days) {
      const bytes = yield* data.readBytes(key);
      if (bytes === null) continue;
      partitions.push({
        day,
        key,
        hash: yield* Effect.promise(() => sha256Hex(bytes)),
        rows: yield* Effect.promise(() => decodePointsParquet(bytes)),
      });
    }
    return partitions;
  });

/** The basis over the given partitions, in the server's form. */
const basisOf = (
  partitions: ReadonlyArray<{ readonly day: string; readonly hash: string }>,
): Effect.Effect<string> =>
  Effect.promise(() =>
    sha256Hex(
      new TextEncoder().encode(
        staysBasisText(
          partitions.map(({ day, hash }) => ({
            relative: `day=${day}/points.parquet`,
            hash,
          })),
        ),
      ),
    ),
  );

const parseBasis = (text: string | null): StaysBasisShape | null => {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (typeof parsed["basisHash"] !== "string") return null;
    return {
      version: String(parsed["version"] ?? ""),
      basisHash: parsed["basisHash"],
      computedAt: String(parsed["computedAt"] ?? ""),
      days: Number(parsed["days"] ?? 0),
      stays: Number(parsed["stays"] ?? 0),
    };
  } catch {
    return null;
  }
};

export const runGpsPass = (
  options: GpsPassOptions,
): Effect.Effect<
  GpsReport,
  GpsError,
  ArtifactLedger | ArtifactCatalog | GpsData | GpsNotebook
> =>
  Effect.gen(function* () {
    const data = yield* GpsData;
    const notebook = yield* GpsNotebook;
    const nowIso = options.now.toISOString();
    const mismatches: Array<Finding> = [];
    const errors: Array<ItemError> = [];

    const inbox = yield* data.inboxKeys;
    const inboxSet = new Set(inbox);

    // -- settle recorded expectations (shadow bookkeeping; in live
    // mode these are the Worker's own earlier expectations settling
    // against its own partitions — a self-check).
    let settled = 0;
    let expectationsMatched = 0;
    let expectationsPending = 0;
    let expectationsMismatched = 0;
    const recorded = yield* notebook.expectations;
    const remaining: Array<GpsExpectation> = [];
    for (const expectation of recorded) {
      const consumed = expectation.batchKeys.every(
        (key) => !inboxSet.has(key),
      );
      if (!consumed) {
        expectationsPending++;
        remaining.push(expectation);
        continue;
      }
      settled++;
      const bytes = yield* data.readBytes(gpsPartitionKey(expectation.day));
      if (bytes === null) {
        expectationsMismatched++;
        if (mismatches.length < MAX_STORED_FINDINGS) {
          mismatches.push({
            day: expectation.day,
            kind: "partition-missing",
            detail: `batch consumed but no partition exists (expected ${expectation.rowCount} rows)`,
          });
        }
        continue;
      }
      const rows = yield* Effect.promise(() => decodePointsParquet(bytes));
      const hash = yield* Effect.promise(() =>
        rowSetHash(rows.map(canonicalRow)),
      );
      if (hash === expectation.setHash && rows.length === expectation.rowCount) {
        expectationsMatched++;
      } else {
        expectationsMismatched++;
        if (mismatches.length < MAX_STORED_FINDINGS) {
          mismatches.push({
            day: expectation.day,
            kind: "row-set",
            detail: `expected ${expectation.rowCount} rows (set ${expectation.setHash.slice(0, 12)}…), partition holds ${rows.length} (set ${hash.slice(0, 12)}…)`,
          });
        }
      }
    }

    let batchFiles = 0;
    let daysTouched = 0;
    let performedFiles = 0;
    let performedPartitions = 0;
    let performedStaysDays = 0;
    let staysBasisState = "absent";
    let staysDaysCompared = 0;
    let staysDaysMatched = 0;
    let staysDaysMismatched = 0;

    if (options.perform) {
      // -- live: one bounded batch, partitions first, deletes last.
      const batch = inbox.slice(0, options.limit);
      batchFiles = batch.length;
      if (batch.length > 0) {
        const byDay = new Map<string, Array<GpsPointRow>>();
        let parseFailure: string | null = null;
        for (const key of batch) {
          const text = yield* data.readText(key);
          if (text === null) {
            parseFailure = `${key}: inbox file vanished before read`;
            break;
          }
          try {
            for (const row of parseInboxText(text)) {
              const day = utcDayOf(row.ts);
              const list = byDay.get(day) ?? [];
              list.push(row);
              byDay.set(day, list);
            }
          } catch (cause) {
            parseFailure = `${key}: ${String(cause).slice(0, 200)}`;
            break;
          }
        }
        if (parseFailure !== null) {
          errors.push({ item: "gps-compact", detail: parseFailure });
        } else {
          daysTouched = byDay.size;
          for (const day of [...byDay.keys()].sort()) {
            const existingBytes = yield* data.readBytes(gpsPartitionKey(day));
            const existing =
              existingBytes === null
                ? []
                : yield* Effect.promise(() =>
                    decodePointsParquet(existingBytes),
                  );
            const merged = mergeRows([...byDay.get(day)!, ...existing]);
            yield* data.writeBytes(
              gpsPartitionKey(day),
              encodePointsParquet(merged),
            );
            performedPartitions++;
          }
          for (const key of batch) yield* data.removeKey(key);
          performedFiles = batch.length;
        }
      }
      // -- live stays: recompute when the basis moved.
      const partitions = yield* readPartitions(data);
      const basis = yield* basisOf(partitions);
      const storedBasis = parseBasis(yield* data.readText(STAYS_BASIS_KEY));
      staysBasisState =
        storedBasis === null
          ? "absent"
          : storedBasis.basisHash === basis
            ? "match"
            : "differ";
      if (storedBasis?.basisHash !== basis) {
        const stays = computeStays(partitions.map((p) => p.rows));
        const byDay = new Map<string, Array<StayRow>>();
        for (const stay of stays) {
          const day = stay.first_point_ts.slice(0, 10);
          const list = byDay.get(day) ?? [];
          list.push(stay);
          byDay.set(day, list);
        }
        for (const day of [...byDay.keys()].sort()) {
          yield* data.writeBytes(
            staysPartitionKey(day),
            encodeStaysParquet(byDay.get(day)!),
          );
          performedStaysDays++;
        }
        yield* data.writeText(
          STAYS_BASIS_KEY,
          JSON.stringify(
            {
              version: STAYS_VERSION,
              basisHash: basis,
              computedAt: nowIso,
              days: byDay.size,
              stays: stays.length,
            },
            null,
            2,
          ),
        );
      }
    } else {
      // -- shadow stays check: comparable only when the stored
      // basis covers exactly the current partitions.
      const partitions = yield* readPartitions(data);
      const basis = yield* basisOf(partitions);
      const storedBasis = parseBasis(yield* data.readText(STAYS_BASIS_KEY));
      if (storedBasis === null) {
        staysBasisState = "absent";
      } else if (storedBasis.basisHash !== basis) {
        staysBasisState = "differ";
      } else {
        staysBasisState = "match";
        const computed = computeStays(partitions.map((p) => p.rows));
        const computedByDay = new Map<string, Array<string>>();
        for (const stay of computed) {
          const day = stay.first_point_ts.slice(0, 10);
          const list = computedByDay.get(day) ?? [];
          list.push(canonicalStay(stay));
          computedByDay.set(day, list);
        }
        const storedDays = yield* data.staysDays;
        const allDays = new Set([
          ...computedByDay.keys(),
          ...storedDays.map(({ day }) => day),
        ]);
        for (const day of [...allDays].sort()) {
          staysDaysCompared++;
          const storedBytes = yield* data.readBytes(staysPartitionKey(day));
          const storedLines =
            storedBytes === null
              ? []
              : (yield* Effect.promise(() => decodeStaysParquet(storedBytes))).map(
                  canonicalStay,
                );
          const computedLines = computedByDay.get(day) ?? [];
          const same =
            storedLines.length === computedLines.length &&
            (yield* Effect.promise(() =>
              rowSetHash(storedLines),
            )) ===
              (yield* Effect.promise(() => rowSetHash(computedLines)));
          if (same) {
            staysDaysMatched++;
          } else {
            staysDaysMismatched++;
            if (mismatches.length < MAX_STORED_FINDINGS) {
              mismatches.push({
                day,
                kind: "stays",
                detail: `stored ${storedLines.length} stays vs computed ${computedLines.length} under the same basis`,
              });
            }
          }
        }
      }
      // -- shadow compaction expectations: record what the server
      // must produce from the current inbox, when it fits the
      // bound. A larger inbox is the drain backlog — expectations
      // recorded then would settle against sub-batch boundaries
      // this port cannot see; the report carries the count.
      if (inbox.length > 0 && inbox.length <= options.limit) {
        batchFiles = inbox.length;
        const byDay = new Map<string, Array<GpsPointRow>>();
        let parseFailure: string | null = null;
        for (const key of inbox) {
          const text = yield* data.readText(key);
          if (text === null) continue;
          try {
            for (const row of parseInboxText(text)) {
              const day = utcDayOf(row.ts);
              const list = byDay.get(day) ?? [];
              list.push(row);
              byDay.set(day, list);
            }
          } catch (cause) {
            parseFailure = `${key}: ${String(cause).slice(0, 200)}`;
            break;
          }
        }
        if (parseFailure !== null) {
          errors.push({ item: "gps-compact", detail: parseFailure });
        } else {
          daysTouched = byDay.size;
          const fresh: Array<GpsExpectation> = [];
          for (const day of [...byDay.keys()].sort()) {
            const existingBytes = yield* data.readBytes(gpsPartitionKey(day));
            const existing =
              existingBytes === null
                ? []
                : yield* Effect.promise(() =>
                    decodePointsParquet(existingBytes),
                  );
            const expected = mergeRows([...byDay.get(day)!, ...existing]);
            fresh.push({
              day,
              rowCount: expected.length,
              setHash: yield* Effect.promise(() =>
                rowSetHash(expected.map(canonicalRow)),
              ),
              batchKeys: inbox,
              recordedAt: nowIso,
            });
          }
          const freshDays = new Set(fresh.map((entry) => entry.day));
          for (let i = remaining.length - 1; i >= 0; i--) {
            if (freshDays.has(remaining[i]!.day)) remaining.splice(i, 1);
          }
          remaining.push(...fresh);
        }
      }
      yield* notebook.setExpectations(remaining);
    }

    const report = new GpsReport({
      ranAt: nowIso,
      mode: options.mode,
      live: options.perform,
      inboxFiles: inbox.length,
      batchFiles,
      daysTouched,
      expectationsSettled: settled,
      expectationsMatched,
      expectationsPending,
      expectationsMismatched,
      staysBasisState,
      staysDaysCompared,
      staysDaysMatched,
      staysDaysMismatched,
      performedFiles,
      performedPartitions,
      performedStaysDays,
      mismatches,
      errors,
    });
    yield* notebook.record(report);
    return report;
  });

// ---------------------------------------------------------------------------
// GpsShadow: the stages' notebook Durable Object — recent pass
// reports plus the recorded shadow expectations, in its own
// SQLite storage.
// ---------------------------------------------------------------------------

interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>;
}

interface SqlStorageLike {
  exec(
    query: string,
    ...bindings: Array<unknown>
  ): SqlCursorLike;
}

interface DurableObjectStateLike {
  readonly storage: { readonly sql: SqlStorageLike };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export class GpsShadow {
  private readonly sql: SqlStorageLike;

  constructor(state: DurableObjectStateLike) {
    this.sql = state.storage.sql;
    void state.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS reports (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ran_at TEXT NOT NULL,
           report TEXT NOT NULL
         )`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (
           k TEXT PRIMARY KEY,
           v TEXT NOT NULL
         )`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/report") {
      const body = await request.text();
      let ranAt = new Date().toISOString();
      try {
        const parsed = JSON.parse(body) as { ranAt?: unknown };
        if (typeof parsed.ranAt === "string") ranAt = parsed.ranAt;
      } catch {
        // keep the default; the body is still stored verbatim
      }
      this.sql.exec(
        `INSERT INTO reports (ran_at, report) VALUES (?, ?)`,
        ranAt,
        body,
      );
      this.sql.exec(
        `DELETE FROM reports WHERE id NOT IN (
           SELECT id FROM reports ORDER BY id DESC LIMIT 100
         )`,
      );
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const rows = this.sql
        .exec(`SELECT report FROM reports ORDER BY id DESC LIMIT 1`)
        .toArray();
      const countRows = this.sql
        .exec(`SELECT COUNT(*) AS n FROM reports`)
        .toArray();
      const lastReport =
        rows.length > 0 && typeof rows[0]?.["report"] === "string"
          ? (JSON.parse(rows[0]["report"] as string) as unknown)
          : null;
      return new Response(
        JSON.stringify({
          runCount: Number(countRows[0]?.["n"] ?? 0),
          lastReport,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (request.method === "GET" && url.pathname === "/expectations") {
      const rows = this.sql
        .exec(`SELECT v FROM meta WHERE k = 'expectations'`)
        .toArray();
      let expectations: unknown = [];
      if (rows.length > 0 && typeof rows[0]?.["v"] === "string") {
        try {
          expectations = JSON.parse(rows[0]["v"] as string) as unknown;
        } catch {
          expectations = [];
        }
      }
      return new Response(JSON.stringify({ expectations }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (request.method === "POST" && url.pathname === "/expectations") {
      const body = (await request.json().catch(() => ({}))) as {
        expectations?: unknown;
      };
      const expectations = Array.isArray(body.expectations)
        ? body.expectations
        : [];
      this.sql.exec(
        `INSERT INTO meta (k, v) VALUES ('expectations', ?)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        JSON.stringify(expectations),
      );
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
}
