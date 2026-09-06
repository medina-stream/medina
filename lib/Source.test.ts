import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { makeItemSource } from "./Source.ts"

describe("makeItemSource", () => {
  test("isolates item failures and reports every outcome", async () => {
    const source = makeItemSource({
      name: "things",
      discover: Effect.succeed(["new", "old", "ignored", "broken"]),
      label: (item) => item,
      concurrency: 2,
      ingest: (item) => item === "broken"
        ? Effect.fail(new Error("boom"))
        : Effect.succeed(item === "new" ? "ingested" : item === "old" ? "cached" : "skipped")
    })
    const report = await Effect.runPromise(source.ingest)
    expect(report).toMatchObject({ discovered: 4, ingested: 1, cached: 1, skipped: 1 })
    expect(report.failures).toEqual([{ item: "broken", error: expect.stringContaining("boom") }])
  })
})
