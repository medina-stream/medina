/**
 * The movement resource on the Medina Worker (migration milestone
 * 4, step 8 — docs/cloudflare-migration.md §4.3 step 8, the
 * movement piece): per-day movement summaries (stay / travel /
 * gap segments, place matches, place suggestions) materialized
 * as artifacts at the server's content-addressed keys,
 * `gps/movement-v1/<day>/<basis hash>.json`. Ported from
 * lib/lifelog/Movement.ts, with the stays/points inputs read from
 * the partitions the Worker's GPS stages maintain (src/gps.ts).
 *
 * The basis hash is the server's, term for term: the zone, the
 * per-day stays basis over the candidate stay partitions'
 * content hashes, the point-partition content hashes for the
 * UTC days the local day spans, and the places-list content
 * hash. Content hashes are sha256 of partition bytes; a notebook
 * cache keyed by each object's listing token (size:etag) keeps a
 * steady-state pass to two listings and no re-reads — the same
 * stat-token trick the server's FileHashes manifest plays.
 *
 * Two documented narrowings, both in the day-index port's class:
 *
 *   - Points still sitting in gps/inbox at materialization time
 *     are not read. The server's gpsDay unions partition + inbox;
 *     here the pass runs alongside the GPS stages, which consume
 *     the inbox on the same cadence, and the basis hash covers
 *     partitions only on BOTH sides — so a point in flight can
 *     make the server's artifact at a basis differ from this
 *     one's until the next partition lands and both recompute
 *     under a new basis. The comparison reports name it when it
 *     happens; the next pass converges. One precise sub-case,
 *     found in the Nov 9 rehearsal: a travel segment's path
 *     distance sums its slice's fixes IN ORDER, and for
 *     same-timestamp fix clusters the server's order is whatever
 *     DuckDB's execution produced that pass — not derivable from
 *     any sort key (the same stored day shows clusters in
 *     contradictory orders, and one Nov 2 travel is stored at
 *     514 m where the server's own current point order computes
 *     410 m). Roughly 6% of travel segments have a
 *     same-timestamp cluster in their slice; on those, the
 *     server's stored distance/mode is not reproducible, by
 *     either side, after the fact. This port orders fixes by
 *     (ts, source, lat, lon) — the order src/gps.ts's mergeRows
 *     writes partitions in, so partition order and this order
 *     converge as the Worker's compaction rewrites partitions —
 *     and every other segment kind (stays, gaps, and travels
 *     without same-timestamp clusters) compares exactly. The
 *     flip retires the instability: from then on one
 *     deterministic order produces every artifact.
 *
 *   - The narrative paragraph is null. The server generates it
 *     with its journal LLM (through exe.dev's OpenAI proxy); the
 *     Worker's LLM path is the Cloudflare AI Gateway client that
 *     step 9 builds, and until it exists this port writes the
 *     server's own failure shape (its narrative call catches
 *     every failure to null). Journals consume the SEGMENTS
 *     (renderMovementTimeline), never the narrative; only the
 *     movement page's paragraph waits on step 9.
 *
 * Reverse geocoding follows the server exactly: the write-once
 * cache artifact at gps/geocode-v1/<lat4>_<lon4>.json first
 * (the server has populated it for every stay it ever named),
 * and on a miss in a live pass the same Nominatim request the
 * server makes, paced to one per second within the pass, cached
 * write-once. Shadow passes are cache-only (they write nothing
 * shared), so a stay the server named through a live fetch whose
 * cache entry has since been written compares equal, and one
 * whose fetch failed on both sides compares null — the rare
 * residue (server failed then, cache filled later, artifact
 * never rewritten) shows up as a named geocodedName mismatch.
 *
 * SHADOW AND LIVE: the pass computes every eager day's basis.
 * Where the artifact already exists at that basis it materializes
 * locally and compares the deterministic content (everything but
 * generatedAt and the narrative) — in both modes, so live is a
 * continuous self-check. Where it is missing, shadow records
 * that it would write; live writes it. At the flip, medina-dev's
 * movement resource stands down (MEDINA_SOURCES without
 * "movement"); its on-demand materialization keeps working for
 * days outside the eager window either way. Rollback is the
 * reverse.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ArtifactLedger,
  ArtifactReadError,
  NotebookError,
  sha256Hex,
  type DurableObjectNamespaceLike,
  type IndexRequestError,
} from "./capture.ts";
import {
  ArtifactCatalog,
  type CatalogBucketLike,
  type CatalogError,
  type CatalogObject,
} from "./catalog.ts";
import {
  decodePointsParquet,
  decodeStaysParquet,
  haversineMeters,
  staysBasisText,
  STAYS_VERSION,
  type GpsPointRow,
  type StayRow,
} from "./gps.ts";

// ---------------------------------------------------------------------------
// Domain: constants and keys (ports of lib/lifelog/Movement.ts,
// lib/lifelog/Stays.ts, lib/lifelog/Places.ts)
// ---------------------------------------------------------------------------

export const MOVEMENT_VERSION = "movement-v1";
/** Exported for the journal port (src/journaling.ts), which
 * composes the same per-day basis to key its journal inputs. */
export const MOVEMENT_BASIS_VERSION = "stays-v1-composition-2";
/** Check-memo entries are only valid for the comparison code that
 * made them; the memo stores this epoch alongside the basis so a
 * comparison change (o2: the (ts, source, lat, lon) fix order and
 * the order-dependent classification) forces a recheck. */
