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
    expect(steps.store_chunks!.path).toContain("${file.meta.segment_index}")

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
        return {
          ok: "ASSEMBLY_COMPLETED",
          results: {
            split: [0, 1, 2].map((segment_index) => ({ meta: { segment_index } }))
          }
        }
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
      store.set(`media/media-v1/${captureId}/chunk-${index}.ogg`, { bytes: new Uint8Array([index + 1]) })
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
})
