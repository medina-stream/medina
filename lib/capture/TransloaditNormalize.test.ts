import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { layerMemory } from "../Bucket.ts"
import { R2TempCreds, TempCredentials } from "../R2TempCreds.ts"
import {
  DATA_DIR,
  dataPath,
  ingestId,
  ingestReceiptKey,
  Provenance,
  provenanceKey
} from "../lifelog/Resources.ts"
import * as Files from "../Files.ts"
import { MediaManifest, mediaManifestKey } from "./Media.ts"
import {
  layerWithClient,
  transloaditDriveReceiptKey,
  transloaditReceiptKey,
  TransloaditNormalize,
  TransloaditReceipt
} from "./TransloaditNormalize.ts"

if (!DATA_DIR.startsWith(tmpdir())) throw new Error(`refusing to run against a non-temp data dir: ${DATA_DIR}`)

const minted: Array<unknown> = []
const creds = Layer.succeed(R2TempCreds)({
  configured: true,
  endpoint: "https://account.r2.cloudflarestorage.com",
  bucket: "archive",
  mint: (options) => Effect.sync(() => {
    minted.push(options)
    return new TempCredentials({
      accessKeyId: "write-key",
      secretAccessKey: "write-secret",
      sessionToken: "session"
    })
  }),
  presignGet: (key) => Effect.succeed(`https://signed.example/${key}`)
})

