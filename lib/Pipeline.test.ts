import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makePipelineRuntime, runPipeline, runReportKey } from "./Pipeline.ts"
import type { Source } from "./Resource.ts"

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<A, E, never>)

const emptyReport = { discovered: 0, ingested: 0, cached: 0, skipped: 0, failures: [] }

describe("runPipeline loops", () => {
  test("named loops write separate reports and per-loop nextRunAt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "medina-pipeline-"))
    const dataPath = (key: string) => join(dir, key)
    const ingestRuntime = makePipelineRuntime()
    const inventoryRuntime = makePipelineRuntime()
    await run(runPipeline([], [], [], dataPath, { name: "ingest", cadenceMs: 60_000, runtime: ingestRuntime }))
    await run(runPipeline([], [], [], dataPath, { name: "inventory", cadenceMs: 3_600_000, runtime: inventoryRuntime }))

    expect(runReportKey("ingest")).toBe("runs/latest.json")
    expect(runReportKey("inventory")).toBe("runs/inventory/latest.json")
    const ingest = JSON.parse(readFileSync(dataPath("runs/latest.json"), "utf8"))
    const inventory = JSON.parse(readFileSync(dataPath("runs/inventory/latest.json"), "utf8"))
    expect(ingest.startedAt).toBeString()
    expect(inventory.startedAt).toBeString()
    expect(Date.parse(ingestRuntime.nextRunAt!) - Date.parse(ingestRuntime.lastFinishedAt!)).toBe(60_000)
    expect(Date.parse(inventoryRuntime.nextRunAt!) - Date.parse(inventoryRuntime.lastFinishedAt!)).toBe(3_600_000)
    expect(ingestRuntime.running).toBe(false)
    expect(inventoryRuntime.running).toBe(false)
  })

  test("a second pass of the same loop is skipped while one is running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "medina-pipeline-"))
    const dataPath = (key: string) => join(dir, key)
    const runtime = makePipelineRuntime()
    let calls = 0
    await run(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const source: Source<never> = {
        name: "slow",
        ingest: Effect.sync(() => { calls++ }).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as(emptyReport)
        )
      }
      const fiber = yield* Effect.forkChild(
        runPipeline<never>([{ name: "slow", source }], [], [], dataPath, { name: "ingest", cadenceMs: 1000, runtime })
      )
      // Let the first pass enter ingest, then attempt an overlapping pass.
      while (calls === 0) yield* Effect.yieldNow
      yield* runPipeline([{ name: "slow", source }], [], [], dataPath, { name: "ingest", cadenceMs: 1000, runtime })
      expect(calls).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(fiber)
    }))
    expect(calls).toBe(1)
    expect(runtime.running).toBe(false)
    expect(existsSync(dataPath("runs/latest.json"))).toBe(true)
  })

  test("different loops may run concurrently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "medina-pipeline-"))
    const dataPath = (key: string) => join(dir, key)
    let calls = 0
    const source: Source<never> = {
      name: "s",
      ingest: Effect.sync(() => { calls++ }).pipe(Effect.as(emptyReport))
    }
    await run(Effect.all([
      runPipeline([{ name: "s", source }], [], [], dataPath, { name: "ingest", cadenceMs: 1000, runtime: makePipelineRuntime() }),
      runPipeline([{ name: "s", source }], [], [], dataPath, { name: "inventory", cadenceMs: 1000, runtime: makePipelineRuntime() })
    ], { concurrency: 2 }))
    expect(calls).toBe(2)
  })
})
