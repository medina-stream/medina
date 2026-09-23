/**
 * One-shot backfill: feed historical capture location data into the GPS
 * inbox so the day path covers days before the live consumer shipped.
 *
 * Reads every install's `events/` envelopes (location.fix) and sealed
 * `location/` batches from the source bucket, converts them to GPS points,
 * and writes one inbox file per (install, UTC day). The hourly gps-compact
 * folds them into day partitions; compaction de-duplicates on
 * (source, ts, lat, lon), so this is safe to re-run.
 *
 * Run on the Medina host:
 *
 *   bun scripts/backfill-gps-inbox.ts
 */
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { SourceBucket, sourceLayer } from "../lib/Bucket.ts"
import { parseDeviceEvent, parseLocationFixPayload } from "../lib/capture/DeviceEvents.ts"
import { gpsInboxWrite } from "../lib/lifelog/Gps.ts"

interface RawPoint {
  readonly source: string
  readonly ts: Date
  readonly lat: number
  readonly lon: number
  readonly acc: number | null
  readonly raw: string
}

const downloadJson = (bucket: { download: (key: string) => Effect.Effect<Stream.Stream<Uint8Array>, Error> }, key: string) =>
  Effect.gen(function*() {
    const bytes = yield* bucket.download(key).pipe(Effect.flatMap(Stream.runCollect))
    return JSON.parse(Buffer.concat([...bytes] as Uint8Array[]).toString("utf-8")) as unknown
  })

const program = Effect.gen(function*() {
  const bucket = yield* SourceBucket
  const roots = yield* bucket.list("capture/", 10_000)
  const installs = [...new Set(
    roots.map((object) => object.key.split("/")[1]).filter((segment): segment is string => !!segment)
  )]
  console.log(`installs: ${installs.join(", ")}`)

  const points: Array<RawPoint> = []
  for (const install of installs) {
    // Current per-fix events.
    const events = yield* bucket.list(`capture/${install}/events/`, 50_000)
    let eventFixes = 0
    for (const object of events) {
      const raw = yield* downloadJson(bucket, object.key).pipe(
        Effect.orElseSucceed(() => null)
      )
      if (raw === null) continue
      const event = parseDeviceEvent(raw)
      if (event === null || event.type !== "location.fix") continue
      const fix = parseLocationFixPayload(event.payload)
      if (fix === null || fix.mock) continue
      points.push({
        source: `capture/${install}`,
        ts: new Date(event.at),
        lat: fix.lat,
        lon: fix.lon,
        acc: fix.accuracyM,
        raw: JSON.stringify({ id: event.id, device: event.device, seq: event.seq, at: event.at, type: event.type, payload: event.payload })
      })
      eventFixes++
    }
    // Legacy sealed location batches.
    const batches = yield* bucket.list(`capture/${install}/location/`, 50_000)
    let batchFixes = 0
    for (const object of batches) {
      const raw = yield* downloadJson(bucket, object.key).pipe(
        Effect.orElseSucceed(() => null)
      )
      const locations = typeof raw === "object" && raw !== null && Array.isArray((raw as { locations?: unknown }).locations)
        ? (raw as { locations: Array<unknown> }).locations
        : []
      locations.forEach((location, index) => {
        if (typeof location !== "object" || location === null) return
        const entry = location as Record<string, unknown>
        const lat = entry["latitude"]
        const lon = entry["longitude"]
        const timestamp = entry["timestamp"]
        if (typeof lat !== "number" || typeof lon !== "number" || typeof timestamp !== "string") return
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return
        const ts = new Date(timestamp)
        if (!Number.isFinite(ts.getTime())) return
        const accuracy = entry["accuracy"]
        points.push({
          source: `capture/${install}/location-batch`,
          ts,
          lat,
          lon,
          acc: typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null,
          raw: JSON.stringify({ batch: object.key, index, timestamp, latitude: lat, longitude: lon })
        })
        batchFixes++
      })
    }
    console.log(`${install}: ${eventFixes} event fixes, ${batchFixes} batch fixes`)
  }

  // One inbox file per (source, UTC day) keeps the inbox tidy.
  const byDay = new Map<string, Array<RawPoint>>()
  for (const point of points) {
    const key = `${point.source}|${point.ts.toISOString().slice(0, 10)}`
    const group = byDay.get(key)
    if (group) group.push(point)
    else byDay.set(key, [point])
  }
  let written = 0
  for (const group of byDay.values()) {
    written += yield* gpsInboxWrite(group.map((point) => ({
      source: point.source,
      ts: point.ts,
      lat: point.lat,
      lon: point.lon,
      speed: null,
      alt: null,
      acc: point.acc,
      batt: null,
      raw: point.raw
    })))
  }
  console.log(`backfill wrote ${written} points in ${byDay.size} inbox files`)
})

BunRuntime.runMain(program.pipe(Effect.provide(sourceLayer), Effect.provide(BunServices.layer)))
