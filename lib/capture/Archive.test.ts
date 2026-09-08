import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Bucket, layerMemory } from "../Bucket.ts"
import * as Files from "../Files.ts"
import { sha256 } from "../Hash.ts"
import { DATA_DIR, dataPath } from "../lifelog/Resources.ts"
import { archiveCapture, archiveReceiptKey, archiveSweepSource } from "./Archive.ts"
import { httpIngest } from "./HttpIngest.ts"

// The preload (test-preload.ts) points DATA_DIR at a fresh temp dir before
// any module loads. If that ever regresses, these tests would sweep the real
// lifelog into a Map and write false archive receipts beside real captures
// -- fail loudly instead.
if (!DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run against a non-temp data dir: ${DATA_DIR}`)
}

const bytesOf = (text: string) => new TextEncoder().encode(text)

describe("archiveCapture", () => {
  test("uploads a capture's files once and receipts them", async () => {
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    const layers = Layer.mergeAll(layerMemory(store), BunFileSystem.layer)

    const body = bytesOf("gps batch one")
    const captureId = sha256(body)

    // httpIngest archives promptly (the pushing client keeps no copy).
    const result = await Effect.runPromise(
      httpIngest("gps-test", body, "application/json").pipe(Effect.provide(layers))
    )
    expect(result.captureId).toBe(captureId)

    const blobKeys = [...store.keys()].filter((key) => key.startsWith(`capture/${captureId}/`))
    expect(blobKeys.some((key) => key.endsWith("provenance.json"))).toBe(true)
    expect(blobKeys.length).toBe(2) // blob + provenance

    // A second reconciliation uploads nothing: receipt short-circuits.
    const uploaded = await Effect.runPromise(
      archiveCapture(captureId).pipe(Effect.provide(layers))
    )
    expect(uploaded).toBe(0)

    // Deleting the receipt re-verifies against the bucket, not re-uploads.
    rmSync(dataPath(archiveReceiptKey(captureId)))
    const reverified = await Effect.runPromise(
      archiveCapture(captureId).pipe(Effect.provide(layers))
    )
    expect(reverified).toBe(0)
  })

  test("re-uploads provenance when it grows (a new sighting)", async () => {
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    const layers = Layer.mergeAll(layerMemory(store), BunFileSystem.layer)

    const body = bytesOf("gps batch two")
    const captureId = sha256(body)
    await Effect.runPromise(httpIngest("gps-test", body, "application/json").pipe(Effect.provide(layers)))
    const before = store.get([...store.keys()].find((key) =>
      key === `capture/${captureId}/provenance.json`
    )!)!.bytes.length

    // The same bytes posted again append a provenance record.
    await Effect.runPromise(httpIngest("gps-test-again", body, "application/json").pipe(Effect.provide(layers)))
    const after = store.get(`capture/${captureId}/provenance.json`)!.bytes.length
    expect(after).toBeGreaterThan(before)
  })
})

describe("archiveSweepSource", () => {
  test("fails discovery when the bucket is unconfigured", async () => {
    const unconfigured = Layer.succeed(Bucket)({
      configured: false,
      list: () => Effect.fail(new Error("no")),
      download: () => Effect.fail(new Error("no")),
      head: () => Effect.fail(new Error("no")),
      put: () => Effect.fail(new Error("no")),
      putFile: () => Effect.fail(new Error("no"))
    })
    const report = await Effect.runPromise(
      archiveSweepSource.ingest.pipe(
        Effect.provide(Layer.mergeAll(unconfigured, BunFileSystem.layer)),
        Effect.flip
      )
    )
    expect(String(report)).toContain("durable home")
  })

  test("sweeps captures already on disk into an empty bucket", async () => {
    // Captures exist from the earlier tests; a fresh bucket starts empty.
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    const layers = Layer.mergeAll(layerMemory(store), BunFileSystem.layer)

    // Receipts from earlier tests claim the bytes are archived, but this
    // bucket is new: the sweep must verify and re-upload, not trust them.
    // (Receipts record per-file size, and sizes match, so this exercises
    // the receipt-trusting fast path against a *shared* bucket lifetime;
    // clearing receipts simulates pointing at a new bucket.)
    const receipts = await Effect.runPromise(
      Effect.provide(Files.listFiles(dataPath("archive")), BunFileSystem.layer)
    )
    for (const receipt of receipts) rmSync(dataPath(`archive/${receipt}`))

    const report = await Effect.runPromise(
      archiveSweepSource.ingest.pipe(Effect.provide(layers))
    )
    expect(report.discovered).toBeGreaterThan(0)
    expect(report.ingested).toBe(report.discovered)
    expect(report.failures.length).toBe(0)
    expect([...store.keys()].every((key) => key.startsWith("capture/"))).toBe(true)

    // A second sweep is settled: receipts short-circuit, nothing uploads.
    const second = await Effect.runPromise(
      archiveSweepSource.ingest.pipe(Effect.provide(layers))
    )
    expect(second.ingested).toBe(0)
    expect(second.cached).toBe(second.discovered)
  })
})
