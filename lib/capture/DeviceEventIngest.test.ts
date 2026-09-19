/**
 * End-to-end ingest test for device events, with a stub bucket API and a
 * temp DATA_DIR. Run with:
 *   DATA_DIR=$(mktemp -d) bun test lib/capture/DeviceEventIngest.test.ts
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Stream from "effect/Stream"
import { BunFileSystem } from "@effect/platform-bun"
import { deviceEventsSource, latestLocationKey, type LatestLocation } from "./DeviceEvents.ts"
import { dataPath } from "../lifelog/Resources.ts"
import type { SourceBucketApi } from "../Bucket.ts"

const dataDir = process.env["DATA_DIR"]
if (!dataDir || !dataDir.startsWith("/tmp/")) {
  throw new Error("refusing to run: set DATA_DIR to a temp dir, e.g. DATA_DIR=$(mktemp -d)")
}

const eventJson = JSON.stringify({
  schemaVersion: 1,
  id: "7c6e2ede-93e5-4350-8376-6c153a0d33da",
  device: "install-1",
  seq: 42,
  at: "2026-09-19T00:30:00.000Z",
  type: "location.fix",
  payload: {
    lat: 37.7749,
    lon: -122.4194,
    accuracyM: 8,
    speedMps: 3.2,
    bearingDeg: 140,
    mock: false,
    activity: { type: "walking", confidence: 87 }
  }
})

const stubApi = {
  configured: true,
  list: () =>
    Effect.succeed([
      { key: "install-1/events/2026/09/19/20260919T003000Z-uuid.json", size: eventJson.length, etag: "etag-1", lastModified: "2026-09-19T01:00:00Z" }
    ]),
  download: (_key: string) => Effect.succeed(Stream.fromIterable([Buffer.from(eventJson)])),
  head: (_key: string) => Effect.succeed(null)
} as unknown as SourceBucketApi

const live = BunFileSystem.layer
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/FileSystem").FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(live)) as Effect.Effect<A, E, never>)

const readLatest = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return JSON.parse(yield* fs.readFileString(dataPath(latestLocationKey("install-1")))) as LatestLocation
})

describe("device event ingest", () => {
  test("writes latest-location from a location.fix, then receipt-guards", async () => {
    const source = deviceEventsSource(stubApi, "install-1/", 25)
    const first = await run(source.ingest)
    expect(first.discovered).toBe(1)
    expect(first.ingested).toBe(1)

    const latest = await run(readLatest)
    expect(latest.lat).toBe(37.7749)
    expect(latest.lon).toBe(-122.4194)
    expect(latest.activityType).toBe("walking")
    expect(latest.activityConfidence).toBe(87)
    expect(latest.eventSeq).toBe(42)
    expect(latest.at).toBe("2026-09-19T00:30:00.000Z")

    const second = await run(source.ingest)
    expect(second.discovered).toBe(1)
    expect(second.ingested).toBe(0)
  })

  test("skips mock locations without touching latest-location", async () => {
    const mockJson = eventJson.replace("\"mock\":false", "\"mock\":true").replace("etag-1", "etag-2")
    const mockApi = {
      ...stubApi,
      list: () =>
        Effect.succeed([
          { key: "install-1/events/2026/09/19/20260919T003100Z-mock.json", size: mockJson.length, etag: "etag-2", lastModified: "2026-09-19T01:01:00Z" }
        ]),
      download: (_key: string) => Effect.succeed(Stream.fromIterable([Buffer.from(mockJson)]))
    } as unknown as SourceBucketApi
    const source = deviceEventsSource(mockApi, "install-1/", 25)
    const result = await run(source.ingest)
    expect(result.ingested).toBe(1)
    // Latest-location still holds the real fix from the previous test.
    const latest = await run(readLatest)
    expect(latest.eventSeq).toBe(42)
  })
})
