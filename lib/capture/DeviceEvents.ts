/**
 * Device events: the Android capture app (and future emitters) volunteer
 * small facts about themselves — currently `location.fix` — as individual
 * JSON objects under `<install-id>/events/YYYY/MM/DD/<utc>-<uuid>.json`.
 *
 * This is the durable, cross-realm counterpart to the in-process runtime
 * feed (docs/events-plan.md). Events are hints with an identity, not a
 * replica of client state: at-least-once with idempotent handling,
 * receipt-guarded like every other ingest source.
 *
 * Like the capture bucket source, this is ingest-only: the SourceBucket API
 * has no write operations.
 *
 * Phase 1 vocabulary: `location.fix` only. The router is a registry so new
 * types slot in without touching existing handling.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Stream from "effect/Stream"
import * as Files from "../Files.ts"
import type { BucketObject, SourceBucketApi } from "../Bucket.ts"
import type { Source } from "../Resource.ts"
import { makeItemSource } from "../Source.ts"
import { dataPath, IngestReceipt, ingestReceiptKey } from "../lifelog/Resources.ts"

export const DEVICE_EVENTS_SOURCE_NAME = "device-events"

/** Where the freshest known position per install lives (the UI's proof). */
export const latestLocationKey = (installId: string) => `state/latest-location/${installId}.json`

interface DeviceEventObject {
  readonly key: string
  readonly version: string
}

export const deviceEventObjects = (
  objects: ReadonlyArray<BucketObject>
): ReadonlyArray<DeviceEventObject> =>
  objects
    .filter((object) => object.key.includes("/events/") && object.key.endsWith(".json"))
    .map((object) => ({
      key: object.key,
      version: object.etag ?? object.lastModified ?? ""
    }))

interface LocationFixPayload {
  readonly lat: number
  readonly lon: number
  readonly accuracyM: number
  readonly speedMps: number | null
  readonly bearingDeg: number | null
  readonly mock: boolean
  readonly activityType: string
  readonly activityConfidence: number
}

interface DeviceEvent {
  readonly id: string
  readonly device: string
  readonly seq: number
  readonly at: string
  readonly type: string
  readonly payload: unknown
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null

/** Decode the envelope; return null for anything malformed. */
export const parseDeviceEvent = (raw: unknown): DeviceEvent | null => {
  if (!isRecord(raw)) return null
  if (raw["schemaVersion"] !== 1) return null
  const { id, device, seq, at, type, payload } = raw
  if (typeof id !== "string" || id.length === 0) return null
  if (typeof device !== "string" || device.length === 0) return null
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null
  if (typeof type !== "string" || type.length === 0) return null
  return { id, device, seq, at, type, payload }
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null

/** Decode a location.fix payload; null when it fails validation. */
export const parseLocationFixPayload = (payload: unknown): LocationFixPayload | null => {
  if (!isRecord(payload)) return null
  const lat = num(payload["lat"])
  const lon = num(payload["lon"])
  const accuracyM = num(payload["accuracyM"])
  if (lat === null || lon === null || accuracyM === null) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  const activity = isRecord(payload["activity"]) ? payload["activity"] : {}
  return {
    lat,
    lon,
    accuracyM,
    speedMps: num(payload["speedMps"]),
    bearingDeg: num(payload["bearingDeg"]),
    mock: payload["mock"] === true,
    activityType: typeof activity["type"] === "string" ? activity["type"] : "unknown",
    activityConfidence: num(activity["confidence"]) ?? 0
  }
}

export interface LatestLocation {
  readonly installId: string
  readonly lat: number
  readonly lon: number
  readonly accuracyM: number
  readonly speedMps: number | null
  readonly bearingDeg: number | null
  readonly activityType: string
  readonly activityConfidence: number
  readonly at: string
  readonly eventId: string
  readonly eventSeq: number
  readonly updatedAt: string
}

const ingestDeviceEvent = (
  api: SourceBucketApi,
  item: DeviceEventObject
): Effect.Effect<"ingested" | "cached" | "skipped", Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const receiptKey = dataPath(ingestReceiptKey(DEVICE_EVENTS_SOURCE_NAME, item.key, item.version))
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(receiptKey)) return "cached" as const

    const bytes = yield* (yield* api.download(item.key)).pipe(Stream.runCollect)
    const raw: unknown = JSON.parse(Buffer.concat([...bytes] as Uint8Array[]).toString("utf-8"))
    const event = parseDeviceEvent(raw)
    if (event === null) {
      yield* Effect.logWarning(`device event ${item.key} failed validation; recording receipt to skip`)
      yield* Files.writeJson(receiptKey, new IngestReceipt({ captureId: "", ingestedAt: new Date().toISOString() }))
      return "skipped" as const
    }

    yield* routeEvent(event)

    yield* Files.writeJson(
      receiptKey,
      new IngestReceipt({ captureId: event.id, ingestedAt: new Date().toISOString() })
    )
    return "ingested" as const
  })

/**
 * The router: one branch per event type. Unknown types are logged and
 * receipted (not retried) so a future emitter can't wedge the ingest.
 */
const routeEvent = (event: DeviceEvent): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    switch (event.type) {
      case "location.fix": {
        const fix = parseLocationFixPayload(event.payload)
        if (fix === null) {
          yield* Effect.logWarning(`location.fix ${event.id} failed payload validation; skipping`)
          return
        }
        // Mock locations never become the believed position.
        if (fix.mock) return
        const latest: LatestLocation = {
          installId: event.device,
          lat: fix.lat,
          lon: fix.lon,
          accuracyM: fix.accuracyM,
          speedMps: fix.speedMps,
          bearingDeg: fix.bearingDeg,
          activityType: fix.activityType,
          activityConfidence: fix.activityConfidence,
          at: event.at,
          eventId: event.id,
          eventSeq: event.seq,
          updatedAt: new Date().toISOString()
        }
        yield* Files.writeJson(dataPath(latestLocationKey(event.device)), latest)
        return
      }
      default:
        yield* Effect.logWarning(`unknown device event type ${event.type}; recording receipt to skip`)
    }
  })

/**
 * Build the pipeline source for device events. The api exposes no write
 * operations, so this source cannot store anything in the bucket --
 * ingest-only by construction.
 */
export const deviceEventsSource = (
  api: SourceBucketApi,
  prefix: string,
  limit: number
): Source<FileSystem.FileSystem> =>
  makeItemSource({
    name: DEVICE_EVENTS_SOURCE_NAME,
    discover: api.list(prefix, limit).pipe(Effect.map(deviceEventObjects)),
    ingest: (item) => ingestDeviceEvent(api, item),
    label: (item) => item.key,
    concurrency: "unbounded"
  })
