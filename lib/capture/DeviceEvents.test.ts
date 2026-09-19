import { describe, expect, test } from "bun:test"
import { deviceEventObjects, parseDeviceEvent, parseLocationFixPayload } from "./DeviceEvents.ts"

const obj = (key: string) => ({ key, lastModified: "2026-09-19T00:00:00Z", etag: "abc", size: 100 })

describe("deviceEventObjects", () => {
  test("picks up event JSON and ignores everything else", () => {
    const items = deviceEventObjects([
      obj("install-1/events/2026/09/19/20260919T003000Z-uuid.json"),
      obj("install-1/audio/2026/09/19/20260919T003000Z-uuid.m4a"),
      obj("install-1/location/2026/09/19/20260919T003000Z-uuid.json"),
      obj("install-1/transcript/2026/09/19/x.live.json"),
    ])
    expect(items.map((i) => i.key)).toEqual([
      "install-1/events/2026/09/19/20260919T003000Z-uuid.json",
    ])
  })
})

describe("parseDeviceEvent", () => {
  const valid = {
    schemaVersion: 1,
    id: "7c6e2ede-93e5-4350-8376-6c153a0d33da",
    device: "install-1",
    seq: 42,
    at: "2026-09-19T00:30:00.000Z",
    type: "location.fix",
    payload: { lat: 37.77, lon: -122.41, accuracyM: 8 },
  }
  test("accepts a well-formed event", () => {
    const parsed = parseDeviceEvent(valid)
    expect(parsed?.type).toBe("location.fix")
    expect(parsed?.seq).toBe(42)
  })
  test("accepts unknown future types (router decides)", () => {
    expect(parseDeviceEvent({ ...valid, type: "place.arrived" })?.type).toBe("place.arrived")
  })
  test("rejects wrong schema version", () => {
    expect(parseDeviceEvent({ ...valid, schemaVersion: 2 })).toBeNull()
  })
  test("rejects bad timestamp", () => {
    expect(parseDeviceEvent({ ...valid, at: "not-a-time" })).toBeNull()
  })
  test("rejects missing identity fields", () => {
    const { id, ...noId } = valid
    expect(parseDeviceEvent(noId)).toBeNull()
    const { device, ...noDevice } = valid
    expect(parseDeviceEvent(noDevice)).toBeNull()
  })
})

describe("parseLocationFixPayload", () => {
  const valid = {
    lat: 37.7749,
    lon: -122.4194,
    accuracyM: 8,
    speedMps: 3.2,
    bearingDeg: 140,
    mock: false,
    activity: { type: "walking", confidence: 87 },
  }
  test("accepts a full fix payload", () => {
    const parsed = parseLocationFixPayload(valid)
    expect(parsed?.lat).toBe(37.7749)
    expect(parsed?.activityType).toBe("walking")
    expect(parsed?.activityConfidence).toBe(87)
  })
  test("tolerates missing optionals, defaults activity to unknown", () => {
    const parsed = parseLocationFixPayload({ lat: 1, lon: 2, accuracyM: 50 })
    expect(parsed?.speedMps).toBeNull()
    expect(parsed?.activityType).toBe("unknown")
    expect(parsed?.mock).toBe(false)
  })
  test("rejects out-of-range coordinates", () => {
    expect(parseLocationFixPayload({ ...valid, lat: 91 })).toBeNull()
    expect(parseLocationFixPayload({ ...valid, lon: -181 })).toBeNull()
  })
  test("rejects missing coordinates", () => {
    expect(parseLocationFixPayload({ accuracyM: 8 })).toBeNull()
  })
})
