import { BunFileSystem } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as Files from "../Files.ts"
import { readCachedInstance } from "../Resource.ts"
import { DATA_DIR, dataPath, Star, starForgetReceiptKey, starKey, StarsDay } from "./Resources.ts"
import {
  InvalidInterval,
  InvalidRetention,
  publicStarContentHash,
  publicStarFor,
  StarNotFound,
  Stars,
  StarsLive,
  starsResource
} from "./Stars.ts"
import { layerDefault as startTimeRulesLayer } from "./StartTimeRules.ts"

// The preload (test-preload.ts) points DATA_DIR at a fresh temp dir before
// any of these modules capture it; refuse to run anywhere else.
if (!DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run against a non-temp data dir: ${DATA_DIR}`)
}

const layers = Layer.mergeAll(StarsLive, BunFileSystem.layer)
const run = <A, E>(program: Effect.Effect<A, E, Stars | import("effect/FileSystem").FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.provide(layers)))

const failureOf = async <A, E>(program: Effect.Effect<A, E, Stars | import("effect/FileSystem").FileSystem>) => {
  const exit = await run(Effect.exit(program))
  if (Exit.isSuccess(exit)) throw new Error("expected the program to fail")
  return Cause.squash(exit.cause)
}

const base = {
  startUtc: "2026-01-01T11:55:00.000Z",
  endUtc: "2026-01-01T12:00:00.000Z",
  createdAt: "2026-01-01T12:00:05.000Z"
}

/** The forget receipt a star left behind, read raw so the test sees exactly
 * the fields on disk — no more, no fewer. Service-level forgets hash the
 * authored content with an empty evidence projection. */
const receiptFor = (star: Star): Record<string, unknown> => {
  const hash = publicStarContentHash(publicStarFor(star, [], null))
  return JSON.parse(readFileSync(dataPath(starForgetReceiptKey(hash)), "utf8")) as Record<string, unknown>
}

const RECEIPT_KEYS = ["contentHash", "createdAt", "deletedAt", "reason", "retentionSeconds"]

describe("stars", () => {
  test("the Star schema round-trips through JSON", () => {
    const star = new Star({
      id: "round-trip",
      ...base,
      name: "vet call",
      note: null,
      visibility: "public",
      retentionSeconds: 0.5,
      createdVia: "voice"
    })
    const decoded = Schema.decodeUnknownSync(Star)(JSON.parse(JSON.stringify(star)))
    expect(decoded).toEqual(star)
    const encoded = Schema.encodeSync(Star)(star)
    expect(encoded.retentionSeconds).toBe(0.5)
  })

  test("setStar rejects an empty or backwards interval", async () => {
    const error = await failureOf(Effect.gen(function*() {
      const stars = yield* Stars
      yield* stars.setStar({ id: "bad-interval", startUtc: base.endUtc, endUtc: base.startUtc, createdAt: base.createdAt })
    }))
    expect(error).toBeInstanceOf(InvalidInterval)
  })

  test("setStar rejects negative and non-finite retention, and only those", async () => {
    for (const retentionSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = await failureOf(Effect.gen(function*() {
        const stars = yield* Stars
        yield* stars.setStar({ id: `bad-retention-${String(retentionSeconds)}`, ...base, retentionSeconds })
      }))
      expect(error).toBeInstanceOf(InvalidRetention)
    }
  })

  test("setStar applies the default retention when none is named", async () => {
    const star = await run(Effect.gen(function*() {
      const stars = yield* Stars
      const created = yield* stars.setStar({ id: "default-retention", ...base })
      const read = yield* stars.getStar("default-retention")
      expect(read).toEqual(created)
      return created
    }))
    expect(star.retentionSeconds).toBe(3600)
    expect(star.visibility).toBe("private")
    expect(star.createdVia).toBe("api")
  })

  test("a fractional retention round-trips", async () => {
    const read = await run(Effect.gen(function*() {
      const stars = yield* Stars
      yield* stars.setStar({ id: "fractional", ...base, retentionSeconds: 0.5 })
      return yield* stars.getStar("fractional")
    }))
    expect(read.retentionSeconds).toBe(0.5)
  })

  test("zero retention is accepted but not retained; the sweep treats it as already expired", async () => {
    const created = await run(Effect.gen(function*() {
      const stars = yield* Stars
      return yield* stars.setStar({ id: "zero-retention", ...base, retentionSeconds: 0 })
    }))
    expect(created.retentionSeconds).toBe(0)

    // Nothing was written: the record exists only in the caller's hands.
    const error = await failureOf(Effect.gen(function*() {
      const stars = yield* Stars
      yield* stars.getStar("zero-retention")
    }))
    expect(error).toBeInstanceOf(StarNotFound)

    // Only the content-free receipt remains.
    const receipt = receiptFor(created)
    expect(Object.keys(receipt).sort()).toEqual(RECEIPT_KEYS)
    expect(receipt.reason).toBe("zero-retention")
    expect(receipt.retentionSeconds).toBe(0)
    expect(receipt.createdAt).toBe(created.createdAt)

    // A zero-retention record that does land on disk (hand-authored, or
    // written by another build) is already expired as far as the sweep is
    // concerned.
    await Effect.runPromise(
      Files.writeJson(dataPath(starKey("zero-on-disk")), { ...created, id: "zero-on-disk" }).pipe(
        Effect.provide(BunFileSystem.layer)
      )
    )
    const removed = await run(Effect.gen(function*() {
      const stars = yield* Stars
      return yield* stars.sweepExpired(new Date(base.createdAt))
    }))
    expect(removed).toContain("zero-on-disk")
  })

  test("the sweep deletes an expired star and keeps a live one", async () => {
    const expiredStar = await run(Effect.gen(function*() {
      const stars = yield* Stars
      return yield* stars.setStar({ id: "expired", ...base, name: "secret name", note: "secret note", retentionSeconds: 60 })
    }))
    const removed = await run(Effect.gen(function*() {
      const stars = yield* Stars
      yield* stars.setStar({ id: "live", ...base, retentionSeconds: 7200 })
      const removedIds = yield* stars.sweepExpired(new Date("2026-01-01T13:00:00.000Z"))
      const live = yield* stars.getStar("live")
      expect(live.id).toBe("live")
      return removedIds
    }))
    expect(removed).toContain("expired")
    expect(removed).not.toContain("live")

    const error = await failureOf(Effect.gen(function*() {
      const stars = yield* Stars
      yield* stars.getStar("expired")
    }))
    expect(error).toBeInstanceOf(StarNotFound)

    // The forget is attestable: a receipt with the star's content hash and
    // the reason, and no content fields whatsoever — despite the star
    // having carried a name and a note.
    const receipt = receiptFor(expiredStar)
    expect(Object.keys(receipt).sort()).toEqual(RECEIPT_KEYS)
    expect(receipt.contentHash).toBe(publicStarContentHash(publicStarFor(expiredStar, [], null)))
    expect(receipt.reason).toBe("expired")
    expect(receipt.createdAt).toBe(expiredStar.createdAt)
    expect(receipt.deletedAt).toBe("2026-01-01T13:00:00.000Z")
    expect(receipt.retentionSeconds).toBe(60)
  })

  test("updateStar patches fields and removeStar deletes the record, leaving a receipt", async () => {
    const removedStar = await run(Effect.gen(function*() {
      const stars = yield* Stars
      yield* stars.setStar({ id: "editable", ...base, retentionSeconds: 3600 })
      const updated = yield* stars.updateStar("editable", { name: "school run", visibility: "public" })
      expect(updated.name).toBe("school run")
      expect(updated.visibility).toBe("public")
      yield* stars.removeStar("editable")
      return updated
    }))
    const error = await failureOf(Effect.gen(function*() {
      const stars = yield* Stars
      yield* stars.getStar("editable")
    }))
    expect(error).toBeInstanceOf(StarNotFound)

    const receipt = receiptFor(removedStar)
    expect(Object.keys(receipt).sort()).toEqual(RECEIPT_KEYS)
    expect(receipt.reason).toBe("removed")
  })

  test("listStars filters by range and by civil day", async () => {
    const listed = await run(Effect.gen(function*() {
      const stars = yield* Stars
      yield* stars.setStar({ id: "listed", ...base, retentionSeconds: 3600 })
      const byDay = yield* stars.listStars({ day: "2026-01-01", timeZone: "UTC" })
      const otherDay = yield* stars.listStars({ day: "2026-01-02", timeZone: "UTC" })
      const byRange = yield* stars.listStars({ fromUtc: "2026-01-02T00:00:00.000Z" })
      expect(otherDay.map((star) => star.id)).not.toContain("listed")
      expect(byRange.map((star) => star.id)).not.toContain("listed")
      return byDay
    }))
    expect(listed.map((star) => star.id)).toContain("listed")
  })

  test("public content hashes are stable per content and change with it", () => {
    const star = new Star({
      id: "public-one",
      ...base,
      name: "porch light",
      note: null,
      visibility: "public",
      retentionSeconds: 3600,
      createdVia: "api"
    })
    const content = publicStarFor(star, ["transcript/assemblyai-u35p-v1/capture.json"], "hello world")
    const same = publicStarFor(star, ["transcript/assemblyai-u35p-v1/capture.json"], "hello world")
    expect(publicStarContentHash(content)).toBe(publicStarContentHash(same))
    const renamed = publicStarFor(new Star({ ...star, name: "porch lamp" }), content.transcriptKeys, content.excerpt)
    expect(publicStarContentHash(renamed)).not.toBe(publicStarContentHash(content))
  })

  test("the resource materializes a per-day view over an empty corpus", async () => {
    await run(Effect.gen(function*() {
      const stars = yield* Stars
      // ~3 years of retention, so the resource basis sweep (which uses the
      // wall clock) leaves this one standing.
      yield* stars.setStar({ id: "viewed", ...base, retentionSeconds: 100_000_000 })
    }))
    const viewLayers = Layer.mergeAll(BunFileSystem.layer, startTimeRulesLayer)
    const instances = await Effect.runPromise(starsResource.instances.pipe(Effect.provide(viewLayers)))
    const dayInstance = instances.find((instance) => instance.label === "2026-01-01")
    expect(dayInstance).toBeDefined()
    await Effect.runPromise(dayInstance!.materialize.pipe(Effect.provide(viewLayers)))
    const view = await Effect.runPromise(
      readCachedInstance(StarsDay, dayInstance!, dataPath).pipe(Effect.provide(BunFileSystem.layer))
    )
    expect(Option.isSome(view)).toBe(true)
    const entries = Option.getOrThrow(view).entries
    expect(entries.map((entry) => entry.star.id)).toEqual(["viewed"])
    // No transcripts exist in the test corpus, so nothing resolves.
    expect(entries[0]?.transcriptKeys).toEqual([])
    expect(entries[0]?.excerpt).toBeNull()
  })
})
