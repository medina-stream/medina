import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"
import { dayHub, publishDay } from "./DayEvents.ts"

describe("day events hub", () => {
  test("published days reach subscribers in order", async () => {
    const program = Effect.gen(function*() {
      const subscription = yield* PubSub.subscribe(dayHub)
      yield* publishDay("2026-09-03")
      yield* publishDay("2026-09-02")
      return [yield* PubSub.take(subscription), yield* PubSub.take(subscription)]
    })
    expect(await Effect.runPromise(program.pipe(Effect.scoped))).toEqual(["2026-09-03", "2026-09-02"])
  })
})
