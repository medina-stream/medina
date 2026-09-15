import { describe, expect, test } from "bun:test"
import { captureBucketObjects, CAPTURE_BUCKET_SOURCE_NAME } from "./CaptureBucket.ts"
import type { BucketObject } from "../Bucket.ts"

const object = (key: string, overrides: Partial<BucketObject> = {}): BucketObject => ({
  key,
  size: 1024,
  etag: "abc123",
  lastModified: "2026-09-15T03:00:00.000Z",
  ...overrides
})

describe("captureBucketObjects", () => {
  test("maps an audio key to an audio recording object", () => {
    const recording = captureBucketObjects([
      object("550e8400-e29b-41d4-a716-446655440000/audio/2026/09/15/20260915T030000-uuid.m4a")
    ])[0]!
    expect(recording.id).toBe("550e8400-e29b-41d4-a716-446655440000/audio/2026/09/15/20260915T030000-uuid.m4a")
    expect(recording.name).toBe("20260915T030000-uuid.m4a")
    expect(recording.mimeType).toBe("audio/mp4")
    expect(recording.modifiedTime).toBe("2026-09-15T03:00:00.000Z")
    expect(recording.checksum).toBe("abc123")
  })

  test("drops settings-validation probe objects", () => {
    const recordings = captureBucketObjects([
      object("probe/550e8400-e29b-41d4-a716-446655440000", { size: 0, etag: "d41d8cd98f00b204e9800998ecf8427e" }),
      object("install-1/audio/2026/09/15/20260915T030000-uuid.m4a")
    ])
    expect(recordings.map((r) => r.id)).toEqual(["install-1/audio/2026/09/15/20260915T030000-uuid.m4a"])
  })

  test("marks non-audio keys so ingest skips them without downloading", () => {
    const recording = captureBucketObjects([
      object("install-1/location/2026/09/15/20260915T030000-uuid.json")
    ])[0]!
    expect(recording.mimeType).toBe("application/octet-stream")
  })

  test("handles a null etag and null lastModified", () => {
    const recording = captureBucketObjects([
      object("install-1/audio/2026/09/15/x.m4a", { etag: null, lastModified: null })
    ])[0]!
    expect(recording.checksum).toBeUndefined()
    expect(recording.modifiedTime).toBe(new Date(0).toISOString())
  })

  test("source name is stable", () => {
    expect(CAPTURE_BUCKET_SOURCE_NAME).toBe("capture-bucket")
  })
})
