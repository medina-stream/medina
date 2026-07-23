import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryBucket } from "../lib/bucket.test";
import { runResource } from "../lib/resource";
import type { Bucket } from "../lib/bucket";
import { createGpsHour, getGpsHourKey } from "./gps-hour";
import { gpsDefinition, type GpsLog } from "./gps";
import {
  createGpsMapSvg,
  getGpsBounds,
  getGpsMapImageKey,
  getGpsMapSvgKey,
  getGpsStaticMapUrl,
  getMapboxStaticMapUrl,
  gpsMapImageDefinition,
  gpsMapSvgDefinition,
} from "./gps-map";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const tinyPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

async function writeHour(bucket: Bucket, hourId: string, logs: GpsLog[]) {
  await bucket.write(getGpsHourKey(hourId), `${JSON.stringify(createGpsHour(hourId, logs), null, 2)}\n`, {
    type: "application/json; charset=utf-8",
  });
}

describe("gps map resources", () => {
  let bucket: Bucket;

  beforeEach(async () => {
    process.env = { ...originalEnv, MEDINA_GPS_SUMMARY_MODE: "off", MEDINA_STATIC_MAP_URL_TEMPLATE: "https://maps.example/static?bbox={west},{south},{east},{north}&size={width}x{height}" };
    bucket = createMemoryBucket();
    await writeHour(bucket, "02026062512", [
      { ingestKey: "in/a", latitude: 37.8, longitude: -122.44, speed: 0, time: "2026-06-25T12:00:00.000Z", timeZone: "America/Los_Angeles" },
      { ingestKey: "in/b", latitude: 37.81, longitude: -122.42, speed: 1, time: "2026-06-25T12:30:00.000Z", timeZone: "America/Los_Angeles" },
    ]);
    await runResource(gpsDefinition, { bucket, inputKey: "020260625", now: new Date("2026-06-25T13:00:00.000Z") });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("computes padded bounds and static map URLs", () => {
    const bounds = getGpsBounds([
      { ingestKey: "in/a", latitude: 37.8, longitude: -122.44, speed: 0, time: "2026-06-25T12:00:00.000Z", timeZone: "America/Los_Angeles" },
      { ingestKey: "in/b", latitude: 37.81, longitude: -122.42, speed: 1, time: "2026-06-25T12:30:00.000Z", timeZone: "America/Los_Angeles" },
    ]);

    expect(bounds).toEqual({
      east: -122.417,
      north: 37.8115,
      south: 37.7985,
      west: -122.443,
    });
    expect(getGpsStaticMapUrl(bounds, { height: 256, template: "bbox={west},{south},{east},{north}&size={width}x{height}", width: 512 })).toBe("bbox=-122.443,37.7985,-122.417,37.8115&size=512x256");
  });

  test("builds Mapbox static image URLs when a token is available", () => {
    const url = getMapboxStaticMapUrl(
      { east: -122.417, north: 37.8115, south: 37.7985, west: -122.443 },
      { height: 512, token: "pk.test", width: 512 },
    );

    expect(url).toContain("https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/[-122.443000,37.798500,-122.417000,37.811500]/512x512@2x");
    expect(url).toContain("padding=80");
    expect(url).toContain("access_token=pk.test");
  });

  test("materializes a static map image from the configured map provider", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(tinyPng, { headers: { "content-type": "image/png" }, status: 200 });
    }) as typeof fetch;

    const result = await runResource(gpsMapImageDefinition, { bucket, inputKey: "020260625" });

    expect(result.outputs).toEqual([getGpsMapImageKey("020260625")]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("https://maps.example/static?bbox=");
    expect(new Uint8Array(await bucket.readArrayBuffer("020260625/map.png"))).toEqual(tinyPng);
    expect((await bucket.stat("020260625/map.png")).type).toBe("image/png");
  });

  test("wraps the map png in an SVG path overlay with per-point local labels", async () => {
    await bucket.write("020260625/map.png", tinyPng, { type: "image/png" });

    const result = await runResource(gpsMapSvgDefinition, { bucket, inputKey: "020260625" });

    expect(result.outputs).toEqual([getGpsMapSvgKey("020260625")]);
    const svg = await bucket.readText("020260625/map.svg");
    expect(svg).toContain("<image href=\"data:image/png;base64,");
    expect(svg).toContain("<polyline points=");
    expect(svg).toContain("<circle");
    expect(svg).toContain("class=\"gps-callout\"");
    expect(svg).toContain(">05:00</text>");
    expect(svg).toContain(">05:30</text>");
    expect((await bucket.stat("020260625/map.svg")).type).toBe("image/svg+xml; charset=utf-8");
  });

  test("creates SVG directly", () => {
    const svg = createGpsMapSvg({
      bounds: { east: -122.417, north: 37.8115, south: 37.7985, west: -122.443 },
      imageData: tinyPng.buffer,
      intervalId: "020260625",
      logs: [
        { ingestKey: "in/a", latitude: 37.8, longitude: -122.44, speed: 0, time: "2026-06-25T12:00:00.000Z", timeZone: "America/Los_Angeles" },
        { ingestKey: "in/b", latitude: 37.81, longitude: -122.42, speed: 1, time: "2026-06-25T12:30:00.000Z", timeZone: "America/New_York" },
      ],
      height: 100,
      width: 100,
    });
    expect(svg).toContain("viewBox=\"0 0 100 100\"");
    expect(svg).toContain("class=\"gps-callout\"");
  });
});
