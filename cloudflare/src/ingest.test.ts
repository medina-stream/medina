/**
 * Tests for the push-ingest port (src/ingest.ts): parse parity
 * against the server's own parseGpsBody (imported from lib), and
 * the handler's two ingest paths against a fake bucket — inbox
 * file shape, capture blob + provenance, duplicate detection, and
 * the 400s. The live evidence is the rehearsal against the real
 * bucket (see docs/cloudflare-migration.md §4.3 step 11).
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { parseGpsBody as serverParseGpsBody } from "../../lib/lifelog/Gps.ts";
import { handleIn, parseGpsBody, type IngestBucket } from "./ingest.ts";

const BODIES: Array<[string, string]> = [
  [
    "gpslogger form",
    "lat=37.7749&lon=-122.4194&time=2026-11-09T12%3A00%3A00.000Z&s=1.5&alt=10&acc=5&batt=0.87",
  ],
  [
    "gpslogger epoch seconds",
    "lat=37.7749&longitude=-122.4194&tst=1762732800&vel=0&altitude=3&accuracy=8&battery=55",
  ],
  [
    "overland",
    JSON.stringify({
      locations: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-122.4194, 37.7749] },
          properties: {
            timestamp: "2026-11-09T12:00:00.000Z",
            speed: 2,
            altitude: 12,
            horizontal_accuracy: 4,
            battery_level: 0.5,
          },
        },
      ],
    }),
  ],
  [
    "owntracks",
    JSON.stringify({
      _type: "location",
      lat: 37.7749,
      lon: -122.4194,
      tst: 1762732800,
      acc: 6,
      alt: 9,
      vel: 1,
      batt: 61,
    }),
  ],
  ["flat json", JSON.stringify({ lat: 1.5, lon: 2.5, time: 1762732800000 })],
  ["not gps", "hello medina"],
  ["form without lat", "lon=-122.4194&time=1762732800"],
  ["empty-ish json", "{}"],
];

describe("parseGpsBody parity with the server", () => {
  for (const [name, body] of BODIES) {
    test(name, () => {
      const server = serverParseGpsBody("gps-gpslogger", body);
      const mine = parseGpsBody("gps-gpslogger", body);
      if (server === null) {
        expect(mine).toBeNull();
        return;
      }
      expect(mine).not.toBeNull();
      expect(mine!.length).toBe(server.length);
      for (let i = 0; i < server.length; i++) {
        const s = server[i]!;
        const m = mine![i]!;
        expect(m.source).toBe(s.source);
        expect(m.ts).toBe(s.ts as unknown as string);
        expect(m.lat).toBe(s.lat);
        expect(m.lon).toBe(s.lon);
        expect(m.speed).toBe(s.speed);
        expect(m.alt).toBe(s.alt);
        expect(m.acc).toBe(s.acc);
        expect(m.batt).toBe(s.batt);
        expect(m.raw).toBe(s.raw);
      }
    });
  }
});

const makeFakeBucket = () => {
  const objects = new Map<string, Uint8Array>();
  const bucket: IngestBucket = {
    get: async (key) => {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        body: new ReadableStream({
          start: (controller) => {
            controller.enqueue(value);
            controller.close();
          },
        }),
        size: value.length,
        httpEtag: '"fake"',
        arrayBuffer: async () => value.slice().buffer as ArrayBuffer,
      };
    },
    put: async (key, value) => {
      objects.set(
        key,
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : value,
      );
    },
  };
  return { bucket, objects };
};

const post = (
  bucket: IngestBucket,
  body: string,
  url = "https://sco.medina.stream/in",
  contentType = "application/x-www-form-urlencoded",
) =>
  Effect.runPromise(
    handleIn(
      bucket,
      new Request(url, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      }),
      new URL(url),
    ),
  );

describe("handleIn", () => {
  test("a GPS form post lands as one inbox NDJSON file", async () => {
    const { bucket, objects } = makeFakeBucket();
    const response = await post(
      bucket,
      "lat=37.7749&lon=-122.4194&time=2026-11-09T12%3A00%3A00.000Z&s=1.5",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, points: 1 });
    const keys = [...objects.keys()];
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/^gps\/inbox\/\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{8}\.ndjson$/);
    const line = new TextDecoder().decode(objects.get(keys[0]!));
    const row = JSON.parse(line.trim());
    expect(row.source).toBe("gps-gpslogger");
    expect(row.lat).toBe(37.7749);
    expect(row.lon).toBe(-122.4194);
    expect(row.speed).toBe(1.5);
  });

  test("a non-GPS body lands as a capture with provenance; a repost is a duplicate", async () => {
    const { bucket, objects } = makeFakeBucket();
    const url = "https://sco.medina.stream/in?source=notes-drop";
    const first = await post(bucket, "hello medina", url, "text/plain");
    const firstBody = (await first.json()) as {
      ok: boolean;
      captureId: string;
      duplicate: boolean;
    };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.duplicate).toBe(false);
    const blobKeys = [...objects.keys()].filter((key) =>
      key.startsWith(`capture/${firstBody.captureId}/`),
    );
    expect(blobKeys.length).toBe(2); // blob + provenance.json
    const provenance = JSON.parse(
      new TextDecoder().decode(
        objects.get(`capture/${firstBody.captureId}/provenance.json`),
      ),
    );
    expect(provenance.records.length).toBe(1);
    expect(provenance.records[0].source).toBe("http-notes-drop");
    expect(provenance.records[0].mimeType).toBe("text/plain");

    const second = await post(bucket, "hello medina", url, "text/plain");
    const secondBody = (await second.json()) as { duplicate: boolean };
    expect(secondBody.duplicate).toBe(true);
    const provenanceAfter = JSON.parse(
      new TextDecoder().decode(
        objects.get(`capture/${firstBody.captureId}/provenance.json`),
      ),
    );
    expect(provenanceAfter.records.length).toBe(2);
  });

  test("empty body and bad source are 400s", async () => {
    const { bucket } = makeFakeBucket();
    const empty = await post(bucket, "");
    expect(empty.status).toBe(400);
    const badSource = await post(
      bucket,
      "x",
      "https://sco.medina.stream/in?source=Bad_Source",
    );
    expect(badSource.status).toBe(400);
  });
});