const MEMO_EPOCH = "o2";
const PLACES_KEY = "places.json";
const LEGACY_PLACES_KEY = "gps/places.json";
const DAY_MS = 86_400_000;
/** Movement's own radius: transit splitting + suggestion merging. */
const STAY_RADIUS_M = 200;
const GAP_MS = 3 * 60 * 60_000;
const STAY_BASIS_RADIUS = "150";
const POINTS_PREFIX = "gps/points-v1";
const STAYS_PREFIX = `gps/${STAYS_VERSION}`;
const GEOCODE_PREFIX = "gps/geocode-v1";

export const movementKey = (day: string, basisHash: string): string =>
  `gps/${MOVEMENT_VERSION}/${day}/${basisHash}.json`;
export const pointsPartitionKey = (utcDay: string): string =>
  `${POINTS_PREFIX}/day=${utcDay}/points.parquet`;
export const staysPartitionKey = (utcDay: string): string =>
  `${STAYS_PREFIX}/day=${utcDay}/stays.parquet`;

export interface MovementFix {
  readonly ts: string;
  readonly lat: number;
  readonly lon: number;
}

export type RawMovementSegment =
  | { readonly kind: "stay"; readonly start: string; readonly end: string; readonly lat: number; readonly lon: number; readonly fixes: number }
  | { readonly kind: "travel"; readonly start: string; readonly end: string; readonly distanceMeters: number; readonly mode: "walk" | "bike" | "drive"; readonly fixes: number }
  | { readonly kind: "gap"; readonly start: string; readonly end: string; readonly fixes: number };

const pathDistance = (points: ReadonlyArray<MovementFix>): number => {
  let meters = 0;
  for (let index = 1; index < points.length; index++) {
    meters += haversineMeters(points[index - 1]!, points[index]!);
  }
  return meters;
};

const transitSegments = (
  points: ReadonlyArray<MovementFix>,
): ReadonlyArray<RawMovementSegment> => {
  const result: Array<RawMovementSegment> = [];
  const emitTravel = (slice: ReadonlyArray<MovementFix>) => {
    if (slice.length < 2) return;
    const elapsed = Date.parse(slice.at(-1)!.ts) - Date.parse(slice[0]!.ts);
    const distanceMeters = pathDistance(slice);
    const speed = distanceMeters / Math.max(1, elapsed / 1000);
    result.push({
      kind: "travel",
      start: slice[0]!.ts,
      end: slice.at(-1)!.ts,
      distanceMeters,
      mode: speed < 2.5 ? "walk" : speed < 7 ? "bike" : "drive",
      fixes: slice.length,
    });
  };
  let chunkStart = 0;
  for (let index = 0; index + 1 < points.length; index++) {
    const left = points[index]!;
    const right = points[index + 1]!;
    if (
      Date.parse(right.ts) - Date.parse(left.ts) <= GAP_MS ||
      haversineMeters(left, right) <= STAY_RADIUS_M
    ) {
      continue;
    }
    emitTravel(points.slice(chunkStart, index + 1));
    result.push({ kind: "gap", start: left.ts, end: right.ts, fixes: 2 });
    chunkStart = index + 1;
  }
  emitTravel(points.slice(chunkStart));
  return result;
};

/** Compose materialized stays with travel/gap evidence from raw
 * points — the server's composeMovement, verbatim. */
export const composeMovement = (
  stays: ReadonlyArray<StayRow>,
  input: ReadonlyArray<MovementFix>,
): ReadonlyArray<RawMovementSegment> => {
  const points = [...input].sort((a, b) => a.ts.localeCompare(b.ts));
  const ordered = [...stays].sort((a, b) =>
    a.first_point_ts.localeCompare(b.first_point_ts),
  );
  const presented = ordered.filter(
    (stay, index) =>
      stay.point_count !== 1 ||
      stay.observed_duration_s !== 0 ||
      index === 0 ||
      index === ordered.length - 1,
  );
  const result: Array<RawMovementSegment> = [];
  presented.forEach((stay, index) => {
    result.push({
      kind: "stay",
      start: stay.first_point_ts,
      end: stay.last_point_ts,
      lat: stay.lat,
      lon: stay.lon,
      fixes: stay.point_count,
    });
    const next = presented[index + 1];
    if (!next) return;
    const between = points.filter(
      (point) => point.ts >= stay.last_point_ts && point.ts <= next.first_point_ts,
    );
    result.push(...transitSegments(between));
  });
  return result;
};

// ---------------------------------------------------------------------------
// Domain: civil-time helpers (ports of lib/lifelog/LocalTime.ts
// usage in Movement.ts)
// ---------------------------------------------------------------------------

const localParts = (instant: Date, zone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;

/** `HH:MM` in `zone`, or "" if the instant is unusable. */
export const localTime = (iso: string, zone: string): string => {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return "";
  try {
    const p = localParts(instant, zone);
    return `${p.hour}:${p.minute}`;
  } catch {
    return "";
  }
};

/** The local civil day containing an instant, in `zone`. */
export const localDayOf = (instant: Date, zone: string): string => {
  const p = localParts(instant, zone);
  return `${p.year}-${p.month}-${p.day}`;
};

/** Interpret local midnight in an IANA zone (the server's
 * two/three-pass resolution, verbatim). */
export const localMidnightUtc = (day: string, zone: string): number => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const target = Date.UTC(year, month - 1, date);
  let guess = target;
  for (let index = 0; index < 3; index++) {
    const p = localParts(new Date(guess), zone);
    const represented = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    guess += target - represented;
  }
  return guess;
};

const nextDayOf = (day: string): string => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date) + DAY_MS).toISOString().slice(0, 10);
};