const withConfig = async <A>(run: () => Promise<A>) => {
  const names = ["TRANSLOADIT_API_KEY", "TRANSLOADIT_AUTH_SECRET", "TRANSLOADIT_API_URL"] as const
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.TRANSLOADIT_API_KEY = "test-key"
  process.env.TRANSLOADIT_AUTH_SECRET = "test-secret"
  process.env.TRANSLOADIT_API_URL = "https://transloadit.test"
  try {
    return await run()
  } finally {
    for (const name of names) {
      const value = old[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const services = (
  store: Map<string, { bytes: Uint8Array; contentType?: string }>,
  client: unknown
) => Layer.mergeAll(
  layerMemory(store),
  BunFileSystem.layer,
  creds,
  layerWithClient(client as never).pipe(Layer.provide(creds))
)

describe("Transloadit remote media", () => {
  test("archived captures create one signed chunk Assembly and persist no credentials", async () => withConfig(async () => {
    minted.length = 0
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    store.set("capture/local-a/input.wav", { bytes: new Uint8Array([1]) })
    const creates: Array<Record<string, unknown>> = []
    const client = {
      createAssembly: async (options: { params: Record<string, unknown> }) => {
        creates.push(options.params)
        return {
          assembly_id: "assembly-a",
          assembly_url: "http://poll.test/a",
          assembly_ssl_url: "https://poll.test/a"
        }
      },
      getAssembly: async () => ({ ok: "ASSEMBLY_EXECUTING" })
    }
    const result = await Effect.runPromise(
      Effect.flatMap(TransloaditNormalize, (service) => service.normalize("local-a", "input.wav", 3601)).pipe(
        Effect.provide(services(store, client))
      )
    )
    expect(result).toBe("fired")
    const steps = creates[0]!.steps as Record<string, Record<string, unknown>>
    expect(steps.import!.url).toBe("https://signed.example/capture/local-a/input.wav")
    expect((steps.split!.segments as Array<unknown>).length).toBe(2)
    expect(steps.store_chunks!.path).toBe("media/media-v1/local-a/${file.name}")
    expect(steps.store_chunks!.path).not.toContain("segment_index")

    const receipt = await Effect.runPromise(
      Files.readJson(TransloaditReceipt, dataPath(transloaditReceiptKey("local-a"))).pipe(
        Effect.provide(BunFileSystem.layer)
      )
    )
    expect(Option.isSome(receipt)).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain("write-secret")
    expect(JSON.stringify(receipt)).not.toContain("signed.example")
  }))

  test("Drive imports never persist bearer tokens and complete as R2 original plus one-hour chunks", async () => withConfig(async () => {
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    const creates: Array<Record<string, unknown>> = []
    let importPolls = 0
    let chunkPolls = 0
    const client = {
      createAssembly: async (options: { params: Record<string, unknown> }) => {
        creates.push(options.params)
        const id = creates.length === 1 ? "drive-import" : "drive-chunks"
        return {
          assembly_id: id,
          assembly_url: `http://poll.test/${id}`,
          assembly_ssl_url: `https://poll.test/${id}`
        }
      },
      getAssembly: async (id: string) => {
        if (id === "drive-import") {
          importPolls++
          return {
            ok: "ASSEMBLY_COMPLETED",
            results: { import: [{ duration: 7201, meta: { duration: 7201 } }] }
          }
        }
        chunkPolls++
        // Reality: /s3/store reports no results in the Assembly JSON even
        // when the chunks land in R2 — the manifest comes from the listing.
        return { ok: "ASSEMBLY_COMPLETED", results: { import: [{}] } }
      }
    }
    const file = {
      id: "drive-file-a",
      name: "recording.wav",
      mimeType: "audio/wav",
      modifiedTime: "2026-09-01T00:00:00Z",
      checksum: "drive-md5"
    }
    const request = Effect.succeed({
      url: "https://www.googleapis.com/drive/v3/files/drive-file-a?alt=media",
      headers: ["Authorization: Bearer ephemeral-google-token"]
    })
    const live = services(store, client)

    const first = await Effect.runPromise(
      Effect.flatMap(TransloaditNormalize, (service) => service.ingestDrive("drive-allow", file, request)).pipe(
        Effect.provide(live)
      )
    )
    expect(first).toBe("fired")
    const firstSteps = creates[0]!.steps as Record<string, Record<string, unknown>>
    expect(firstSteps.import!.url).toContain("googleapis.com/drive")
    expect(firstSteps.import!.headers).toEqual(["Authorization: Bearer ephemeral-google-token"])

    const version = file.checksum
    const captureId = ingestId("drive-allow", file.id, version)
    const originalKey = `capture/${captureId}/recording.wav`
    store.set(originalKey, { bytes: new Uint8Array([1, 2, 3]) })
    const jobPath = dataPath(transloaditDriveReceiptKey(file.id, version))
    expect(await Bun.file(jobPath).text()).not.toContain("ephemeral-google-token")

    const second = await Effect.runPromise(
      Effect.flatMap(TransloaditNormalize, (service) => service.ingestDrive("drive-allow", file, request)).pipe(
        Effect.provide(live)
      )
    )
    expect(second).toBe("fired")
    const secondSteps = creates[1]!.steps as Record<string, Record<string, unknown>>
    expect((secondSteps.split!.segments as Array<unknown>).length).toBe(3)

    for (const index of [0, 1, 2]) {
      store.set(`media/media-v1/${captureId}/_${index}.ogg`, { bytes: new Uint8Array([index + 1]) })
    }
    const third = await Effect.runPromise(
      Effect.flatMap(TransloaditNormalize, (service) => service.ingestDrive("drive-allow", file, request)).pipe(
        Effect.provide(live)
      )
    )
    expect(third).toBe("completed")
    expect(importPolls).toBe(1)
    expect(chunkPolls).toBe(1)

    const manifest = await Effect.runPromise(
      Files.readJson(MediaManifest, dataPath(mediaManifestKey(captureId))).pipe(Effect.provide(BunFileSystem.layer))
    )
    expect(Option.getOrThrow(manifest).chunks.map((chunk) => chunk.durationSeconds)).toEqual([3600, 3600, 1])
    expect(await Bun.file(dataPath(originalKey)).exists()).toBe(false)
    expect(Option.isSome(await Effect.runPromise(
      Files.readJson(Provenance, dataPath(provenanceKey(captureId))).pipe(Effect.provide(BunFileSystem.layer))
    ))).toBe(true)
    expect(await Bun.file(dataPath(ingestReceiptKey("drive-allow", file.id, version))).exists()).toBe(true)
  }))

  test("surfaces Transloadit's exact terminal code, message, reason, and step", async () => withConfig(async () => {
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    const client = {
      createAssembly: async () => { throw new Error("not expected") },
      getAssembly: async () => ({
        ok: null,
        error: "S3_STORE_ACCESS_DENIED",
        message: "Access denied",
        reason: "bucket policy rejected the write",
        step: "store_chunks"
      })
    }
    await Effect.runPromise(
      Files.writeJson(dataPath(transloaditReceiptKey("failed-a")), new TransloaditReceipt({
        assemblyId: "assembly-failed",
        assemblySslUrl: "https://poll.test/failed",
        createdAt: new Date().toISOString(),
        mediaVersion: "media-v1",
        workflowVersion: "remote-media-v1",
        phase: "chunks",
        captureId: "failed-a",
        originalKey: "capture/failed-a/input.wav",
        sourceDurationSeconds: 1,
        previousAssemblyIds: []
      })).pipe(Effect.provide(BunFileSystem.layer))
    )
    const failure = await Effect.runPromise(
      Effect.flatMap(TransloaditNormalize, (service) => service.normalize("failed-a", "input.wav", 1)).pipe(
        Effect.provide(services(store, client)),
        Effect.flip
      )
    )
    expect(failure.message).toBe(
      "Transloadit assembly assembly-failed failed: S3_STORE_ACCESS_DENIED: Access denied: bucket policy rejected the write: store_chunks"
    )
    expect(await Bun.file(dataPath(transloaditReceiptKey("failed-a"))).exists()).toBe(true)
  }))

  test("re-fires a poisoned chunk assembly, preserving assembly IDs", async () => withConfig(async () => {
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    // The stored chunk has a malformed name (no trailing _<index>.ogg):
    // the manifest is built from the R2 listing, not the Assembly JSON.
    store.set("media/media-v1/retry-a/chunk-.ogg", { bytes: new Uint8Array([1]) })
    const creates: Array<string> = []
    const client = {
      createAssembly: async () => {
        const id = `assembly-${creates.length + 1}`
        creates.push(id)
        return { assembly_id: id, assembly_url: `http://poll.test/${id}`, assembly_ssl_url: `https://poll.test/${id}` }
      },
      // Transloadit's /s3/store step reports no results in the Assembly
      // JSON even on success — ground truth is the R2 listing.
      getAssembly: async () => ({ ok: "ASSEMBLY_COMPLETED", results: { import: [{}] } })
    }
    await Effect.runPromise(
      Files.writeJson(dataPath(transloaditReceiptKey("retry-a")), new TransloaditReceipt({
        assemblyId: "assembly-poisoned",
        assemblySslUrl: "https://poll.test/poisoned",
        createdAt: new Date().toISOString(),
        mediaVersion: "media-v1",
        workflowVersion: "remote-media-v1",
        phase: "chunks",
        captureId: "retry-a",
        originalKey: "capture/retry-a/input.wav",
        sourceDurationSeconds: 3600,
        previousAssemblyIds: []
      })).pipe(Effect.provide(BunFileSystem.layer))
    )
    const live = services(store, client)

    const refired = await Effect.runPromise(
      Effect.flatMap(TransloaditNormalize, (service) => service.normalize("retry-a", "input.wav", 3600)).pipe(
        Effect.provide(live)
      )
    )
    expect(refired).toBe("fired")
    expect(creates).toEqual(["assembly-1"])
    const next = Option.getOrThrow(await Effect.runPromise(
      Files.readJson(TransloaditReceipt, dataPath(transloaditReceiptKey("retry-a"))).pipe(
        Effect.provide(BunFileSystem.layer)
      )
    ))
    expect(next.assemblyId).toBe("assembly-1")
    expect(next.previousAssemblyIds).toEqual(["assembly-poisoned"])
    expect(next.phase).toBe("chunks")

    store.delete("media/media-v1/retry-a/chunk-.ogg")
    store.set("media/media-v1/retry-a/recording_0.ogg", { bytes: new Uint8Array([9]) })
    const completed = await Effect.runPromise(
      Effect.flatMap(TransloaditNormalize, (service) => service.normalize("retry-a", "input.wav", 3600)).pipe(
        Effect.provide(live)
      )
    )
    expect(completed).toBe("completed")
    const manifest = Option.getOrThrow(await Effect.runPromise(
      Files.readJson(MediaManifest, dataPath(mediaManifestKey("retry-a"))).pipe(
        Effect.provide(BunFileSystem.layer)
      )
    ))
    expect(manifest.chunks.map((chunk) => chunk.key)).toEqual(["media/media-v1/retry-a/recording_0.ogg"])
  }))

  test("completes from the R2 listing when the Assembly JSON omits store results", async () => withConfig(async () => {
    // Production regression (2026-09-16): Transloadit completed the chunk
    // Assembly and the chunk landed in R2, but the Assembly JSON carried no
    // store_chunks results, so the old code failed loudly on good data.
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    store.set(
      "media/media-v1/listing-a/20260916T024907Z-05087468-be14-4aac-b135-3af6d23d317b_0.ogg",
      { bytes: new Uint8Array([7]) }
    )
    const client = {
      createAssembly: async () => { throw new Error("must not re-fire") },
      getAssembly: async () => ({ ok: "ASSEMBLY_COMPLETED", results: { import: [{}] } })
    }
    await Effect.runPromise(
      Files.writeJson(dataPath(transloaditReceiptKey("listing-a")), new TransloaditReceipt({
        assemblyId: "assembly-listing",
        assemblySslUrl: "https://poll.test/listing",
        createdAt: new Date().toISOString(),
        mediaVersion: "media-v1",
        workflowVersion: "remote-media-v1",
        phase: "chunks",
        captureId: "listing-a",
        originalKey: "capture/listing-a/input.m4a",
        sourceDurationSeconds: 900,
        previousAssemblyIds: []
      })).pipe(Effect.provide(BunFileSystem.layer))
    )
    const result = await Effect.runPromise(
      Effect.flatMap(TransloaditNormalize, (service) => service.normalize("listing-a", "input.m4a", 900)).pipe(
        Effect.provide(services(store, client))
      )
    )
    expect(result).toBe("completed")
    const manifest = Option.getOrThrow(await Effect.runPromise(
      Files.readJson(MediaManifest, dataPath(mediaManifestKey("listing-a"))).pipe(
        Effect.provide(BunFileSystem.layer)
      )
    ))
    expect(manifest.chunks.map((chunk) => chunk.key)).toEqual([
      "media/media-v1/listing-a/20260916T024907Z-05087468-be14-4aac-b135-3af6d23d317b_0.ogg"
    ])
  }))

  test("re-fires on duplicate chunk names", async () => withConfig(async () => {
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    // Two stored files both parse to chunk index 0.
    store.set("media/media-v1/dup-a/a_0.ogg", { bytes: new Uint8Array([1]) })
    store.set("media/media-v1/dup-a/b_0.ogg", { bytes: new Uint8Array([2]) })
    let creates = 0
    const client = {
      createAssembly: async () => {
        creates++
        return { assembly_id: "assembly-new", assembly_url: "http://poll.test/new", assembly_ssl_url: "https://poll.test/new" }
      },
      getAssembly: async () => ({ ok: "ASSEMBLY_COMPLETED", results: { import: [{}] } })
    }
    await Effect.runPromise(
      Files.writeJson(dataPath(transloaditReceiptKey("dup-a")), new TransloaditReceipt({
        assemblyId: "assembly-dup",
        assemblySslUrl: "https://poll.test/dup",
        createdAt: new Date().toISOString(),
        mediaVersion: "media-v1",
        workflowVersion: "remote-media-v1",
        phase: "chunks",
        captureId: "dup-a",
        originalKey: "capture/dup-a/input.wav",
        sourceDurationSeconds: 7200,
        previousAssemblyIds: []
      })).pipe(Effect.provide(BunFileSystem.layer))
    )
    const result = await Effect.runPromise(
      Effect.flatMap(TransloaditNormalize, (service) => service.normalize("dup-a", "input.wav", 7200)).pipe(
        Effect.provide(services(store, client))
      )
    )
    expect(result).toBe("fired")
    expect(creates).toBe(1)
    const next = Option.getOrThrow(await Effect.runPromise(
      Files.readJson(TransloaditReceipt, dataPath(transloaditReceiptKey("dup-a"))).pipe(
        Effect.provide(BunFileSystem.layer)
      )
    ))
    expect(next.previousAssemblyIds).toEqual(["assembly-dup"])
  }))

  test("re-fires on empty chunks", async () => withConfig(async () => {
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    store.set("media/media-v1/empty-a/_0.ogg", { bytes: new Uint8Array([]) })
    let creates = 0
    const client = {
      createAssembly: async () => {
        creates++
        return { assembly_id: "assembly-new", assembly_url: "http://poll.test/new", assembly_ssl_url: "https://poll.test/new" }
      },
      getAssembly: async () => ({ ok: "ASSEMBLY_COMPLETED", results: { import: [{}] } })
    }
    await Effect.runPromise(
      Files.writeJson(dataPath(transloaditReceiptKey("empty-a")), new TransloaditReceipt({
        assemblyId: "assembly-empty",
        assemblySslUrl: "https://poll.test/empty",
        createdAt: new Date().toISOString(),
        mediaVersion: "media-v1",
        workflowVersion: "remote-media-v1",
        phase: "chunks",
        captureId: "empty-a",
        originalKey: "capture/empty-a/input.wav",
        sourceDurationSeconds: 3600,
        previousAssemblyIds: []
      })).pipe(Effect.provide(BunFileSystem.layer))
    )
    const result = await Effect.runPromise(
      Effect.flatMap(TransloaditNormalize, (service) => service.normalize("empty-a", "input.wav", 3600)).pipe(
        Effect.provide(services(store, client))
      )
    )
    expect(result).toBe("fired")
    expect(creates).toBe(1)
  }))

  test("gives up after three chunk attempts instead of re-firing forever", async () => withConfig(async () => {
    const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    let creates = 0
    const client = {
      createAssembly: async () => {
        creates++
        throw new Error("must not re-fire")
      },
      getAssembly: async () => ({ ok: "ASSEMBLY_COMPLETED", results: { import: [{}] } })
    }
    await Effect.runPromise(
      Files.writeJson(dataPath(transloaditReceiptKey("giveup-a")), new TransloaditReceipt({
        assemblyId: "assembly-third",
        assemblySslUrl: "https://poll.test/third",
        createdAt: new Date().toISOString(),
        mediaVersion: "media-v1",
        workflowVersion: "remote-media-v1",
        phase: "chunks",
        captureId: "giveup-a",
        originalKey: "capture/giveup-a/input.wav",
        sourceDurationSeconds: 3600,
        previousAssemblyIds: ["assembly-first", "assembly-second"]
      })).pipe(Effect.provide(BunFileSystem.layer))
    )
    const failure = await Effect.runPromise(
      Effect.flatMap(TransloaditNormalize, (service) => service.normalize("giveup-a", "input.wav", 3600)).pipe(
        Effect.provide(services(store, client)),
        Effect.flip
      )
    )
    expect(failure.message).toContain("after 3 attempts")
    expect(creates).toBe(0)
  }))
})
