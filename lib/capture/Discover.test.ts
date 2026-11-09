/**
 * Regression test for the 2026-09-18 ingest stall: a fixed window sliced off
 * the top of the bucket listing starved everything past it (newest-first
 * dropped the middle of an upload burst; oldest-first re-wedged on the oldest
 * cached/skipped objects). discoverFresh filters receipted objects before the
 * slice so every pass advances.
 *
 * Run with:
 *   DATA_DIR=$(mktemp -d) bun test lib/capture/Discover.test.ts
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { BunFileSystem } from "@effect/platform-bun"
import { discoverFresh } from "./Discover.ts"
import * as Files from "../Files.ts"
import { dataPath, IngestReceipt, ingestReceiptKey } from "../lifelog/Resources.ts"
import type { BucketObject, SourceBucketApi } from "../Bucket.ts"

const dataDir = process.env["DATA_DIR"]
if (!dataDir || !dataDir.startsWith("/tmp/")) {
  throw new Error("refusing to run: set DATA_DIR to a temp dir, e.g. DATA_DIR=$(mktemp -d)")
}

const object = (key: string, etag: string): BucketObject => ({
  key,
  size: 1024,
  etag,
  lastModified: "2026-09-18T00:00:00.000Z"
})

// The stub returns the whole listing regardless of limit, like the real
// bucket layer (which pages the full prefix, sorts newest-first, then
// slices): the newest objects come first. Its head answers from the same
// object set, the way the real head answers from the bucket itself.
const stubApi = (objects: ReadonlyArray<BucketObject>): SourceBucketApi =>
  ({
    configured: true,
    list: (_prefix: string, _limit: number) => Effect.succeed(objects),
    download: (_key: string) => Effect.fail(new Error("not needed")),
    head: (key: string) => Effect.succeed(objects.find((o) => o.key === key) ?? null)
  }) as unknown as SourceBucketApi

const live = BunFileSystem.layer
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(live)) as Effect.Effect<A, E, never>)

const writeReceipt = (sourceName: string, key: string, version: string) =>
  run(
    Files.writeJson(
      dataPath(ingestReceiptKey(sourceName, key, version)),
      new IngestReceipt({ captureId: "abc", ingestedAt: new Date().toISOString() })
    )
  )

const SOURCE = "test-source"

const discover = (
  objects: ReadonlyArray<BucketObject>,
  limit: number,
  ingestable: (item: BucketObject) => boolean = () => true
) =>
  run(
    discoverFresh(
      stubApi(objects),
      SOURCE,
      "prefix/",
      limit,
      (list) => list,
      (item) => ({ key: item.key, version: item.etag ?? "" }),
      ingestable
    )
  )

describe("discoverFresh", () => {
  test("skips objects that already have ingest receipts", async () => {
    const objects = [object("a.m4a", "etag-a"), object("b.m4a", "etag-b"), object("c.m4a", "etag-c")]
    await writeReceipt(SOURCE, "a.m4a", "etag-a")
    const fresh = await discover(objects, 10)
    expect(fresh.map((o) => o.key)).toEqual(["b.m4a", "c.m4a"])
  })

  test("advances past a fully-receipted window (the 2026-09-18 stall)", async () => {
    const objects = Array.from({ length: 30 }, (_, i) => object(`s${i}.m4a`, `etag-${i}`))
    for (let i = 0; i < 25; i++) {
      await writeReceipt(SOURCE, `s${i}.m4a`, `etag-${i}`)
    }
    // The old fixed-window code would keep returning the same 25 receipted
    // objects forever; the filter must expose what comes after them.
    const fresh = await discover(objects, 25)
    expect(fresh.map((o) => o.key)).toEqual(["s25.m4a", "s26.m4a", "s27.m4a", "s28.m4a", "s29.m4a"])
  })

  test("bounds per-pass work to the limit", async () => {
    const objects = [object("p-a.m4a", "etag-pa"), object("p-b.m4a", "etag-pb"), object("p-c.m4a", "etag-pc")]
    const fresh = await discover(objects, 2)
    expect(fresh.map((o) => o.key)).toEqual(["p-a.m4a", "p-b.m4a"])
  })

  test("takes the newest unreceipted objects first (ingest priority)", async () => {
    // The bucket layer lists newest-first; discovery takes from the front,
    // so newer captures win the per-pass window while older ones wait.
    const objects = [object("new.m4a", "etag-new"), object("mid.m4a", "etag-mid"), object("old.m4a", "etag-old")]
    await writeReceipt(SOURCE, "new.m4a", "etag-new")
    const fresh = await discover(objects, 1)
    expect(fresh.map((o) => o.key)).toEqual(["mid.m4a"])
  })

  test("drops items that fail the ingestable predicate", async () => {
    const objects = [object("q-a.m4a", "etag-qa"), object("q-b.json", "etag-qb"), object("q-c.m4a", "etag-qc")]
    const fresh = await discover(objects, 10, (item) => item.key.endsWith(".m4a"))
    expect(fresh.map((o) => o.key)).toEqual(["q-a.m4a", "q-c.m4a"])
  })

  test("returns empty when everything is receipted", async () => {
    const objects = [object("r-a.m4a", "etag-ra"), object("r-b.m4a", "etag-rb")]
    await writeReceipt(SOURCE, "r-a.m4a", "etag-ra")
    await writeReceipt(SOURCE, "r-b.m4a", "etag-rb")
    expect(await discover(objects, 10)).toEqual([])
  })

  test("returns empty for a non-positive limit", async () => {
    const objects = [object("z-a.m4a", "etag-za")]
    expect(await discover(objects, 0)).toEqual([])
  })
})

describe("discoverFresh discovery index", () => {
  test("a warm pass serves the pending backlog from the index on a bounded listing", async () => {
    const source = "test-source-indexed"
    const all = Array.from({ length: 10 }, (_, i) => object(`w${i}.m4a`, `etag-w${i}`))
    const limits: Array<number> = []
    // A contract-honoring stub: newest-first, sliced to the requested limit.
    const honoringApi = {
      configured: true,
      list: (_prefix: string, limit: number) => {
        limits.push(limit)
        return Effect.succeed(all.slice(0, limit))
      },
      download: (_key: string) => Effect.fail(new Error("not needed")),
      head: (key: string) => Effect.succeed(all.find((o) => o.key === key) ?? null)
    } as unknown as SourceBucketApi
    const runDiscover = (limit: number) =>
      run(discoverFresh(honoringApi, source, "prefix/", limit, (list) => list,
        (item) => ({ key: item.key, version: item.etag ?? "" })))

    // Cold pass: expands past the first truncated window, learns the whole
    // backlog, and takes the newest window.
    expect((await runDiscover(3)).map((o) => o.key)).toEqual(["w0.m4a", "w1.m4a", "w2.m4a"])
    expect(limits).not.toContain(Number.MAX_SAFE_INTEGER)

    // Receipt the first window the way ingest would, then a warm pass on a
    // listing that only returns the newest 3 must still reach w3.. from
    // the persisted index — without enumerating the prefix again.
    for (let i = 0; i < 3; i++) {
      await run(Files.writeJson(
        dataPath(ingestReceiptKey(source, `w${i}.m4a`, `etag-w${i}`)),
        new IngestReceipt({ captureId: "abc", ingestedAt: new Date().toISOString() })
      ))
    }
    limits.length = 0
    expect((await runDiscover(3)).map((o) => o.key)).toEqual(["w3.m4a", "w4.m4a", "w5.m4a"])
    expect(limits).toEqual([3])
  })

  test("a registration whose object was deleted heals instead of wedging the window", async () => {
    // The Nov 9, 2026 bucket-audio failure: gps/inbox files the GPS
    // compaction consumed stayed in this source's discovery index, and
    // every pass failed their downloads with NoSuchKey. The index merge
    // cannot see the deletion (a truncated listing merges, it does not
    // replace), so window selection head-checks: no object, no
    // registration — and the window backfills in the same pass.
    const source = "test-source-heal"
    const stamped = (key: string, lastModified: string): BucketObject => ({
      key,
      size: 1024,
      etag: `etag-${key}`,
      lastModified
    })
    const bucket = new Map<string, BucketObject>([
      ["phantom.ndjson", stamped("phantom.ndjson", "2026-11-01T05:00:00.000Z")],
      ["live-a.ndjson", stamped("live-a.ndjson", "2026-11-01T04:00:00.000Z")],
      ["live-b.ndjson", stamped("live-b.ndjson", "2026-11-01T03:00:00.000Z")],
      ["live-c.ndjson", stamped("live-c.ndjson", "2026-11-01T02:00:00.000Z")],
      ["live-d.ndjson", stamped("live-d.ndjson", "2026-11-01T01:00:00.000Z")]
    ])
    const headCalls = new Map<string, number>()
    const api = {
      configured: true,
      // Contract-honoring: newest-first, sliced to the requested limit.
      list: (_prefix: string, limit: number) =>
        Effect.succeed(
          [...bucket.values()]
            .sort((x, y) => (y.lastModified ?? "").localeCompare(x.lastModified ?? ""))
            .slice(0, limit)
        ),
      download: (_key: string) => Effect.fail(new Error("not needed")),
      head: (key: string) => {
        headCalls.set(key, (headCalls.get(key) ?? 0) + 1)
        return Effect.succeed(bucket.get(key) ?? null)
      }
    } as unknown as SourceBucketApi
    const runDiscover = (limit: number) =>
      run(discoverFresh(api, source, "gps/inbox/", limit, (list) => list,
        (item) => ({ key: item.key, version: item.etag ?? "" })))

    // Cold pass learns the whole backlog and takes the newest window.
    expect((await runDiscover(2)).map((o) => o.key)).toEqual(["phantom.ndjson", "live-a.ndjson"])

    // Another consumer deletes the phantom's object. The next listing is
    // truncated, so the merge keeps the phantom registered — only the
    // head-check can heal it. The window must skip it and backfill.
    bucket.delete("phantom.ndjson")
    expect((await runDiscover(2)).map((o) => o.key)).toEqual(["live-a.ndjson", "live-b.ndjson"])

    // The registration is gone, not merely skipped: a later pass never
    // head-checks the phantom again, and the live entries behind the
    // window were not dropped with it.
    headCalls.clear()
    await writeReceipt(source, "live-a.ndjson", "etag-live-a.ndjson")
    await writeReceipt(source, "live-b.ndjson", "etag-live-b.ndjson")
    expect((await runDiscover(2)).map((o) => o.key)).toEqual(["live-c.ndjson", "live-d.ndjson"])
    expect(headCalls.has("phantom.ndjson")).toBe(false)
  })
})
