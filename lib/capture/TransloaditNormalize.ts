/** Transloadit-backed normalization. Credentials in receipts are deliberately
 * excluded: receipts only coordinate polling and can safely be discarded. */
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { Bucket } from "../Bucket.ts"
import * as Files from "../Files.ts"
import { R2TempCreds } from "../R2TempCreds.ts"
import { dataPath } from "../lifelog/Resources.ts"
import { canonicalMediaKey, MEDIA_VERSION, mediaManifestKey, segmentToChunks } from "./Media.ts"

const TTL_SECONDS = 7200
export const transloaditReceiptKey = (captureId: string) => `normalize/transloadit/${captureId}.json`

export class TransloaditReceipt extends Schema.Class<TransloaditReceipt>("TransloaditReceipt")({
  assemblyId: Schema.String,
  assemblySslUrl: Schema.String,
  createdAt: Schema.String,
  mediaVersion: Schema.String
}) {}

export type NormalizeResult = "fired" | "pending" | "completed"
export class TransloaditNormalize extends Context.Service<TransloaditNormalize, {
  readonly configured: boolean
  readonly normalize: (captureId: string, blobName: string, sourceDurationSeconds: number | null) =>
    Effect.Effect<NormalizeResult, Error, Bucket | FileSystem.FileSystem>
}>()("medina/TransloaditNormalize") {}

const optional = (name: string) =>
  Effect.map(Config.option(Config.string(name)), (value) => Option.getOrNull(value)?.trim() || null)

const terminal = (ok: string | undefined) => !["ASSEMBLY_UPLOADING", "ASSEMBLY_EXECUTING", "ASSEMBLY_REPLAYING"].includes(ok ?? "")
const asError = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause))

const responseJson = async (response: Response): Promise<Record<string, unknown>> => {
  const body = await response.json()
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid Transloadit response")
  return body as Record<string, unknown>
}

export const layer: Layer.Layer<TransloaditNormalize, Config.ConfigError, R2TempCreds> = Layer.effect(
  TransloaditNormalize
)(Effect.gen(function*() {
  const apiKey = yield* optional("TRANSLOADIT_API_KEY")
  const apiUrl = ((yield* optional("TRANSLOADIT_API_URL")) ?? "https://api2.transloadit.com").replace(/\/$/, "")
  const r2 = yield* R2TempCreds
  const configured = apiKey !== null && r2.configured
  const failUnconfigured = () => Effect.fail(new Error(
    "Transloadit normalization is not configured: set TRANSLOADIT_API_KEY, R2_ACCOUNT_ID, and R2_PARENT_ACCESS_KEY_ID"
  ))
  return {
    configured,
    normalize: (captureId, blobName, sourceDurationSeconds) => !configured ? failUnconfigured() : Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const bucket = yield* Bucket
      const receipt = yield* Files.readJson(TransloaditReceipt, dataPath(transloaditReceiptKey(captureId))).pipe(
        Effect.orElseSucceed(() => Option.none<TransloaditReceipt>())
      )
      const canonicalKey = canonicalMediaKey(captureId)
      if (Option.isNone(receipt)) {
        const sourceKey = `capture/${captureId}/${blobName}`
        if ((yield* bucket.head(sourceKey)) === null) {
          return yield* Effect.fail(new Error(`archived blob missing for ${captureId}: ${sourceKey}`))
        }
        const url = yield* r2.presignGet(sourceKey, TTL_SECONDS)
        const write = yield* r2.mint({
          permission: "object-read-write",
          prefixes: [`media/${MEDIA_VERSION}/${captureId}/`],
          ttlSeconds: TTL_SECONDS
        })
        const params = {
          auth: { key: apiKey },
          steps: {
            import: { robot: "/http/import", url },
            encode: {
              robot: "/audio/encode", use: ":import",
              ffmpeg_stack: "v7", preset: "empty",
              ffmpeg: { "c:a": "libopus", "b:a": "24k", ar: 16000, ac: 1, f: "ogg", vn: true }
            },
            store: {
              robot: "/s3/store", use: ":encode", bucket: r2.bucket, bucket_region: "auto",
              host: r2.endpoint, no_vhost: true, key: write.accessKeyId,
              secret: write.secretAccessKey, session_token: write.sessionToken, path: canonicalKey
            }
          }
        }
        const created = yield* Effect.tryPromise({
          try: async () => {
            const form = new FormData()
            form.set("params", JSON.stringify(params))
            const response = await fetch(`${apiUrl}/assemblies`, { method: "POST", body: form })
            if (!response.ok) throw new Error(`Transloadit create failed (${response.status})`)
            return responseJson(response)
          }, catch: asError
        })
        const assemblyId = typeof created.assembly_id === "string" ? created.assembly_id : null
        const assemblySslUrl = typeof created.assembly_ssl_url === "string" ? created.assembly_ssl_url : null
        if (!assemblyId || !assemblySslUrl) return yield* Effect.fail(new Error("Transloadit create returned no assembly receipt"))
        yield* Files.writeJson(dataPath(transloaditReceiptKey(captureId)), new TransloaditReceipt({
          assemblyId, assemblySslUrl, createdAt: new Date().toISOString(), mediaVersion: MEDIA_VERSION
        }))
        return "fired" as const
      }
      const polled = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(receipt.value.assemblySslUrl)
          if (response.status === 404) return { vanished: true } as Record<string, unknown>
          if (!response.ok) throw new Error(`Transloadit poll failed (${response.status})`)
          return responseJson(response)
        }, catch: asError
      })
      if (polled.vanished === true || (terminal(typeof polled.ok === "string" ? polled.ok : undefined) && polled.ok !== "ASSEMBLY_COMPLETED")) {
        yield* fs.remove(dataPath(transloaditReceiptKey(captureId)), { force: true }).pipe(Effect.ignore)
        return yield* Effect.fail(new Error(`Transloadit assembly ${receipt.value.assemblyId} failed or vanished`))
      }
      if (polled.ok !== "ASSEMBLY_COMPLETED") return "pending" as const
      const canonical = yield* bucket.head(canonicalKey)
      if (canonical === null || canonical.size === null || canonical.size <= 0) {
        return yield* Effect.fail(new Error(`Transloadit completed without canonical output for ${captureId}`))
      }
      const temp = dataPath(`tmp/transloadit-${captureId.slice(0, 12)}-${Date.now()}.ogg`)
      const bytes = yield* bucket.download(canonicalKey).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.map((chunks) => {
          const parts = chunks
          const total = parts.reduce((size, part) => size + part.length, 0)
          const result = new Uint8Array(total)
          let offset = 0
          for (const part of parts) { result.set(part, offset); offset += part.length }
          return result
        })
      )
      yield* Effect.tryPromise({ try: () => Bun.write(temp, bytes), catch: asError })
      const manifest = yield* segmentToChunks(captureId, temp, { copy: true, sourceDurationSeconds }).pipe(
        Effect.ensuring(
          Effect.tryPromise({ try: () => Bun.file(temp).delete(), catch: asError }).pipe(Effect.ignore)
        )
      )
      if (!(yield* fs.exists(dataPath(mediaManifestKey(captureId))))) {
        return yield* Effect.fail(new Error(`manifest was not written for ${captureId}`))
      }
      yield* fs.remove(dataPath(transloaditReceiptKey(captureId)), { force: true }).pipe(Effect.ignore)
      return manifest.chunks.length > 0 ? "completed" as const : yield* Effect.fail(new Error("empty Transloadit manifest"))
    })
  }
}))