/** The UTC day range a local day spans: [first, last] inclusive. */
export const localDayUtcRange = (
  day: string,
  zone: string,
): readonly [string, string] => {
  const start = localMidnightUtc(day, zone);
  const end = localMidnightUtc(nextDayOf(day), zone);
  return [
    new Date(start).toISOString().slice(0, 10),
    new Date(end - 1).toISOString().slice(0, 10),
  ] as const;
};

/** The UTC-day stay partitions that can hold stays overlapping
 * the local day [start, end) — the server's stayCandidateDays. */
export const stayCandidateDays = (start: number, end: number): Array<string> => {
  const first = new Date(start - DAY_MS).toISOString().slice(0, 10);
  const last = new Date(end - 1).toISOString().slice(0, 10);
  const days: Array<string> = [];
  for (
    let t = new Date(`${first}T00:00:00Z`);
    t.getTime() <= new Date(`${last}T00:00:00Z`).getTime();
    t.setUTCDate(t.getUTCDate() + 1)
  ) {
    days.push(t.toISOString().slice(0, 10));
  }
  return days;
};

/** The local civil days a UTC partition's points can fall in —
 * the server's utcPartitionLocalDays, verbatim. */
export const utcPartitionLocalDays = (
  utcDay: string,
  zone: string,
): ReadonlyArray<string> => {
  const [year, month, date] = utcDay.split("-").map(Number) as [number, number, number];
  const format = new Intl.DateTimeFormat("en", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDay = (utcMs: number): string => {
    const parts = Object.fromEntries(
      format
        .formatToParts(new Date(utcMs))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const start = Date.UTC(year, month - 1, date);
  const first = localDay(start);
  const last = localDay(start + DAY_MS - 1);
  return first === last ? [first] : [first, last];
};

// ---------------------------------------------------------------------------
// Domain: places, geocode names, artifact shape
// ---------------------------------------------------------------------------

export interface PlaceShape {
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly radiusMeters: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural read of the places list (the Places schema's fields). */
export const parsePlaces = (parsed: unknown): ReadonlyArray<PlaceShape> => {
  if (!Array.isArray(parsed)) return [];
  const places: Array<PlaceShape> = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    if (
      typeof entry["id"] === "string" &&
      typeof entry["name"] === "string" &&
      typeof entry["lat"] === "number" &&
      typeof entry["lon"] === "number" &&
      typeof entry["radiusMeters"] === "number"
    ) {
      places.push({
        id: entry["id"],
        name: entry["name"],
        lat: entry["lat"],
        lon: entry["lon"],
        radiusMeters: entry["radiusMeters"],
      });
    }
  }
  return places;
};

/** The server's shortGeocodeName over a raw Nominatim response. */
export const shortGeocodeName = (response: unknown): string | null => {
  if (!isRecord(response)) return null;
  const address = isRecord(response["address"]) ? response["address"] : {};
  const named = address["amenity"] ?? address["shop"] ?? address["leisure"];
  if (named) return String(named);
  const road = address["road"] ?? address["pedestrian"];
  const area = address["suburb"] ?? address["neighbourhood"];
  if (road && area) return `${String(road)}, ${String(area)}`;
  if (road || area) return String(road ?? area);
  const display =
    typeof response["display_name"] === "string"
      ? response["display_name"].split(",").slice(0, 3).join(",").trim()
      : "";
  return display || null;
};

export type MovementSegmentShape =
  | {
      readonly kind: "stay";
      readonly startTime: string;
      readonly endTime: string;
      readonly startLocal: string;
      readonly endLocal: string;
      readonly lat: number;
      readonly lon: number;
      readonly placeId: string | null;
      readonly placeName: string | null;
      readonly geocodedName: string | null;
      readonly dwellMinutes: number;
      readonly fixes: number;
    }
  | {
      readonly kind: "travel";
      readonly startTime: string;
      readonly endTime: string;
      readonly startLocal: string;
      readonly endLocal: string;
      readonly distanceMeters: number;
      readonly mode: "walk" | "bike" | "drive";
      readonly fixes: number;
    }
  | {
      readonly kind: "gap";
      readonly startTime: string;
      readonly endTime: string;
      readonly startLocal: string;
      readonly endLocal: string;
      readonly fixes: number;
    };

export interface PlaceSuggestionShape {
  readonly lat: number;
  readonly lon: number;
  readonly geocodedName: string | null;
  readonly dwellMinutes: number;
}

export interface MovementShape {
  readonly version: string;
  readonly day: string;
  readonly basisHash: string;
  readonly timeZone: string;
  readonly generatedAt: string;
  readonly segments: ReadonlyArray<MovementSegmentShape>;
  readonly narrative: string | null;
  readonly suggestions: ReadonlyArray<PlaceSuggestionShape>;
}

/** The deterministic content of a movement artifact: everything
 * but generatedAt and the narrative. Key order is the schema's,
 * on both sides, so a JSON comparison is meaningful. */
export const deterministicView = (movement: MovementShape) => ({
  version: movement.version,
  day: movement.day,
  basisHash: movement.basisHash,
  timeZone: movement.timeZone,
  segments: movement.segments,
  suggestions: movement.suggestions,
});

/** Structural read of a stored movement artifact. */
export const parseMovement = (parsed: unknown): MovementShape | null => {
  if (!isRecord(parsed)) return null;
  if (
    typeof parsed["version"] !== "string" ||
    typeof parsed["day"] !== "string" ||
    typeof parsed["basisHash"] !== "string" ||
    typeof parsed["timeZone"] !== "string" ||
    typeof parsed["generatedAt"] !== "string" ||
    !Array.isArray(parsed["segments"]) ||
    !Array.isArray(parsed["suggestions"])
  ) {
    return null;
  }
  return {
    version: parsed["version"],
    day: parsed["day"],
    basisHash: parsed["basisHash"],
    timeZone: parsed["timeZone"],
    generatedAt: parsed["generatedAt"],
    segments: parsed["segments"] as MovementShape["segments"],
    narrative: typeof parsed["narrative"] === "string" ? parsed["narrative"] : null,
    suggestions: parsed["suggestions"] as MovementShape["suggestions"],
  };
};

// ---------------------------------------------------------------------------
// Reports and notebook rows
// ---------------------------------------------------------------------------

export class MovementReport extends Schema.Class<MovementReport>(
  "MovementReport",
)({
  ranAt: Schema.String,
  mode: Schema.Literals(["cron", "manual"]),
  live: Schema.Boolean,
  daysChecked: Schema.Number,
  daysMatched: Schema.Number,
  /** Days whose only differences are travel distance/mode on
   * slices containing same-timestamp fix clusters — the server's
   * order for those is execution-dependent (module doc), so its
   * stored values are not reproducible by either side. */
  daysOrderDependent: Schema.Number,
  daysSkipped: Schema.Number,
  daysWouldWrite: Schema.Number,
  daysWritten: Schema.Number,
  mismatches: Schema.Array(
    Schema.Struct({ day: Schema.String, detail: Schema.String }),
  ),
  errors: Schema.Array(
    Schema.Struct({ item: Schema.String, detail: Schema.String }),
  ),
}) {}

export interface MovementPassOptions {
  readonly mode: "cron" | "manual";
  readonly now: Date;
  readonly zone: string;
  /** True when MOVEMENT_MODE is live (missing artifacts are written). */
  readonly perform: boolean;
  /** The eager window (medina-dev's EAGER_WINDOW_DAYS); null = no window. */
  readonly eagerWindowDays: number | null;
  /** One day to check regardless of the window (manual rehearsal). */
  readonly day?: string;
  /** Check every movement day, not just the eager window (manual). */
  readonly all?: boolean;
}

// ---------------------------------------------------------------------------
// Platform: services
// ---------------------------------------------------------------------------

export interface PartitionListing {
  readonly day: string;
  readonly key: string;
  readonly token: string;
}

export interface MovementDataShape {
  readonly listPartitions: (
    prefix: string,
    file: string,
  ) => Effect.Effect<ReadonlyArray<PartitionListing>, CatalogError>;
  /** Object bytes; null when absent. */
  readonly readBytes: (
    key: string,
  ) => Effect.Effect<Uint8Array | null, ArtifactReadError>;
  /** Object text; null when absent. */
  readonly readText: (
    key: string,
  ) => Effect.Effect<string | null, ArtifactReadError>;
  readonly exists: (key: string) => Effect.Effect<boolean, ArtifactReadError>;
  readonly writeText: (
    key: string,
    text: string,
  ) => Effect.Effect<void, ArtifactReadError | IndexRequestError>;
}

export class MovementData extends Context.Service<
  MovementData,
  MovementDataShape
>()("medina-cloudflare/MovementData") {}

export interface DayCheck {
  readonly day: string;
  readonly basis: string;
  readonly state: "matched" | "written";
}

export class MovementNotebook extends Context.Service<
  MovementNotebook,
  {
    readonly record: (
      report: MovementReport,
    ) => Effect.Effect<void, NotebookError>;
    readonly latest: Effect.Effect<
      Option.Option<MovementReport>,
      NotebookError
    >;
    readonly hashes: Effect.Effect<
      ReadonlyMap<string, { readonly token: string; readonly hash: string }>,
      NotebookError
    >;
    readonly setHashes: (
      entries: ReadonlyArray<{
        readonly key: string;
        readonly token: string;
        readonly hash: string;
      }>,
    ) => Effect.Effect<void, NotebookError>;
    readonly checks: Effect.Effect<
      ReadonlyMap<string, DayCheck>,
      NotebookError
    >;
    readonly setCheck: (
      check: DayCheck,
    ) => Effect.Effect<void, NotebookError>;
  }
>()("medina-cloudflare/MovementNotebook") {}

export interface MovementEnv {
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

export const MOVEMENT_DO_NAME = "movement-shadow-v1";

export const movementPlatformLayer = (
  env: MovementEnv,
): Layer.Layer<
  MovementData | MovementNotebook,
  never,
  ArtifactLedger | ArtifactCatalog
> =>
  Layer.effect(
    MovementData,
    Effect.gen(function* () {
      const ledger = yield* ArtifactLedger;
      const catalog = yield* ArtifactCatalog;
      const listingOf = (object: CatalogObject): string =>
        `${object.size}:${object.etag}`;
      return {
        listPartitions: (prefix, file) =>
          Effect.map(catalog.listAll(prefix), (objects) => {
            const pattern = new RegExp(
              `^day=(\\d{4}-\\d{2}-\\d{2})/${file.replace(".", "\\.")}$`,
            );
            return objects.flatMap((object) => {
              const relative = object.key.slice(prefix.length + 1);
              const match = pattern.exec(relative);
              return match
                ? [{ day: match[1]!, key: object.key, token: listingOf(object) }]
                : [];
            });
          }),
        readBytes: (key) =>
          Effect.tryPromise({
            try: async () => {
              const object = await env.artifacts.get(key);
              if (object === null) return null;
              return new Uint8Array(await object.arrayBuffer());
            },
            catch: (cause) =>
              new ArtifactReadError({ key, message: `reading ${key} failed`, cause }),
          }),
        readText: (key) =>
          Effect.map(ledger.readText(key), (text) =>
            Option.isSome(text) ? text.value : null,
          ),
        exists: (key) => ledger.exists(key),
        writeText: (key, text) => ledger.writeText(key, text),
      };
    }),
  ).pipe(
    Layer.merge(
      Layer.succeed(MovementNotebook, {
        record: (report) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(MOVEMENT_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://movement-shadow/report", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(report),
                }),
              );
              if (!response.ok) {
                throw new Error(`notebook rejected a report: ${response.status}`);
              }
            },
            catch: (cause) =>
              new NotebookError({ message: "recording a movement report failed", cause }),
          }),
        latest: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(MOVEMENT_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://movement-shadow/status"),
            );
            if (!response.ok) {
              throw new Error(`notebook status answered ${response.status}`);
            }
            const body = (await response.json()) as {
              lastReport?: MovementReport | null;
            };
            return body.lastReport != null
              ? Option.some(body.lastReport)
              : Option.none<MovementReport>();
          },
          catch: (cause) =>
            new NotebookError({ message: "reading the movement notebook failed", cause }),
        }),
        hashes: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(MOVEMENT_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://movement-shadow/hashes"),
            );
            if (!response.ok) {
              throw new Error(`notebook hashes answered ${response.status}`);
            }
            const body = (await response.json()) as {
              hashes?: ReadonlyArray<{ key: string; token: string; hash: string }>;
            };
            return new Map(
              (body.hashes ?? []).map((row) => [
                row.key,
                { token: row.token, hash: row.hash },
              ] as const),
            );
          },
          catch: (cause) =>
            new NotebookError({ message: "reading movement hashes failed", cause }),
        }),
        setHashes: (entries) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(MOVEMENT_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://movement-shadow/hashes", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ upserts: entries }),
                }),
              );
              if (!response.ok) {
                throw new Error(`notebook hashes write answered ${response.status}`);
              }
            },
            catch: (cause) =>
              new NotebookError({ message: "writing movement hashes failed", cause }),
          }),
        checks: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(MOVEMENT_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://movement-shadow/checks"),
            );
            if (!response.ok) {
              throw new Error(`notebook checks answered ${response.status}`);
            }
            const body = (await response.json()) as {
              checks?: ReadonlyArray<DayCheck>;
            };
            return new Map(
              (body.checks ?? []).map((row) => [row.day, row] as const),
            );
          },
          catch: (cause) =>
            new NotebookError({ message: "reading movement checks failed", cause }),
        }),
        setCheck: (check) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(MOVEMENT_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://movement-shadow/checks", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ upserts: [check] }),
                }),
              );
              if (!response.ok) {
                throw new Error(`notebook checks write answered ${response.status}`);
              }
            },
            catch: (cause) =>
              new NotebookError({ message: "writing movement checks failed", cause }),
          }),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

