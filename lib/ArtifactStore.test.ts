import { BunFileSystem } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ArtifactStore,
  artifactPath,
  key,
  makeBucket,
  makeIndexClient,
  makeLocal,
  makeMemory,
  makeMemoryIndexClient,
  makeMemoryObjectStore,
  type ArtifactStoreApi,
  type IndexClientApi
} from "./ArtifactStore.ts"
import * as Files from "./Files.ts"
import { DATA_DIR, dataPath } from "./lifelog/Resources.ts"

describe("artifact keys", () => {
  test("resolve beneath the configured root", () => {
    expect(artifactPath("data/artifacts", "journal/v1/day.json")).toBe("data/artifacts/journal/v1/day.json")
  })

  test("reject absolute and parent-traversing paths", () => {
    expect(() => key("/etc/passwd")).toThrow()
    expect(() => key("../outside")).toThrow()
  })
})

class Widget extends Schema.Class<Widget>("Widget")({
  name: Schema.String,
  count: Schema.Number
}) {}

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

/** The store contract: every implementation must satisfy all of it. The
 * contract is the point — a deployment flips implementations by config,
 * so behavior cannot be allowed to drift between them. */
const contract = (name: string, make: () => Promise<ArtifactStoreApi>) => {
  describe(`artifact store contract: ${name}`, () => {
    test("text round-trips, and a missing key reads as none", async () => {
      const store = await make()
      await run(store.putText("notes/day.json", "hello"))
      expect(await run(store.getText("notes/day.json"))).toEqual(Option.some("hello"))
      expect(await run(store.getText("notes/absent.json"))).toEqual(Option.none())
    })

    test("bytes round-trip exactly, including NULs", async () => {
      const store = await make()
      const bytes = new Uint8Array([0, 1, 2, 0, 255, 10])
      await run(store.putBytes("capture/x/blob.bin", bytes))
      const got = await run(store.getBytes("capture/x/blob.bin"))
      expect(Option.isSome(got) && [...got.value]).toEqual([...bytes])
    })

    test("a second put replaces the first", async () => {
      const store = await make()
      await run(store.putText("a/b.json", "one"))
      await run(store.putText("a/b.json", "two"))
      expect(await run(store.getText("a/b.json"))).toEqual(Option.some("two"))
    })

    test("head and exists agree with the content, delete is idempotent", async () => {
      const store = await make()
      expect(await run(store.exists("x/y.json"))).toBe(false)
      expect(await run(store.head("x/y.json"))).toEqual(Option.none())
      await run(store.putText("x/y.json", "12345"))
      expect(await run(store.exists("x/y.json"))).toBe(true)
      const head = await run(store.head("x/y.json"))
      expect(Option.isSome(head) && head.value.size).toBe(5)
      await run(store.delete("x/y.json"))
      expect(await run(store.exists("x/y.json"))).toBe(false)
      await run(store.delete("x/y.json"))
    })

    test("list is directory-bounded, sorted, and the empty prefix lists all", async () => {
      const store = await make()
      for (const k of ["star/b/c.json", "star/a.json", "starfish/x.json", "journal/v/day.json"]) {
        await run(store.putText(k, "x"))
      }
      expect(await run(store.list("star"))).toEqual(["star/a.json", "star/b/c.json"])
      expect(await run(store.list("journal"))).toEqual(["journal/v/day.json"])
      expect(await run(store.list(""))).toEqual([
        "journal/v/day.json",
        "star/a.json",
        "star/b/c.json",
        "starfish/x.json"
      ])
      expect(await run(store.list("absent"))).toEqual([])
    })

    test("latest pointers start empty, set, and overwrite", async () => {
      const store = await make()
      expect(await run(store.getLatest("search"))).toEqual(Option.none())
      await run(store.setLatest("search", "search/v1/aaa.json"))
      expect(await run(store.getLatest("search"))).toEqual(Option.some("search/v1/aaa.json"))
      await run(store.setLatest("search", "search/v1/bbb.json"))
      expect(await run(store.getLatest("search"))).toEqual(Option.some("search/v1/bbb.json"))
    })

    test("writeJson/readJson round-trip through the schema", async () => {
      const store = await make()
      await run(store.writeJson("w/one.json", new Widget({ name: "gear", count: 3 })))
      const got = await run(store.readJson(Widget, "w/one.json"))
      expect(Option.isSome(got) && got.value).toEqual(new Widget({ name: "gear", count: 3 }))
      expect(await run(store.readJson(Widget, "w/absent.json"))).toEqual(Option.none())
    })

    test("putFile stores a file from disk", async () => {
      const store = await make()
      const source = join(mkdtempSync(join(tmpdir(), "medina-store-src-")), "blob.bin")
      writeFileSync(source, new Uint8Array([9, 8, 7, 0, 1]))
      await run(store.putFile("capture/z/blob.bin", source))
      const got = await run(store.getBytes("capture/z/blob.bin"))
      expect(Option.isSome(got) && [...got.value]).toEqual([9, 8, 7, 0, 1])
    })
  })
}

