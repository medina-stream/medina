import { BunFileSystem } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  makeBucket,
  makeLocal,
  makeMemoryIndexClient,
  makeMemoryObjectStore
} from "./ArtifactStore.ts"
import { migrateArtifacts, type MigrationSummary } from "./MigrateArtifacts.ts"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const FIXTURES: Record<string, Uint8Array> = {
  "capture/aaa111/blob.m4a": new Uint8Array(2048).map((_, i) => i % 251),
  "capture/aaa111/provenance.json": new TextEncoder().encode(JSON.stringify({ source: "test" })),
  "journal/journal-v12/2026-01-01/deadbeef.json": new TextEncoder().encode("{\"report\":\"x\"}"),
  "star/s1.json": new TextEncoder().encode("{\"id\":\"s1\"}"),
  "transcript/assemblyai-u35p-v1/aaa111.json": new TextEncoder().encode("{\"text\":\"hi\"}")
}

const fixtureRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "medina-migrate-src-"))
  for (const [key, bytes] of Object.entries(FIXTURES)) {
    const path = join(root, key)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }
  return root
}

const setup = async () => {
  const root = fixtureRoot()
  const local = await Effect.runPromise(makeLocal(root).pipe(Effect.provide(BunFileSystem.layer)))
  const objects = makeMemoryObjectStore()
  const index = makeMemoryIndexClient()
  const bucket = makeBucket({ objects, index, pathRoot: root })
  return { root, local, bucket, index, objects }
}

const migrate = (
  stores: Awaited<ReturnType<typeof setup>>,
  options?: Parameters<typeof migrateArtifacts>[3]
): Promise<MigrationSummary> =>
  run(migrateArtifacts(stores.local, stores.bucket, stores.index, { log: () => {}, ...options }))

describe("migrateArtifacts", () => {
  test("copies every fixture, registers every key, and verifies by hash", async () => {
    const stores = await setup()
    // A 1 KiB threshold drives the .m4a fixture down the putFile branch.
    const summary = await migrate(stores, { sampleSize: 10, putFileThresholdBytes: 1024 })
    expect(summary.scanned).toBe(5)
    expect(summary.uploaded).toBe(5)
    expect(summary.skipped).toBe(0)
    expect(summary.failures).toEqual([])
    expect(summary.byPrefix).toEqual({
      capture: { count: 2, bytes: 2048 + FIXTURES["capture/aaa111/provenance.json"]!.length },
      journal: { count: 1, bytes: FIXTURES["journal/journal-v12/2026-01-01/deadbeef.json"]!.length },
      star: { count: 1, bytes: FIXTURES["star/s1.json"]!.length },
      transcript: { count: 1, bytes: FIXTURES["transcript/assemblyai-u35p-v1/aaa111.json"]!.length }
    })
    expect(summary.bytesTotal).toBe(Object.values(FIXTURES).reduce((sum, b) => sum + b.length, 0))
    expect(summary.verification).toEqual({ sampled: 5, hashMatched: 5, sizeVerified: 0, mismatches: [] })
    expect(await run(stores.index.list(""))).toEqual(Object.keys(FIXTURES).sort())
    for (const [key, bytes] of Object.entries(FIXTURES)) {
      const got = await run(stores.bucket.getBytes(key))
      expect(Option.isSome(got) && [...got.value]).toEqual([...bytes])
    }
  })

  test("a second run is a no-op: everything skips, nothing re-uploads", async () => {
    const stores = await setup()
    await migrate(stores, { putFileThresholdBytes: 1024 })
    const second = await migrate(stores, { putFileThresholdBytes: 1024 })
    expect(second.scanned).toBe(5)
    expect(second.uploaded).toBe(0)
    expect(second.skipped).toBe(5)
    expect(second.bytesUploaded).toBe(0)
    expect(second.failures).toEqual([])
  })

  test("dry-run reports the work and writes nothing", async () => {
    const stores = await setup()
    const summary = await migrate(stores, { dryRun: true })
    expect(summary.dryRun).toBe(true)
    expect(summary.wouldUpload).toBe(5)
    expect(summary.uploaded).toBe(0)
    expect(summary.verification.sampled).toBe(0)
    expect(await run(stores.index.list(""))).toEqual([])
    expect(await run(stores.bucket.list(""))).toEqual([])
  })

  test("a prefix scopes the run", async () => {
    const stores = await setup()
    const summary = await migrate(stores, { prefix: "star" })
    expect(summary.scanned).toBe(1)
    expect(summary.uploaded).toBe(1)
    expect(await run(stores.index.list(""))).toEqual(["star/s1.json"])
  })
})