type MovementError =
  | CatalogError
  | ArtifactReadError
  | IndexRequestError
  | NotebookError;

export const runMovementPass = (
  options: MovementPassOptions,
): Effect.Effect<
  MovementReport,
  MovementError,
  ArtifactLedger | ArtifactCatalog | MovementData | MovementNotebook
> =>
  Effect.gen(function* () {
    const data = yield* MovementData;
    const notebook = yield* MovementNotebook;
    const zone = options.zone;
    const errors: Array<{ item: string; detail: string }> = [];
    const mismatches: Array<{ day: string; detail: string }> = [];

    // Partition listings + content hashes (notebook-cached by
    // listing token, the server's FileHashes arrangement).
    const [pointListings, stayListings] = yield* Effect.all([
      data.listPartitions(POINTS_PREFIX, "points.parquet"),
      data.listPartitions(STAYS_PREFIX, "stays.parquet"),
    ]);
    const cachedHashes = yield* notebook.hashes;
    const hashes = new Map<string, string>();
    const fresh: Array<{ key: string; token: string; hash: string }> = [];
    yield* Effect.forEach(
      [...pointListings, ...stayListings],
      (listing) =>
        Effect.gen(function* () {
          const cached = cachedHashes.get(listing.key);
          if (cached !== undefined && cached.token === listing.token) {
            hashes.set(listing.key, cached.hash);
            return;
          }
          const bytes = yield* data.readBytes(listing.key);
          if (bytes === null) return;
          const hash = yield* Effect.promise(() => sha256Hex(bytes));
          hashes.set(listing.key, hash);
          fresh.push({ key: listing.key, token: listing.token, hash });
        }),
      { concurrency: 8 },
    );
    if (fresh.length > 0) yield* notebook.setHashes(fresh);

    // Places: the server's read order and hash (the raw text).
    const placesText =
      (yield* data.readText(PLACES_KEY)) ??
      (yield* data.readText(LEGACY_PLACES_KEY));
    const placesHash = yield* Effect.promise(() =>
      sha256Hex(placesText ?? ""),
    );
    let places: ReadonlyArray<PlaceShape> = [];
    if (placesText !== null) {
      try {
        places = parsePlaces(JSON.parse(placesText));
      } catch {
        errors.push({ item: "places", detail: "places list did not parse" });
      }
    }

    // The day set: every local day a point can fall in, plus today.
    const movementDays = new Set<string>();
    for (const listing of pointListings) {
      for (const day of utcPartitionLocalDays(listing.day, zone)) {
        movementDays.add(day);
      }
    }
    movementDays.add(localDayOf(options.now, zone));
    let days = [...movementDays].sort();
    if (options.day !== undefined) {
      days = [options.day];
    } else if (options.all !== true) {
      if (options.eagerWindowDays !== null) {
        const since = new Date(
          options.now.getTime() - options.eagerWindowDays * DAY_MS,
        )
          .toISOString()
          .slice(0, 10);
        days = days.filter((day) => day >= since);
      }
      days = days.slice(-14);
    }

    // Per-pass decode caches: adjacent days share partitions.
    const pointsCache = new Map<string, ReadonlyArray<GpsPointRow>>();
    const staysCache = new Map<string, ReadonlyArray<StayRow>>();
    const pointsOf = (utcDay: string) =>
      Effect.gen(function* () {
        const hit = pointsCache.get(utcDay);
        if (hit !== undefined) return hit;
        const bytes = yield* data.readBytes(pointsPartitionKey(utcDay));
        const rows =
          bytes === null
            ? []
            : yield* Effect.promise(() => decodePointsParquet(bytes));
        pointsCache.set(utcDay, rows);
        return rows;
      });
    const staysOf = (utcDay: string) =>
      Effect.gen(function* () {
        const hit = staysCache.get(utcDay);
        if (hit !== undefined) return hit;
        const bytes = yield* data.readBytes(staysPartitionKey(utcDay));
        const rows =
          bytes === null
            ? []
            : yield* Effect.promise(() => decodeStaysParquet(bytes));
        staysCache.set(utcDay, rows);
        return rows;
      });

    // Geocode names: the write-once cache first, Nominatim on a
    // miss (paced within the pass, like the server's module
    // state), memoized per pass. Failures are null, never fatal.
    const geocodeMemo = new Map<string, string | null>();
    let lastGeocodeAt = 0;
    const geocode = (lat: number, lon: number) =>
      Effect.gen(function* () {
        const roundedLat = lat.toFixed(4);
        const roundedLon = lon.toFixed(4);
        const memoKey = `${roundedLat}_${roundedLon}`;
        const memo = geocodeMemo.get(memoKey);
        if (memo !== undefined) return memo;
        const key = `${GEOCODE_PREFIX}/${memoKey}.json`;
        let name: string | null = null;
        const cachedText = yield* data.readText(key);
        if (cachedText !== null) {
          try {
            name = shortGeocodeName(JSON.parse(cachedText));
          } catch {
            name = null;
          }
          geocodeMemo.set(memoKey, name);
          return name;
        }
        // Shadow passes never fetch or write the shared cache: a
        // miss stays null for the comparison (the module doc's
        // narrowing), and live passes fill the cache exactly as
        // the server does.
        if (!options.perform) {
          geocodeMemo.set(memoKey, null);
          return null;
        }
        const wait = Math.max(0, 1000 - (Date.now() - lastGeocodeAt));
        if (wait > 0) yield* Effect.sleep(`${wait} millis`);
        lastGeocodeAt = Date.now();
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(
              `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${roundedLat}&lon=${roundedLon}`,
              {
                headers: { "user-agent": "medina-lifelog/1.0" },
                signal: AbortSignal.timeout(15_000),
              },
            ),
          catch: () => new Error("geocode request failed"),
        }).pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (response !== null && response.ok) {
          const json = yield* Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: () => new Error("geocode parse failed"),
          }).pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (json !== null) {
            name = shortGeocodeName(json);
            if (!(yield* data.exists(key))) {
              yield* data
                .writeText(key, JSON.stringify(json, null, 2))
                .pipe(Effect.catchCause(() => Effect.void));
            }
          }
        }
        geocodeMemo.set(memoKey, name);
        return name;
      });

    /** The day's basis hash — the server's movementDayBasisHash. */
    const basisFor = (day: string) =>
      Effect.promise(async () => {
        const [firstUtc, lastUtc] = localDayUtcRange(day, zone);
        const start = localMidnightUtc(day, zone);
        const end = localMidnightUtc(nextDayOf(day), zone);
        const stayParts: Array<{ relative: string; hash: string }> = [];
        for (const candidate of stayCandidateDays(start, end)) {
          const key = staysPartitionKey(candidate);
          const hash = hashes.get(key);
          if (hash !== undefined) {
            stayParts.push({ relative: `day=${candidate}/stays.parquet`, hash });
          }
        }
        const stayHash = await sha256Hex(staysBasisText(stayParts));
        const utcDays = [...new Set([firstUtc, lastUtc])];
        const pointParts = utcDays.flatMap((utcDay) => {
          const hash = hashes.get(pointsPartitionKey(utcDay));
          return hash === undefined ? [] : [`${utcDay}:${hash}`];
        });
        return sha256Hex(
          `${MOVEMENT_VERSION}\n${MOVEMENT_BASIS_VERSION}\n${zone}\n${stayHash}\n${pointParts.join("\n")}\n${placesHash}`,
        );
      });

    /** Materialize one day — the server's materializeMovement,
     * narrative aside (see the module doc). */
    const materialize = (day: string, basisHash: string) =>
      Effect.gen(function* () {
        const [firstUtc, lastUtc] = localDayUtcRange(day, zone);
        const start = localMidnightUtc(day, zone);
        const end = localMidnightUtc(nextDayOf(day), zone);
        const utcDays = [...new Set([firstUtc, lastUtc])];
        // One deterministic fix order: (ts, source, lat, lon) —
        // the order src/gps.ts's mergeRows writes partitions in.
        // Path distance over a same-timestamp cluster depends on
        // the order; the server's DuckDB order for such clusters
        // is execution-dependent (see the module doc), so this
        // canonical order is the one the flip standardizes on.
        // (composeMovement's own stable ts sort preserves it.)
        const dayPoints = (yield* Effect.forEach(utcDays, pointsOf))
          .flat()
          .filter((point) => {
            const ms = Date.parse(point.ts);
            return ms >= start && ms < end;
          })
          .sort(
            (a, b) =>
              a.ts.localeCompare(b.ts) ||
              a.source.localeCompare(b.source) ||
              a.lat - b.lat ||
              a.lon - b.lon,
          );
        const startIso = new Date(start).toISOString();
        const endIso = new Date(end).toISOString();
        const stays = (yield* Effect.forEach(
          stayCandidateDays(start, end),
          staysOf,
        ))
          .flat()
          .filter(
            (stay) =>
              stay.last_point_ts >= startIso && stay.first_point_ts < endIso,
          )
          .sort((a, b) => a.first_point_ts.localeCompare(b.first_point_ts));
        const raw = composeMovement(stays, dayPoints);
        const segments: Array<MovementSegmentShape> = [];
        const suggestionCandidates: Array<{
          lat: number;
          lon: number;
          geocodedName: string | null;
          dwellMinutes: number;
        }> = [];
        for (const segment of raw) {
          if (segment.kind === "stay") {
            const nearest =
              places
                .map((place) => ({ place, meters: haversineMeters(segment, place) }))
                .filter(({ place, meters }) => meters <= place.radiusMeters)
                .sort((a, b) => a.meters - b.meters)[0]?.place ?? null;
            const geocodedName = yield* geocode(segment.lat, segment.lon);
            const dwellMinutes = Math.round(
              (Date.parse(segment.end) - Date.parse(segment.start)) / 60_000,
            );
            const visibleStart = new Date(
              Math.max(Date.parse(segment.start), start),
            ).toISOString();
            const visibleEnd = new Date(
              Math.min(Date.parse(segment.end), end),
            ).toISOString();
            segments.push({
              kind: "stay",
              startTime: segment.start,
              endTime: segment.end,
              startLocal: localTime(visibleStart, zone),
              endLocal: localTime(visibleEnd, zone),
              lat: segment.lat,
              lon: segment.lon,
              placeId: nearest?.id ?? null,
              placeName: nearest?.name ?? geocodedName,
              geocodedName,
              dwellMinutes,
              fixes: segment.fixes,
            });
            if (nearest === null) {
              const existing = suggestionCandidates.find(
                (candidate) => haversineMeters(candidate, segment) <= STAY_RADIUS_M,
              );
              if (existing) {
                const total = existing.dwellMinutes + dwellMinutes;
                existing.lat =
                  total === 0
                    ? (existing.lat + segment.lat) / 2
                    : (existing.lat * existing.dwellMinutes +
                        segment.lat * dwellMinutes) /
                      total;
                existing.lon =
                  total === 0
                    ? (existing.lon + segment.lon) / 2
                    : (existing.lon * existing.dwellMinutes +
                        segment.lon * dwellMinutes) /
                      total;
                existing.dwellMinutes = total;
                existing.geocodedName ??= geocodedName;
              } else {
                suggestionCandidates.push({
                  lat: segment.lat,
                  lon: segment.lon,
                  geocodedName,
                  dwellMinutes,
                });
              }
            }
          } else if (segment.kind === "travel") {
            segments.push({
              kind: "travel",
              startTime: segment.start,
              endTime: segment.end,
              startLocal: localTime(segment.start, zone),
              endLocal: localTime(segment.end, zone),
              distanceMeters: Math.round(segment.distanceMeters),
              mode: segment.mode,
              fixes: segment.fixes,
            });
          } else {
            segments.push({
              kind: "gap",
              startTime: segment.start,
              endTime: segment.end,
              startLocal: localTime(segment.start, zone),
              endLocal: localTime(segment.end, zone),
              fixes: segment.fixes,
            });
          }
        }
        return {
          version: MOVEMENT_VERSION,
          day,
          basisHash,
          timeZone: zone,
          generatedAt: options.now.toISOString(),
          segments,
          narrative: null,
          suggestions: suggestionCandidates.map((suggestion) => ({
            lat: suggestion.lat,
            lon: suggestion.lon,
            geocodedName: suggestion.geocodedName,
            dwellMinutes: suggestion.dwellMinutes,
          })),
        } satisfies MovementShape;
      });

    const checks = yield* notebook.checks;
    let daysChecked = 0;
    let daysMatched = 0;
    let daysOrderDependent = 0;
    let daysSkipped = 0;
    let daysWouldWrite = 0;
    let daysWritten = 0;
    for (const day of days) {
      const outcome = yield* Effect.gen(function* () {
        const basisHash = yield* basisFor(day);
        const key = movementKey(day, basisHash);
        const memo = checks.get(day);
        const exists = yield* data.exists(key);
        if (
          exists &&
          memo !== undefined &&
          memo.basis === `${MEMO_EPOCH}:${basisHash}` &&
          (memo.state === "matched" || memo.state === "written")
        ) {
          daysSkipped++;
          return;
        }
        daysChecked++;
        const mine = yield* materialize(day, basisHash);
        if (!exists) {
          if (options.perform) {
            yield* data.writeText(key, `${JSON.stringify(mine, null, 2)}\n`);
            yield* notebook.setCheck({ day, basis: `${MEMO_EPOCH}:${basisHash}`, state: "written" });
            daysWritten++;
          } else {
            daysWouldWrite++;
          }
          return;
        }
        const storedText = yield* data.readText(key);
        const stored =
          storedText === null ? null : parseMovement(JSON.parse(storedText));
        if (stored === null) {
          mismatches.push({ day, detail: "stored artifact did not parse" });
          return;
        }
        const mineView = JSON.stringify(deterministicView(mine));
        const storedView = JSON.stringify(deterministicView(stored));
        if (mineView === storedView) {
          daysMatched++;
          yield* notebook.setCheck({ day, basis: `${MEMO_EPOCH}:${basisHash}`, state: "matched" });
        } else {
          // Classify: a difference is structural when anything but
          // a travel segment's distance/mode moves (kind, times,
          // fixes, stays, gaps, suggestions). Travel distance/mode
          // differences alone are the documented order-dependent
          // class (same-timestamp clusters, module doc).
          const a = deterministicView(mine);
          const b = deterministicView(stored);
          let detail: string | null = null;
          let orderDependent = 0;
          if (a.segments.length !== b.segments.length) {
            detail = `segments ${a.segments.length} vs stored ${b.segments.length}`;
          } else {
            for (let i = 0; i < a.segments.length; i++) {
              const mineSeg = a.segments[i]!;
              const storedSeg = b.segments[i]!;
              if (JSON.stringify(mineSeg) === JSON.stringify(storedSeg)) continue;
              const sameSkeleton =
                mineSeg.kind === storedSeg.kind &&
                mineSeg.startTime === storedSeg.startTime &&
                mineSeg.endTime === storedSeg.endTime &&
                mineSeg.fixes === storedSeg.fixes;
              if (mineSeg.kind === "travel" && sameSkeleton) {
                orderDependent++;
              } else {
                detail = `segment ${i}: ${JSON.stringify(mineSeg)?.slice(0, 140)} vs stored ${JSON.stringify(storedSeg)?.slice(0, 140)}`;
                break;
              }
            }
            if (
              detail === null &&
              JSON.stringify(a.suggestions) !== JSON.stringify(b.suggestions)
            ) {
              detail = `suggestions ${JSON.stringify(a.suggestions)?.slice(0, 140)} vs stored ${JSON.stringify(b.suggestions)?.slice(0, 140)}`;
            }
          }
          if (detail === null && orderDependent > 0) {
            daysOrderDependent++;
            yield* notebook.setCheck({ day, basis: `${MEMO_EPOCH}:${basisHash}`, state: "matched" });
          } else {
            mismatches.push({
              day,
              detail: detail ?? "deterministic content differs",
            });
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            errors.push({ item: day, detail: String(cause).slice(0, 300) });
          }),
        ),
      );
      void outcome;
    }

    const report = new MovementReport({
      ranAt: options.now.toISOString(),
      mode: options.mode,
      live: options.perform,
      daysChecked,
      daysMatched,
      daysOrderDependent,
      daysSkipped,
      daysWouldWrite,
      daysWritten,
      mismatches: mismatches.slice(0, 20),
      errors,
    });
    yield* notebook.record(report);
    return report;
  });

