import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { Bucket, layerMemory, topNewest, type BucketObject } from "./Bucket.ts"

const object = (key: string, lastModified: string | null): BucketObject => ({
  key, size: 1, etag: `etag-${key}`, lastModified
})

describe("topNewest", () => {
  test("keeps only the newest `limit`, newest-first", () => {
    const objects = [
      object("old", "2026-09-01T00:00:00.000Z"),
      object("new", "2026-09-03T00:00:00.000Z"),
      object("mid", "2026-09-02T00:00:00.000Z"),
      object("unknown", null)
    ]
    expect(topNewest(objects, 2).map((entry) => entry.key)).toEqual(["new", "mid"])
    expect(topNewest(objects, 0)).toEqual([])
  })
})

describe("memory bucket list", () => {
  test("bounds the listing to the limit", async () => {
    const store = new Map<string, { bytes: Uint8Array }>()
    for (const key of ["p/a", "p/b", "p/c", "q/d"]) store.set(key, { bytes: new Uint8Array([1]) })
    const listed = await Effect.runPromise(
      Effect.flatMap(Bucket, (bucket) => bucket.list("p/", 2)).pipe(Effect.provide(layerMemory(store)))
    )
    expect(listed).toHaveLength(2)
    expect(listed.every((entry) => entry.key.startsWith("p/"))).toBe(true)
  })
})
