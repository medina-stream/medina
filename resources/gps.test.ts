import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMemoryBucket } from "../lib/bucket.test";
import { runResource } from "../lib/resource";
import type { Bucket } from "../lib/bucket";
import { createGpsHour, getGpsHourKey } from "./gps-hour";
import {
  collapseGpsLogs,
  createFallbackGpsSummary,
  createGpsMarkdown,
  getGpsHourKeysForDay,
  getGpsJsonKey,
  getGpsMarkdownKey,
  gpsDefinition,
  type GpsJson,
  type GpsLog,
} from "./gps";
import { segmentGpsLogs } from "./gps-segments";

const originalEnv = { ...process.env };

async function writeHour(bucket: Bucket, hourId: string, logs: GpsLog[]) {
  await bucket.write(getGpsHourKey(hourId), `${JSON.stringify(createGpsHour(hourId, logs), null, 2)}\n`, {
    type: "application/json; charset=utf-8",
  });
}

describe("gps resource", () => {
  let bucket: Bucket;

  beforeEach(() => {
    process.env = { ...originalEnv, MEDINA_GPS_SUMMARY_MODE: "off", MEDINA_GPS_TIME_ZONE: "America/Los_Angeles" };
    bucket = createMemoryBucket();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("collapses duplicate and stationary updates while preserving significant changes", () => {
    const logs = [
      { ingestKey: "in/a", latitude: 37.801, longitude: -122.449, speed: 0, time: "2026-06-25T12:00:00.000Z", timeZone: "America/Los_Angeles" },
      { ingestKey: "in/duplicate", latitude: 37.801, longitude: -122.449, speed: 0, time: "2026-06-25T12:00:00.000Z", timeZone: "America/Los_Angeles" },
      { ingestKey: "in/jitter", latitude: 37.80101, longitude: -122.44901, speed: 0, time: "2026-06-25T12:01:00.000Z", timeZone: "America/Los_Angeles" },
      { ingestKey: "in/sample", latitude: 37.8013, longitude: -122.4493, speed: 0, time: "2026-06-25T12:10:00.000Z", timeZone: "America/Los_Angeles" },
      { ingestKey: "in/far", latitude: 37.803, longitude: -122.449, speed: 0, time: "2026-06-25T12:11:00.000Z", timeZone: "America/Los_Angeles" },
    ];

    expect(collapseGpsLogs(logs).map((log) => ({ ingestKey: log.ingestKey, collapsedPoints: log.collapsedPoints }))).toEqual([
      { ingestKey: "in/a", collapsedPoints: 2 },
      { ingestKey: "in/sample", collapsedPoints: 1 },
      { ingestKey: "in/far", collapsedPoints: 1 },
    ]);
  });

  test("reads a widened 52-hour UTC window for local day assembly", () => {
    const hourKeys = getGpsHourKeysForDay("020260625");
    expect(hourKeys).toHaveLength(52);
    expect(hourKeys[0]).toBe("gps-hours/02026062410.json");
    expect(hourKeys.at(-1)).toBe("gps-hours/02026062613.json");
  });

  test("materializes daily GPS markdown and json from filtered local-day points", async () => {
    const priorDay = [
      { ingestKey: "in/prior", latitude: 34.05, longitude: -118.24, speed: 0, time: "2026-07-21T23:30:00.000Z", timeZone: "America/Los_Angeles" },
    ];
    const sameLocalDay = [
      { ingestKey: "in/la-late", latitude: 34.05, longitude: -118.24, speed: 0, time: "2026-07-22T16:30:00.000Z", timeZone: "America/Los_Angeles" },
      { ingestKey: "in/tokyo-morning", latitude: 35.6764, longitude: 139.65, speed: 0, time: "2026-07-21T18:30:00.000Z", timeZone: "Asia/Tokyo" },
    ];
    const nextLocalDay = [
      { ingestKey: "in/tokyo-next", latitude: 35.6764, longitude: 139.65, speed: 0, time: "2026-07-22T15:30:00.000Z", timeZone: "Asia/Tokyo" },
    ];

    await writeHour(bucket, "02026072118", [sameLocalDay[1]!]);
    await writeHour(bucket, "02026072123", priorDay);
    await writeHour(bucket, "02026072216", [sameLocalDay[0]!]);
    await writeHour(bucket, "02026072215", nextLocalDay);

    const result = await runResource(gpsDefinition, {
      bucket,
      inputKey: "020260722",
      now: new Date("2026-07-22T14:00:00.000Z"),
    });
    const json = await bucket.readJson<GpsJson>(getGpsJsonKey("020260722"));

    expect(result.plan.state.logs.map((log) => log.ingestKey)).toEqual(["in/tokyo-morning", "in/la-late"]);
    expect(result.outputs).toEqual([getGpsMarkdownKey("020260722"), getGpsJsonKey("020260722")]);
    expect(json).toMatchObject({
      collapsedCount: 2,
      dayId: "020260722",
      rawCount: 2,
      timeZoneFallbackUsed: false,
    });
    expect(await bucket.readText(getGpsMarkdownKey("020260722"))).toBe(createGpsMarkdown(json, result.plan.state.logs));
  });

  test("recomputes collapse after local-day filtering across hour boundaries", async () => {
    const hourOne = [
      { ingestKey: "in/a", latitude: 37, longitude: -122, speed: 0, time: "2026-06-25T12:50:00.000Z", timeZone: "America/Los_Angeles" },
      { ingestKey: "in/b", latitude: 37.00001, longitude: -122.00001, speed: 0, time: "2026-06-25T12:59:00.000Z", timeZone: "America/Los_Angeles" },
    ];
    const hourTwo = [
      { ingestKey: "in/c", latitude: 37.00002, longitude: -122.00002, speed: 0, time: "2026-06-25T13:01:00.000Z", timeZone: "America/Los_Angeles" },
      { ingestKey: "in/d", latitude: 37.01, longitude: -122, speed: 0, time: "2026-06-25T13:02:00.000Z", timeZone: "America/Los_Angeles" },
    ];
    await writeHour(bucket, "02026062512", hourOne);
    await writeHour(bucket, "02026062513", hourTwo);

    const result = await runResource(gpsDefinition, {
      bucket,
      inputKey: "020260625",
      now: new Date("2026-06-25T14:00:00.000Z"),
    });
    const wholeDay = collapseGpsLogs([...hourOne, ...hourTwo]);
    const naiveHourly = [...collapseGpsLogs(hourOne), ...collapseGpsLogs(hourTwo)];

    expect(result.plan.state.logs.map((log) => log.ingestKey)).toEqual(
      [...hourOne, ...hourTwo].map((log) => log.ingestKey),
    );
    expect(wholeDay).not.toEqual(naiveHourly);
    expect((await bucket.readJson<GpsJson>(getGpsJsonKey("020260625"))).collapsedCount).toBe(wholeDay.length);
  });

  test("uses fallback timezone and no-gps warnings for empty days", async () => {
    process.env.MEDINA_GPS_TIME_ZONE = "America/New_York";

    await runResource(gpsDefinition, {
      bucket,
      inputKey: "020260722",
      now: new Date("2026-07-22T14:00:00.000Z"),
    });

    const json = await bucket.readJson<GpsJson>(getGpsJsonKey("020260722"));
    expect(json).toMatchObject({
      dayId: "020260722",
      dominantTimeZone: "America/New_York",
      multiZone: false,
      rawCount: 0,
      collapsedCount: 0,
      timeZoneFallbackUsed: true,
      warnings: ["no-gps"],
    });
  });

  test("handles eastbound red-eye travel with mixed zones and timeline abbreviations", async () => {
    const logs = [
      { ingestKey: "in/la-stay-1", latitude: 33.9416, longitude: -118.4085, speed: 0, time: "2026-07-22T15:00:00.000Z" },
      { ingestKey: "in/la-stay-2", latitude: 33.9417, longitude: -118.4084, speed: 0, time: "2026-07-22T15:59:00.000Z" },
      { ingestKey: "in/flight-1", latitude: 35.0, longitude: -110.0, speed: 250, time: "2026-07-22T17:00:00.000Z" },
      { ingestKey: "in/flight-2", latitude: 39.0, longitude: -95.0, speed: 250, time: "2026-07-22T18:30:00.000Z" },
      { ingestKey: "in/flight-3", latitude: 40.7, longitude: -74.0, speed: 250, time: "2026-07-22T20:00:00.000Z" },
      { ingestKey: "in/ny-stay-1", latitude: 40.7128, longitude: -74.006, speed: 0, time: "2026-07-22T20:30:00.000Z" },
      { ingestKey: "in/ny-stay-2", latitude: 40.7129, longitude: -74.0059, speed: 0, time: "2026-07-23T03:55:00.000Z" },
    ];

    await writeHour(bucket, "02026072215", logs.slice(0, 2));
    await writeHour(bucket, "02026072217", [logs[2]!]);
    await writeHour(bucket, "02026072218", [logs[3]!]);
    await writeHour(bucket, "02026072220", [logs[4]!, logs[5]!]);
    await writeHour(bucket, "02026072303", [logs[6]!]);

    await runResource(gpsDefinition, {
      bucket,
      inputKey: "020260722",
      now: new Date("2026-07-23T06:00:00.000Z"),
    });

    const json = await bucket.readJson<GpsJson>(getGpsJsonKey("020260722"));
    expect(json.multiZone).toBe(true);
    expect(json.dominantTimeZone).toBe("America/New_York");
    expect(json.timeZoneCoverage.map((zone) => zone.timeZone)).toEqual(["America/New_York", "America/Los_Angeles"]);
    expect(json.segments.map((segment) => segment.timeZone)).toEqual([
      "America/Los_Angeles",
      "America/Los_Angeles",
      "America/New_York",
    ]);
    expect(json.warnings).toContain("zone-change-in-segment");
    expect(json.timeline.some((line) => line.includes("PDT"))).toBe(true);
    expect(json.timeline.some((line) => line.includes("EDT"))).toBe(false);
  });

  test("falls back to default timezone for old hour payloads without point zones", async () => {
    process.env.MEDINA_GPS_TIME_ZONE = "America/New_York";
    await bucket.write(getGpsHourKey("02026072203"), JSON.stringify({
      collapsedCount: 1,
      collapsedPoints: [],
      deduplicatedCount: 1,
      deduplicatedPoints: [
        { ingestKey: "legacy", latitude: 40.7128, longitude: -74.006, speed: 0, time: "2026-07-22T03:30:00.000Z" },
      ],
      duplicateCount: 0,
      endTime: "2026-07-22T04:00:00.000Z",
      hourId: "02026072203",
      rawCount: 1,
      startTime: "2026-07-22T03:00:00.000Z",
      timeBounds: null,
      version: 2,
    }), { type: "application/json; charset=utf-8" });

    await runResource(gpsDefinition, {
      bucket,
      inputKey: "020260721",
      now: new Date("2026-07-22T14:00:00.000Z"),
    });

    const json = await bucket.readJson<GpsJson>(getGpsJsonKey("020260721"));
    expect(json.timeZoneFallbackUsed).toBe(true);
    expect(json.dominantTimeZone).toBe("America/New_York");
  });

  test("emits the structured gps json shape", async () => {
    const logs = [
      { ingestKey: "in/a", latitude: 37.8, longitude: -122.44, speed: 0, time: "2026-07-22T15:00:00.000Z", timeZone: "America/Los_Angeles" },
      { ingestKey: "in/b", latitude: 37.8001, longitude: -122.4401, speed: 0, time: "2026-07-22T15:20:00.000Z", timeZone: "America/Los_Angeles" },
    ];
    await writeHour(bucket, "02026072215", logs);

    await runResource(gpsDefinition, {
      bucket,
      inputKey: "020260722",
      now: new Date("2026-07-22T20:00:00.000Z"),
    });

    const json = await bucket.readJson<GpsJson>(getGpsJsonKey("020260722"));
    expect(json).toEqual({
      collapsedCount: 2,
      dayId: "020260722",
      dominantTimeZone: "America/Los_Angeles",
      generatedAt: "2026-07-22T20:00:00.000Z",
      multiZone: false,
      rawCount: 2,
      segments: [
        {
          endTime: "2026-07-22T15:20:00.000Z",
          kind: "stay",
          startTime: "2026-07-22T15:00:00.000Z",
          timeZone: "America/Los_Angeles",
        },
      ],
      summary: createFallbackGpsSummary("020260722", logs, {
        dominantTimeZone: "America/Los_Angeles",
        rawCount: 2,
        segments: segmentGpsLogs(logs, []),
      }),
      timeline: ["8:00 AM–8:20 AM: at 37.8000, -122.4400"],
      timeZoneCoverage: [{ seconds: 1200, timeZone: "America/Los_Angeles" }],
      timeZoneFallbackUsed: false,
      warnings: [],
    });
  });
});