contract("local", async () => {
  const root = mkdtempSync(join(tmpdir(), "medina-store-local-"))
  return Effect.runPromise(makeLocal(root).pipe(Effect.provide(BunFileSystem.layer)))
})

contract("memory", async () => makeMemory().api)

contract("bucket (fake objects + fake index)", async () =>
  makeBucket({
    objects: makeMemoryObjectStore(),
    index: makeMemoryIndexClient(),
    pathRoot: "data/artifacts"
  })
)

describe("bucket store index discipline", () => {
  test("puts register, deletes unregister, and list trusts the index — not the objects", async () => {
    const objects = makeMemoryObjectStore()
    const index = makeMemoryIndexClient()
    const store = makeBucket({ objects, index, pathRoot: "data/artifacts" })
    await run(store.putText("star/one.json", "1"))
    expect(await run(index.list(""))).toEqual(["star/one.json"])
    // An object that lands in the bucket without registration (a manual
    // upload, a restore) is readable by key but invisible to listings
    // until something registers it: listings are the index's word.
    await run(objects.put("star/ghost.json", new TextEncoder().encode("g")))
    expect(await run(store.list("star"))).toEqual(["star/one.json"])
    expect(await run(store.getText("star/ghost.json"))).toEqual(Option.some("g"))
    await run(index.register({ key: "star/ghost.json", size: 1 }))
    expect(await run(store.list("star"))).toEqual(["star/ghost.json", "star/one.json"])
    await run(store.delete("star/one.json"))
    expect(await run(index.list(""))).toEqual(["star/ghost.json"])
    expect(await run(store.exists("star/one.json"))).toBe(false)
  })
})

describe("index client (HTTP)", () => {
  /** A transport that plays the Worker: routes requests onto a memory
   * index the way workers/medina-index does, and records what it saw. */
  const fakeWorker = (index: IndexClientApi) => {
    const seen: Array<{ method: string; path: string; authorization: string | null }> = []
    const transport = async (url: string, init: RequestInit): Promise<Response> => {
      const parsed = new URL(url)
      seen.push({
        method: init.method ?? "GET",
        path: parsed.pathname,
        authorization: new Headers(init.headers).get("authorization")
      })
      const body = init.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
      const reply = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
      if (parsed.pathname === "/register") {
        await run(index.register({
          key: String(body.key),
          size: typeof body.size === "number" ? body.size : null,
          ...(typeof body.hash === "string" ? { hash: body.hash } : {})
        }))
        return reply({ ok: true })
      }
      if (parsed.pathname === "/unregister") {
        await run(index.unregister(String(body.key)))
        return reply({ ok: true })
      }
      if (parsed.pathname === "/list") {
        return reply({ keys: await run(index.list(parsed.searchParams.get("prefix") ?? "")) })
      }
      if (parsed.pathname === "/latest" && init.method === "PUT") {
        await run(index.setLatest(String(body.group), String(body.key)))
        return reply({ ok: true })
      }
      if (parsed.pathname === "/latest") {
        const value = await run(index.getLatest(parsed.searchParams.get("group") ?? ""))
        return reply({ key: Option.getOrNull(value) })
      }
      return new Response("not found", { status: 404 })
    }
    return { transport, seen }
  }

  test("speaks the worker's endpoints with bearer auth", async () => {
    const index = makeMemoryIndexClient()
    const { seen, transport } = fakeWorker(index)
    const client = makeIndexClient({ baseUrl: "https://index.example/", token: "sekret", transport })
    await run(client.register({ key: "a/b.json", size: 3, hash: "abc" }))
    expect(await run(client.list("a"))).toEqual(["a/b.json"])
    expect(await run(client.getLatest("g"))).toEqual(Option.none())
    await run(client.setLatest("g", "a/b.json"))
    expect(await run(client.getLatest("g"))).toEqual(Option.some("a/b.json"))
    await run(client.unregister("a/b.json"))
    expect(await run(client.list(""))).toEqual([])
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((request) => request.authorization === "Bearer sekret")).toBe(true)
    expect(seen.map((request) => request.path)).toContain("/register")
  })

  test("a non-2xx response fails with the status", async () => {
    const client = makeIndexClient({
      baseUrl: "https://index.example",
      token: "wrong",
      transport: async () => new Response("unauthorized", { status: 401 })
    })
    await expect(run(client.list(""))).rejects.toThrow("401")
  })
})

