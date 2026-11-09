/**
 * Domain-port tests for movement (src/movement.ts): composeMovement
 * and utcPartitionLocalDays must agree with the medina-dev
 * implementation they mirror (lib/lifelog/Movement.ts) — these
 * vectors are the server's own Movement.test.ts cases, carried
 * over so a drift in either implementation shows up here. The
 * live parity evidence is the shadow pass itself.
 */
import { describe, expect, test } from "bun:test";
import type { StayRow } from "./gps.ts";
import {
  composeMovement,
  localDayUtcRange,
  localMidnightUtc,
  shortGeocodeName,
  stayCandidateDays,
  utcPartitionLocalDays,
  type MovementFix,
} from "./movement.ts";

const fix = (minutes: number, lat: number, lon: number): MovementFix => ({
  ts: new Date(Date.UTC(2026, 7, 29, 12, minutes)).toISOString(),
  lat,
  lon,
});
const stay = (
  start: number,
  end: number,
  lat: number,
  lon: number,
  count = 2,
): StayRow => ({
  first_point_ts: fix(start, lat, lon).ts,
  last_point_ts: fix(end, lat, lon).ts,
  lat,
  lon,
  radius_m: 0,
  point_count: count,
  observed_duration_s: (end - start) * 60,
});

describe("composeMovement", () => {
  test("uses materialized stays and classifies observed travel between them", () => {
    const stays = [stay(0, 20, 41.88, -87.63, 3), stay(50, 70, 41.91, -87.63, 3)];
    const points = [
      fix(20, 41.88, -87.63),
      fix(30, 41.895, -87.63),
      fix(40, 41.91, -87.63),
      fix(50, 41.91, -87.63),
    ];
    const segments = composeMovement(stays, points);
    expect(segments.map((segment) => segment.kind)).toEqual([
      "stay",
      "travel",
      "stay",
    ]);
    expect(segments[1]?.kind === "travel" && segments[1].mode).toBe("walk");
  });

  test("uses a gap for sparse distant evidence between stays", () => {
    const stays = [stay(0, 0, 41.88, -87.63, 1), stay(390, 390, 41.9, -87.63, 1)];
    const segments = composeMovement(stays, [
      fix(0, 41.88, -87.63),
      fix(390, 41.9, -87.63),
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual([
      "stay",
      "gap",
      "stay",
    ]);
  });

  test("folds only bracketed zero-duration singleton stays into travel", () => {
    const stays = [
      stay(0, 20, 41.88, -87.63),
      stay(30, 30, 41.895, -87.63, 1),
      stay(40, 60, 41.91, -87.63),
    ];
    const points = [
      fix(20, 41.88, -87.63),
      fix(30, 41.895, -87.63),
      fix(40, 41.91, -87.63),
    ];
    const segments = composeMovement(stays, points);
    expect(segments.map((segment) => segment.kind)).toEqual([
      "stay",
      "travel",
      "stay",
    ]);
    expect(segments[1]?.kind === "travel" && segments[1].fixes).toBe(3);
  });
});

describe("utcPartitionLocalDays", () => {
  test("a UTC partition maps to the local days its milliseconds touch", () => {
    expect(utcPartitionLocalDays("2026-09-02", "America/Chicago")).toEqual([
      "2026-09-01",
      "2026-09-02",
    ]);
    expect(utcPartitionLocalDays("2026-09-02", "UTC")).toEqual(["2026-09-02"]);
    expect(utcPartitionLocalDays("2026-09-02", "Asia/Tokyo")).toEqual([
      "2026-09-02",
      "2026-09-03",
    ]);
  });
});

describe("local day arithmetic", () => {
  test("Los Angeles winter day spans two UTC days", () => {
    expect(localDayUtcRange("2026-11-08", "America/Los_Angeles")).toEqual([
      "2026-11-08",
      "2026-11-09",
    ]);
    const start = localMidnightUtc("2026-11-08", "America/Los_Angeles");
    expect(new Date(start).toISOString()).toBe("2026-11-08T08:00:00.000Z");
  });

  test("stay candidates run from the day before start through end minus a tick", () => {
    const start = localMidnightUtc("2026-11-08", "America/Los_Angeles");
    const end = localMidnightUtc("2026-11-09", "America/Los_Angeles");
    expect(stayCandidateDays(start, end)).toEqual([
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
    ]);
  });
});

describe("shortGeocodeName", () => {
  test("prefers amenity, then road + area, then display name", () => {
    expect(
      shortGeocodeName({ address: { amenity: "Cafe", road: "X" } }),
    ).toBe("Cafe");
    expect(
      shortGeocodeName({ address: { road: "Steiner Street", suburb: "Cow Hollow" } }),
    ).toBe("Steiner Street, Cow Hollow");
    expect(
      shortGeocodeName({ display_name: "A, B, C, D" }),
    ).toBe("A, B, C");
    expect(shortGeocodeName({})).toBeNull();
    expect(shortGeocodeName(null)).toBeNull();
  });
});
