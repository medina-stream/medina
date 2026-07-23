import { describe, expect, test } from "bun:test";

import type { GpsLog } from "./gps";
import { describeSegments, inferTravelMode, segmentGpsLogs } from "./gps-segments";
import { findPlace, parsePlacesMarkdown, PLACES_TEMPLATE } from "./places";

const BASE = Date.parse("2026-07-20T17:00:00.000Z");

function log(minutes: number, latitude: number, longitude: number, speed: number | null = null, timeZone = "America/Los_Angeles"): GpsLog {
  return {
    ingestKey: `test:${minutes}`,
    latitude,
    longitude,
    speed,
    time: new Date(BASE + minutes * 60 * 1000).toISOString(),
    timeZone,
  };
}

// ~0.001 lat deg ≈ 111 m; ~0.001 lng deg ≈ 88 m at 37.8N
const HOME = { latitude: 37.799, longitude: -122.434 };
const CAFE = { latitude: 37.8055, longitude: -122.4445 };

describe("segmentGpsLogs", () => {
  test("detects stays, travel legs, and matches named places", () => {
    const places = parsePlacesMarkdown([
      PLACES_TEMPLATE,
      `| Home | ${HOME.latitude} | ${HOME.longitude} | 75 | |`,
      `| Reveille Cafe | ${CAFE.latitude} | ${CAFE.longitude} | 60 | coffee |`,
    ].join("\n"));

    const logs = [
      log(0, HOME.latitude, HOME.longitude, 0),
      log(15, HOME.latitude + 0.0002, HOME.longitude, 0),
      log(30, HOME.latitude, HOME.longitude + 0.0002, 0),
      log(33, 37.801, -122.437, 1.4),
      log(36, 37.803, -122.440, 1.5),
      log(39, 37.804, -122.443, 1.3),
      log(42, CAFE.latitude, CAFE.longitude, 0),
      log(60, CAFE.latitude + 0.0001, CAFE.longitude, 0),
      log(75, CAFE.latitude, CAFE.longitude, 0),
    ];

    const segments = segmentGpsLogs(logs, places);
    expect(segments.map((segment) => segment.kind)).toEqual(["stay", "travel", "stay"]);
    expect(segments[0]).toMatchObject({ kind: "stay", placeName: "Home", timeZone: "America/Los_Angeles" });
    expect(segments[2]).toMatchObject({ kind: "stay", placeName: "Reveille Cafe", timeZone: "America/Los_Angeles" });
    const travel = segments[1]!;
    expect(travel.kind === "travel" && travel.mode).toBe("walked");
    expect(travel.kind === "travel" && travel.zoneChanged).toBe(false);

    const lines = describeSegments(segments, "America/Los_Angeles");
    expect(lines[0]).toContain("at Home");
    expect(lines[1]).toContain("walked");
    expect(lines[2]).toContain("at Reveille Cafe");
  });

  test("unnamed stays fall back to coordinates", () => {
    const logs = [
      log(0, 37.75, -122.45, 0),
      log(20, 37.7501, -122.45, 0),
    ];
    const segments = segmentGpsLogs(logs, []);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "stay", placeName: null, timeZone: "America/Los_Angeles" });
  });

  test("renders per-segment zone abbreviations when zones differ from dominant zone", () => {
    const segments = segmentGpsLogs([
      log(0, HOME.latitude, HOME.longitude, 0, "America/Los_Angeles"),
      log(20, HOME.latitude + 0.0001, HOME.longitude, 0, "America/Los_Angeles"),
      log(180, 40.7128, -74.006, 12, "America/New_York"),
      log(210, 40.713, -74.0058, 12, "America/New_York"),
    ], []);

    const lines = describeSegments(segments, "America/Los_Angeles");
    expect(lines.some((line) => line.includes("EDT"))).toBe(true);
  });
});

describe("inferTravelMode", () => {
  test("classifies by speed profile", () => {
    expect(inferTravelMode([1.2, 1.4, 1.5, 1.3])).toBe("walked");
    expect(inferTravelMode([4.5, 5.0, 5.5, 6.0])).toBe("biked");
    expect(inferTravelMode([9, 12, 14, 11])).toBe("drove or rode transit");
    expect(inferTravelMode([])).toBe("moved");
  });
});

describe("places", () => {
  test("parses the template plus rows and matches by radius", () => {
    const places = parsePlacesMarkdown([
      PLACES_TEMPLATE,
      "| Home | 37.799 | -122.434 | 75 | |",
      "| YMCA pool | 37.8 | -122.44 | | swim |",
    ].join("\n"));
    expect(places).toHaveLength(2);
    expect(places[1]).toMatchObject({ name: "YMCA pool", radiusMeters: 75 });

    expect(findPlace(places, { latitude: 37.7993, longitude: -122.434 })?.name).toBe("Home");
    expect(findPlace(places, { latitude: 37.79, longitude: -122.42 })).toBeNull();
  });
});
