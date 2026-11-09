/**
 * The GPS points store through the artifact-store seam: inbox writes,
 * compaction, day queries, and stays — all against an in-memory store
 * with nothing on local disk.
 *
 * The regression this pins: Gps.ts and the GPS halves of Stays.ts /
 * Movement.ts used raw filesystem calls on `dataPath(...)` while every
 * other artifact had moved to the bucket store, so the points store
 * silently stayed on medina-dev's local disk after the milestone-3
 * flip (and the Worker's capture loop wrote device-event fixes into a
 * bucket inbox nothing compacted). The Nov 9, 2026 seam fix routes the
 * whole subtree through `Files.*`; DuckDB works on scratch
 * materializations of the store artifacts.
 */
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { ArtifactStore, makeMemory } from "../ArtifactStore.ts"
import * as Files from "../Files.ts"
import { DATA_DIR, dataPath } from "./Resources.ts"
import { GpsPoint, gpsCompactSource, gpsDay, gpsInboxWrite, gpsPartitionKey } from "./Gps.ts"
import { readStaysBasis, staysSource } from "./Stays.ts"
import { resetFileHashCacheForTest } from "./FileHashes.ts"

const point = (ts: string, lat = 37.0, lon = -122.0) =>
  new GpsPoint({ source: "test", ts, lat, lon, speed: null, alt: null, acc: null, batt: null, raw: "{}" })

describe("gps store seam", () => {
  test("inbox -> compaction -> day query -> stays, entirely in the store", async () => {
    resetFileHashCacheForTest()
    const memory = makeMemory(DATA_DIR)
    const layers = Layer.mergeAll(BunFileSystem.layer, Layer.succeed(ArtifactStore, memory.api))
    const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<A, E, never>)

    // Three fixes at one spot on Jan 15, one on Jan 16.
    await run(gpsInboxWrite([
      point("2026-01-15T10:00:00.000Z"),
      point("2026-01-15T10:10:00.000Z"),
      point("2026-01-15T10:20:00.000Z"),
      point("2026-01-16T09:00:00.000Z", 37.5, -122.5)
    ]))
    expect(await run(Files.listFiles(dataPath("gps/inbox")))).toHaveLength(1)

    const compacted = await run(gpsCompactSource.ingest)
    expect(compacted.failures).toEqual([])
    expect(compacted.discovered).toBe(1)
    expect(compacted.ingested).toBe(2)
    // The inbox is consumed and both partitions are store artifacts.
    expect(await run(Files.listFiles(dataPath("gps/inbox")))).toHaveLength(0)
    expect(await run(Files.exists(dataPath(gpsPartitionKey("2026-01-15"))))).toBe(true)
    expect(await run(Files.exists(dataPath(gpsPartitionKey("2026-01-16"))))).toBe(true)

    const day = await run(gpsDay("2026-01-15"))
    expect(day.map((row) => row.ts)).toEqual([
      "2026-01-15T10:00:00.000Z",
      "2026-01-15T10:10:00.000Z",
      "2026-01-15T10:20:00.000Z"
    ])

    // Stays: the three clustered fixes are one stay, the lone Jan 16 fix
    // is a single-point stay of its own; the basis record and the stays
    // partitions land in the store; a second run is cached.
    const stays = await run(staysSource.ingest)
    expect(stays.failures).toEqual([])
    const basis = await run(readStaysBasis)
    expect(basis.stays).toBe(2)
    expect(basis.days).toBe(2)
    expect(await run(Files.exists(dataPath("gps/stays-v1/day=2026-01-15/stays.parquet")))).toBe(true)
    const again = await run(staysSource.ingest)
    expect(again.cached).toBe(1)

    // A late fix joins the same stay: compaction merges it into the
    // existing partition (dedupe keeps the count honest), and the stays
    // basis moves so stays recompute with point_count 4.
    await run(gpsInboxWrite([point("2026-01-15T10:30:00.000Z")]))
    const recompacted = await run(gpsCompactSource.ingest)
    expect(recompacted.failures).toEqual([])
    expect(await run(gpsDay("2026-01-15"))).toHaveLength(4)
    const restays = await run(staysSource.ingest)
    expect(restays.failures).toEqual([])
    expect(restays.cached).toBe(0)
    expect((await run(readStaysBasis)).stays).toBe(2)
  })
})
