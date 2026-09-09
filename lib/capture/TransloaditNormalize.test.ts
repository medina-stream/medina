import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { layerMemory } from "../Bucket.ts"
import { R2TempCreds, TempCredentials } from "../R2TempCreds.ts"
import { DATA_DIR, dataPath } from "../lifelog/Resources.ts"
import { layer, transloaditReceiptKey, TransloaditNormalize, TransloaditReceipt } from "./TransloaditNormalize.ts"
import * as Files from "../Files.ts"

if (!DATA_DIR.startsWith(tmpdir())) throw new Error(`refusing to run against a non-temp data dir: ${DATA_DIR}`)

const creds = Layer.succeed(R2TempCreds)({
  configured: true,
  endpoint: "https://account.r2.cloudflarestorage.com",
  bucket: "archive",
  mint: () => Effect.succeed(new TempCredentials({ accessKeyId: "write-key", secretAccessKey: "write-secret", sessionToken: "session" })),
  presignGet: (key) => Effect.succeed(`https://signed.example/${key}`)
})

const withConfig = async <A>(run: () => Promise<A>) => {
  const oldKey = process.env.TRANSLOADIT_API_KEY
  const oldUrl = process.env.TRANSLOADIT_API_URL
  process.env.TRANSLOADIT_API_KEY = "test-key"
  process.env.TRANSLOADIT_API_URL = "https://transloadit.test"
  try { return await run() } finally {
    if (oldKey === undefined) delete process.env.TRANSLOADIT_API_KEY; else process.env.TRANSLOADIT_API_KEY = oldKey
    if (oldUrl === undefined) delete process.env.TRANSLOADIT_API_URL; else process.env.TRANSLOADIT_API_URL = oldUrl
  }
}

describe("TransloaditNormalize", () => {
  test("fires once and persists only a non-secret polling receipt", async () => withConfig(async () => {
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    store.set("capture/capture-a/input.wav", { bytes: new Uint8Array([1]) })
    const previousFetch = globalThis.fetch
    let creates = 0
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      creates += 1
      const params = JSON.parse(String((init?.body as FormData).get("params")))
      expect(params.steps.import.url).toBe("https://signed.example/capture/capture-a/input.wav")
      expect(params.steps.store.secret).toBe("write-secret")
      return Response.json({ assembly_id: "assembly-a", assembly_ssl_url: "https://poll.test/a" })
    }) as unknown as typeof fetch
    try {
      const services = Layer.mergeAll(layerMemory(store), BunFileSystem.layer, creds, layer.pipe(Layer.provide(creds)))
      const result = await Effect.runPromise(
        Effect.gen(function*() { return yield* (yield* TransloaditNormalize).normalize("capture-a", "input.wav", 1) }).pipe(Effect.provide(services))
      )
      expect(result).toBe("fired")
      expect(creates).toBe(1)
      const receipt = await Effect.runPromise(Files.readJson(TransloaditReceipt, dataPath(transloaditReceiptKey("capture-a"))).pipe(Effect.provide(BunFileSystem.layer)))
      expect(receipt._tag).toBe("Some")
      expect(JSON.stringify(receipt)).not.toContain("write-secret")
      expect(JSON.stringify(receipt)).not.toContain("signed.example")
    } finally { globalThis.fetch = previousFetch }
  }))

  test("a terminal failed assembly deletes its receipt so a later pass can re-fire", async () => withConfig(async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ ok: "ASSEMBLY_FAILED" })) as unknown as typeof fetch
    try {
      const services = Layer.mergeAll(layerMemory(), BunFileSystem.layer, creds, layer.pipe(Layer.provide(creds)))
      await Effect.runPromise(Files.writeJson(dataPath(transloaditReceiptKey("capture-b")), new TransloaditReceipt({
        assemblyId: "assembly-b", assemblySslUrl: "https://poll.test/b", createdAt: new Date().toISOString(), mediaVersion: "media-v1"
      })).pipe(Effect.provide(BunFileSystem.layer)))
      const failure = await Effect.runPromise(
        Effect.gen(function*() { return yield* (yield* TransloaditNormalize).normalize("capture-b", "input.wav", 1) }).pipe(
          Effect.provide(services), Effect.flip
        )
      )
      expect(failure.message).toContain("failed or vanished")
      expect(await Bun.file(dataPath(transloaditReceiptKey("capture-b"))).exists()).toBe(false)
    } finally { globalThis.fetch = previousFetch }
  }))

  test("completion without a canonical object never writes a manifest", async () => withConfig(async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ ok: "ASSEMBLY_COMPLETED" })) as unknown as typeof fetch
    try {
      const services = Layer.mergeAll(layerMemory(), BunFileSystem.layer, creds, layer.pipe(Layer.provide(creds)))
      await Effect.runPromise(Files.writeJson(dataPath(transloaditReceiptKey("capture-c")), new TransloaditReceipt({
        assemblyId: "assembly-c", assemblySslUrl: "https://poll.test/c", createdAt: new Date().toISOString(), mediaVersion: "media-v1"
      })).pipe(Effect.provide(BunFileSystem.layer)))
      const failure = await Effect.runPromise(
        Effect.gen(function*() { return yield* (yield* TransloaditNormalize).normalize("capture-c", "input.wav", 1) }).pipe(
          Effect.provide(services), Effect.flip
        )
      )
      expect(failure.message).toContain("without canonical output")
      expect(await Bun.file(dataPath("media/media-v1/capture-c.json")).exists()).toBe(false)
    } finally { globalThis.fetch = previousFetch }
  }))

})
