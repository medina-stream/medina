import { describe, expect, test } from "bun:test";
import { detectStaysByDay } from "../../lib/lifelog/Stays.ts";
import {
  canonicalRow,
  canonicalStay,
  computeStays,
  decodePointsParquet,
  decodeStaysParquet,
  encodePointsParquet,
  encodeStaysParquet,
  mergeRows,
  parseInboxText,
  staysBasisText,
  type GpsPointRow,
} from "./gps.ts";

const point = (
  ts: string,
  lat = 37.7749,
  lon = -122.4194,
  extra: Partial<GpsPointRow> = {},
): GpsPointRow => ({
  source: "device-events",
  ts,
  lat,
  lon,
  speed: null,
  alt: null,
  acc: null,
  batt: null,
  raw: "{}",
  ...extra,
});

describe("parseInboxText", () => {
  test("parses NDJSON points and normalizes ts + drifted numerics", () => {
    const text =
      JSON.stringify({
        source: "device-events",
        ts: "2026-11-03T01:04:26.74Z",
        lat: 37.1,
        lon: -122.1,
        speed: null,
        alt: "12.5",
        acc: 4,
        batt: null,
        raw: "body",
      }) + "\n";
    const rows = parseInboxText(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ts).toBe("2026-11-03T01:04:26.740Z");
    expect(rows[0]!.alt).toBe(12.5);
    expect(rows[0]!.acc).toBe(4);
  });

  test("a malformed line fails the file (the server's posture)", () => {
    expect(() => parseInboxText('{"source":1}\n')).toThrow();
    expect(() => parseInboxText("not json\n")).toThrow();
  });
});

describe("mergeRows", () => {
  test("dedupes on (source, ts, lat, lon), first occurrence wins, ts order", () => {
    const inboxVersion = point("2026-11-03T01:00:00.000Z", 37.1, -122.1, {
      speed: 1,
    });
    const partitionVersion = point("2026-11-03T01:00:00.000Z", 37.1, -122.1, {
      speed: 9,
    });
    const later = point("2026-11-03T02:00:00.000Z", 37.2, -122.2);
    const earlier = point("2026-11-03T00:30:00.000Z", 37.0, -122.0);
    const merged = mergeRows([inboxVersion, later, partitionVersion, earlier]);
    expect(merged.map((row) => row.ts)).toEqual([
      "2026-11-03T00:30:00.000Z",
      "2026-11-03T01:00:00.000Z",
      "2026-11-03T02:00:00.000Z",
    ]);
    // The inbox copy of the duplicate survives (UNION ALL order).
    expect(merged[1]!.speed).toBe(1);
  });
});

describe("computeStays (port) vs lib/lifelog/Stays.ts", () => {
  test("agrees with detectStaysByDay on clustered + lone points across days", () => {
    const day1 = [
      point("2026-01-15T08:00:00.000Z"),
      point("2026-01-15T09:00:00.000Z", 37.7751, -122.4196),
      point("2026-01-15T10:00:00.000Z", 37.7748, -122.4192),
    ];
    const day2 = [point("2026-01-16T08:00:00.000Z", 37.8044, -122.2712)];
    const mine = computeStays([day1, day2]);
    const theirs = detectStaysByDay(
      [day1, day2].map((rows) =>
        rows.map((row) => ({ ts: row.ts, lat: row.lat, lon: row.lon })),
      ),
    );
    expect(mine.map(canonicalStay)).toEqual(theirs.map(canonicalStay));
    expect(mine).toHaveLength(2);
    expect(mine[0]!.point_count).toBe(3);
    expect(mine[1]!.point_count).toBe(1);
    expect(mine[1]!.radius_m).toBe(0);
  });

  test("a cluster carrying across midnight stays whole", () => {
    const day1 = [point("2026-01-15T23:30:00.000Z")];
    const day2 = [point("2026-01-16T00:30:00.000Z", 37.775, -122.4195)];
    const mine = computeStays([day1, day2]);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.point_count).toBe(2);
    expect(mine[0]!.first_point_ts).toBe("2026-01-15T23:30:00.000Z");
  });
});

describe("parquet codec", () => {
  test("points round-trip exactly (nulls, raw, drifted values normalized)", async () => {
    const rows = [
      point("2026-11-03T01:04:26.740Z", 37.123, -122.456, {
        speed: 1.5,
        acc: 4.2,
        batt: 88,
        raw: "{\"a\":1}",
      }),
      point("2026-11-03T01:05:00.000Z", 37.124, -122.457, {
        source: "gpslogger",
        raw: "form",
      }),
    ];
    const decoded = await decodePointsParquet(encodePointsParquet(rows));
    expect(decoded.map(canonicalRow)).toEqual(rows.map(canonicalRow));
  });

  test("stays round-trip exactly", async () => {
    const stays = [
      {
        first_point_ts: "2026-01-15T08:00:00.000Z",
        last_point_ts: "2026-01-15T10:00:00.000Z",
        lat: 37.7749,
        lon: -122.4194,
        radius_m: 12.34,
        point_count: 3,
        observed_duration_s: 7200,
      },
    ];
    const decoded = await decodeStaysParquet(encodeStaysParquet(stays));
    expect(decoded.map(canonicalStay)).toEqual(stays.map(canonicalStay));
  });
});

describe("staysBasisText", () => {
  test("matches the server's construction byte for byte", () => {
    expect(
      staysBasisText([
        { relative: "day=2026-01-15/points.parquet", hash: "abc" },
        { relative: "day=2026-01-16/points.parquet", hash: "def" },
      ]),
    ).toBe("stays-v1\n150\nday=2026-01-15/points.parquet\tabc\nday=2026-01-16/points.parquet\tdef");
  });
});