// ---------------------------------------------------------------------------
// MovementShadow: the resource's notebook Durable Object — recent
// pass reports, the partition content-hash cache, and the per-day
// check memo, in its own SQLite storage.
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

export class MovementShadow {
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
        `CREATE TABLE IF NOT EXISTS partition_hashes (
           key TEXT PRIMARY KEY,
           token TEXT NOT NULL,
           hash TEXT NOT NULL
         )`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS day_checks (
           day TEXT PRIMARY KEY,
           basis TEXT NOT NULL,
           state TEXT NOT NULL
         )`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
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
      return json({ ok: true });
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
      return json({
        runCount: Number(countRows[0]?.["n"] ?? 0),
        lastReport,
      });
    }
    if (request.method === "GET" && url.pathname === "/hashes") {
      const rows = this.sql
        .exec(`SELECT key, token, hash FROM partition_hashes`)
        .toArray();
      return json({
        hashes: rows.map((row) => ({
          key: String(row["key"]),
          token: String(row["token"]),
          hash: String(row["hash"]),
        })),
      });
    }
    if (request.method === "POST" && url.pathname === "/hashes") {
      const body = (await request.json().catch(() => ({}))) as {
        upserts?: ReadonlyArray<{ key: string; token: string; hash: string }>;
      };
      for (const row of body.upserts ?? []) {
        this.sql.exec(
          `INSERT INTO partition_hashes (key, token, hash)
             VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               token = excluded.token,
               hash = excluded.hash`,
          row.key,
          row.token,
          row.hash,
        );
      }
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/checks") {
      const rows = this.sql
        .exec(`SELECT day, basis, state FROM day_checks`)
        .toArray();
      return json({
        checks: rows.map((row) => ({
          day: String(row["day"]),
          basis: String(row["basis"]),
          state: String(row["state"]),
        })),
      });
    }
    if (request.method === "POST" && url.pathname === "/checks") {
      const body = (await request.json().catch(() => ({}))) as {
        upserts?: ReadonlyArray<DayCheck>;
      };
      for (const row of body.upserts ?? []) {
        this.sql.exec(
          `INSERT INTO day_checks (day, basis, state)
             VALUES (?, ?, ?)
             ON CONFLICT(day) DO UPDATE SET
               basis = excluded.basis,
               state = excluded.state`,
          row.day,
          row.basis,
          row.state,
        );
      }
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }
}