describe("config selection (layerFromConfig)", () => {
  // These run in a subprocess, deliberately: Effect's env ConfigProvider
  // snapshots process.env at its first evaluation in a process, so an
  // in-process config test would freeze the environment for every other
  // test file in the suite (the Transloadit tests set env per test and
  // build config-reading layers — they must evaluate Config first).
  // Config selection is boot-time behavior; a fresh process per case is
  // also simply what production does.
  const PROGRAM = `
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ArtifactStore, layerFromConfig } from "./lib/ArtifactStore.ts"
const exit = await Effect.runPromiseExit(
  Effect.gen(function*() {
    const store = yield* ArtifactStore
    yield* store.putText("probe/x.json", "ok")
    const got = yield* store.getText("probe/x.json")
    return { root: store.root, got: got._tag === "Some" ? got.value : null }
  }).pipe(Effect.provide(layerFromConfig.pipe(Layer.provide(BunFileSystem.layer))))
)
console.log(JSON.stringify(
  exit._tag === "Success"
    ? { ok: true, ...exit.value }
    : { ok: false, error: String(exit.cause).slice(0, 400) }
))
`
  const runConfigCase = (env: Record<string, string | undefined>): { ok: boolean; root?: string; got?: string | null; error?: string } => {
    const childEnv = { ...process.env }
    for (const name of [
      "ARTIFACT_STORE", "ARTIFACT_BUCKET_NAME", "ARTIFACT_BUCKET_ENDPOINT",
      "ARTIFACT_BUCKET_ACCESS_KEY_ID", "ARTIFACT_BUCKET_SECRET_ACCESS_KEY",
      "MEDINA_INDEX_URL", "INDEX_API_TOKEN", "DATA_DIR"
    ]) delete childEnv[name]
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined) childEnv[name] = value
    }
    const proc = Bun.spawnSync(["bun", "-e", PROGRAM], {
      cwd: join(import.meta.dir, ".."),
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe"
    })
    if (proc.exitCode !== 0) throw new Error(`config case crashed: ${new TextDecoder().decode(proc.stderr)}`)
    return JSON.parse(new TextDecoder().decode(proc.stdout).trim()) as { ok: boolean; root?: string; got?: string | null; error?: string }
  }

  test("default (no ARTIFACT_STORE) is the local store over DATA_DIR", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "medina-config-local-"))
    const result = runConfigCase({ DATA_DIR: dataDir })
    expect(result).toEqual({ ok: true, root: dataDir, got: "ok" })
  })

  test("ARTIFACT_STORE=bucket without bucket config fails operations with instructions", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "medina-config-bucket-"))
    const result = runConfigCase({ DATA_DIR: dataDir, ARTIFACT_STORE: "bucket" })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("ARTIFACT_STORE=bucket")
  })
})

describe("files seam", () => {
  test("Files helpers route through an in-context store, keyed by path", async () => {
    const memory = makeMemory(DATA_DIR)
    const layers = Layer.mergeAll(BunFileSystem.layer, Layer.succeed(ArtifactStore)(memory.api))
    const probe = dataPath("artifact-seam/probe.json")
    await Effect.runPromise(
      Files.writeJson(probe, { routed: true }).pipe(Effect.provide(layers))
    )
    // The write landed in the store, under the artifact key…
    expect(await run(memory.api.getText("artifact-seam/probe.json"))).toEqual(
      Option.some(JSON.stringify({ routed: true }, null, 2))
    )
    // …and reads, listings, existence, and removal route the same way.
    const read = await Effect.runPromise(
      Files.readJson(Schema.Struct({ routed: Schema.Boolean }), probe).pipe(Effect.provide(layers))
    )
    expect(read).toEqual(Option.some({ routed: true }))
    const listed = await Effect.runPromise(
      Files.listFiles(dataPath("artifact-seam")).pipe(Effect.provide(layers))
    )
    expect(listed).toEqual(["probe.json"])
    expect(
      await Effect.runPromise(Files.exists(probe).pipe(Effect.provide(layers)))
    ).toBe(true)
    await Effect.runPromise(Files.remove(probe).pipe(Effect.provide(layers)))
    expect(await run(memory.api.exists("artifact-seam/probe.json"))).toBe(false)
  })

  test("paths outside the store root keep plain filesystem behavior", async () => {
    const memory = makeMemory(DATA_DIR)
    const layers = Layer.mergeAll(BunFileSystem.layer, Layer.succeed(ArtifactStore)(memory.api))
    const outside = join(tmpdir(), "medina-seam-outside.json")
    await Effect.runPromise(Files.writeJson(outside, { routed: false }).pipe(Effect.provide(layers)))
    expect(await run(memory.api.list(""))).toEqual([])
    expect(
      await Effect.runPromise(Files.exists(outside).pipe(Effect.provide(layers)))
    ).toBe(true)
    await Effect.runPromise(Files.remove(outside).pipe(Effect.provide(layers)))
  })
})
