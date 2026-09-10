/**
 * Remote media work coordinated through signed Transloadit SDK Assemblies.
 *
 * Audio bytes never cross this process for this workflow. Drive imports are
 * fetched by Transloadit from Google's media endpoint, and archived captures
 * are fetched through short-lived R2 URLs. Transloadit writes originals and
 * one-hour Opus chunks straight to R2. Medina keeps only receipts, provenance,
 * and manifests.
 */
import { ApiError, Transloadit } from "transloadit"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Bucket } from "../Bucket.ts"
import * as Files from "../Files.ts"
import { R2TempCreds, type TempCredentials } from "../R2TempCreds.ts"
import {
  captureBlobName,
  dataPath,
  IngestReceipt,
  ingestId,
  ingestReceiptKey,
  Provenance,
  provenanceKey
} from "../lifelog/Resources.ts"
import {
  canonicalMediaKey,
  CHUNK_SECONDS,
  MediaChunk,
  MediaManifest,
  MEDIA_VERSION,
  mediaManifestKey
} from "./Media.ts"

const WORKFLOW_VERSION = "remote-media-v1"
const JOB_TTL_SECONDS = 24 * 60 * 60
const MAX_CHUNKS = 200

export const transloaditReceiptKey = (captureId: string) => `normalize/transloadit/${captureId}.json`
export const transloaditDriveReceiptKey = (fileId: string, version: string) =>
  `ingest/drive-allow-transloadit/${`${fileId}-${version}`.replace(/[^a-zA-Z0-9_-]/g, "")}.json`

/** Optional fields keep receipts from the previous canonical-download flow
 * readable. Such a receipt is upgraded in place after its Assembly completes. */
export class TransloaditReceipt extends Schema.Class<TransloaditReceipt>("TransloaditReceipt")({
  assemblyId: Schema.String,
  assemblySslUrl: Schema.String,
  createdAt: Schema.String,
  mediaVersion: Schema.String,
  workflowVersion: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.Literals(["import", "chunks", "completed"])),
  captureId: Schema.optional(Schema.String),
  originalKey: Schema.optional(Schema.String),
  sourceDurationSeconds: Schema.optional(Schema.NullOr(Schema.Number)),
  previousAssemblyIds: Schema.optional(Schema.Array(Schema.String)),
  completedAt: Schema.optional(Schema.String)
}) {}

export interface RemoteDriveObject {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly modifiedTime: string
  readonly checksum?: string
}

export interface RemoteImportRequest {
  readonly url: string
  readonly headers: ReadonlyArray<string>
}

export type NormalizeResult = "fired" | "pending" | "completed"
export class TransloaditNormalize extends Context.Service<TransloaditNormalize, {
  readonly configured: boolean
  readonly normalize: (captureId: string, blobName: string, sourceDurationSeconds: number | null) =>
    Effect.Effect<NormalizeResult, Error, Bucket | FileSystem.FileSystem>
  readonly ingestDrive: (
    sourceName: string,
    file: RemoteDriveObject,
    request: Effect.Effect<RemoteImportRequest, Error>
  ) => Effect.Effect<NormalizeResult | "cached", Error, Bucket | FileSystem.FileSystem>
}>()("medina/TransloaditNormalize") {}

const optional = (name: string) =>
  Effect.map(Config.option(Config.string(name)), (value) => Option.getOrNull(value)?.trim() || null)

const terminal = (ok: string | undefined) =>
  !["ASSEMBLY_UPLOADING", "ASSEMBLY_EXECUTING", "ASSEMBLY_REPLAYING"].includes(ok ?? "")
const asError = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause))
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null

/** Keep Transloadit's own code/message/reason intact. Avoid serializing the
 * whole Assembly response because merged params can contain ephemeral bearer
 * tokens and R2 credentials. */
export const transloaditErrorText = (assembly: unknown): string => {
  const body = record(assembly)
  const parts = [text(body.error) ?? text(body.code) ?? text(body.ok)]
  for (const field of ["message", "reason", "step", "previousStep"] as const) {
    const value = text(body[field])
    if (value !== null && !parts.includes(value)) parts.push(value)
  }
  return parts.filter((part): part is string => part !== null).join(": ") || "unknown Transloadit error"
}

const resultRows = (assembly: unknown, step: string): ReadonlyArray<Record<string, unknown>> => {
  const results = record(record(assembly).results)
  const rows = results[step]
  return Array.isArray(rows) ? rows.map(record) : []
}

const resultDuration = (assembly: unknown, steps: ReadonlyArray<string>): number | null => {
  for (const step of steps) {
    for (const row of resultRows(assembly, step)) {
      const duration = number(row.duration) ?? number(record(row.meta).duration)
      if (duration !== null && duration > 0) return duration
    }
  }
  for (const row of (Array.isArray(record(assembly).uploads) ? record(assembly).uploads as Array<unknown> : [])) {
    const duration = number(record(record(row).meta).duration)
    if (duration !== null && duration > 0) return duration
  }
  return null
}

const mediaMime = (mimeType: string) => mimeType.startsWith("audio/") || mimeType.startsWith("video/")
const originalKeyFor = (captureId: string, filename: string) =>
  `capture/${captureId}/${captureBlobName(filename)}`
const chunkPrefixFor = (captureId: string) => `media/${MEDIA_VERSION}/${captureId}/`
const remoteChunkKey = (captureId: string, index: number) => `${chunkPrefixFor(captureId)}chunk-${index}.ogg`

const segmentsFor = (durationSeconds: number) => {
  const count = Math.ceil(durationSeconds / CHUNK_SECONDS)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`cannot chunk media with invalid duration ${durationSeconds}`)
  }
  if (count > MAX_CHUNKS) {
    throw new Error(`media duration ${durationSeconds}s exceeds the ${MAX_CHUNKS}-chunk safety limit`)
  }
  return Array.from({ length: count }, (_, index) => ({
    from: index * CHUNK_SECONDS,
    to: Math.min(durationSeconds, (index + 1) * CHUNK_SECONDS)
  }))
}

const s3Store = (r2: R2TempCreds["Service"], write: TempCredentials, use: string, path: string) => ({
  robot: "/s3/store" as const,
  use,
  bucket: r2.bucket,
  bucket_region: "auto",
  host: r2.endpoint,
  no_vhost: true,
  key: write.accessKeyId,
  secret: write.secretAccessKey,
  session_token: write.sessionToken,
  acl: "bucket-default" as const,
  path,
  result: true
})

type TransloaditClient = Pick<Transloadit, "createAssembly" | "getAssembly">

export const layerWithClient = (
  clientOverride?: TransloaditClient
): Layer.Layer<TransloaditNormalize, Config.ConfigError, R2TempCreds> => Layer.effect(
  TransloaditNormalize
)(Effect.gen(function*() {
  const apiKey = yield* optional("TRANSLOADIT_API_KEY")
  const authSecret = yield* optional("TRANSLOADIT_AUTH_SECRET")
  const apiUrl = ((yield* optional("TRANSLOADIT_API_URL")) ?? "https://api2.transloadit.com").replace(/\/$/, "")
  const r2 = yield* R2TempCreds
  const configured = apiKey !== null && authSecret !== null && r2.configured
  const failUnconfigured = () => Effect.fail(new Error(
    "Transloadit remote ingest is not configured: set TRANSLOADIT_API_KEY, TRANSLOADIT_AUTH_SECRET, R2_ACCOUNT_ID, and R2_PARENT_ACCESS_KEY_ID"
  ))
  const client = configured
    ? clientOverride ?? new Transloadit({ authKey: apiKey, authSecret, endpoint: apiUrl, maxRetries: 0 })
    : null

  const sdkError = (operation: string, cause: unknown) => {
    if (cause instanceof ApiError) {
      const exact = [cause.code, cause.rawMessage, cause.reason].filter(
        (part): part is string => typeof part === "string" && part.length > 0
      ).join(": ")
      return new Error(`Transloadit ${operation} failed: ${exact || cause.message}`, { cause })
    }
    return new Error(`Transloadit ${operation} failed: ${asError(cause).message}`, { cause })
  }

  const create = (params: Record<string, unknown>, receipt: Omit<TransloaditReceipt, "assemblyId" | "assemblySslUrl" | "createdAt" | "mediaVersion">) =>
    Effect.gen(function*() {
      const created = yield* Effect.tryPromise({
        try: () => client!.createAssembly({ params }),
        catch: (cause) => sdkError("create", cause)
      })
      const assemblyId = text(created.assembly_id)
      const assemblySslUrl = text(created.assembly_ssl_url)
      if (assemblyId === null || assemblySslUrl === null) {
        return yield* Effect.fail(new Error("Transloadit create returned no assembly receipt"))
      }
      return new TransloaditReceipt({
        ...receipt,
        assemblyId,
        assemblySslUrl,
        createdAt: new Date().toISOString(),
        mediaVersion: MEDIA_VERSION
      })
    })

  const poll = (receipt: TransloaditReceipt) => Effect.tryPromise({
    try: () => client!.getAssembly(receipt.assemblyId),
    catch: (cause) => sdkError("poll", cause)
  })

  const requireCompleted = (receipt: TransloaditReceipt, assembly: unknown) => {
    const body = record(assembly)
    const errorCode = text(body.error) ?? text(body.code)
    if (errorCode !== null || typeof body.errno === "number") {
      return Effect.fail(new Error(
        `Transloadit assembly ${receipt.assemblyId} failed: ${transloaditErrorText(assembly)}`
      ))
    }
    const status = text(body.ok) ?? undefined
    if (!terminal(status) || status === undefined) return Effect.succeed(false)
    if (status !== "ASSEMBLY_COMPLETED") {
      return Effect.fail(new Error(
        `Transloadit assembly ${receipt.assemblyId} failed: ${transloaditErrorText(assembly)}`
      ))
    }
    return Effect.succeed(true)
  }

  const createChunkReceipt = (
    captureId: string,
    sourceKey: string,
    originalKey: string,
    durationSeconds: number,
    previousAssemblyIds: ReadonlyArray<string>
  ) => Effect.gen(function*() {
    const sourceUrl = yield* r2.presignGet(sourceKey, JOB_TTL_SECONDS)
    const write = yield* r2.mint({
      permission: "object-read-write",
      prefixes: [chunkPrefixFor(captureId)],
      ttlSeconds: JOB_TTL_SECONDS
    })
    const segments = segmentsFor(durationSeconds)
    return yield* create({
      auth: { key: apiKey },
      steps: {
        import: {
          robot: "/http/import",
          url: sourceUrl,
          result: true
        },
        split: {
          robot: "/audio/split",
          use: ":import",
          ffmpeg_stack: "v7",
          preset: "empty",
          ffmpeg: { "c:a": "libopus", "b:a": "24k", ar: 16000, ac: 1, f: "ogg", vn: true },
          segments,
          result: true
        },
        store_chunks: s3Store(
          r2,
          write,
          ":split",
          `${chunkPrefixFor(captureId)}chunk-\${file.meta.segment_index}.ogg`
        )
      }
    }, {
      workflowVersion: WORKFLOW_VERSION,
      phase: "chunks",
      captureId,
      originalKey,
      sourceDurationSeconds: durationSeconds,
      previousAssemblyIds: [...previousAssemblyIds]
    })
  })

  const manifestFromCompletedChunks = (
    captureId: string,
    durationSeconds: number,
    assembly: unknown
  ) => Effect.gen(function*() {
    const bucket = yield* Bucket
    const segments = segmentsFor(durationSeconds)
    const splitRows = resultRows(assembly, "split")
    const indexes = splitRows.flatMap((row) => {
      const index = number(record(row.meta).segment_index)
      return index === null ? [] : [index]
    })
    if (splitRows.length !== segments.length || indexes.length !== segments.length) {
      return yield* Effect.fail(new Error(
        `Transloadit completed with ${splitRows.length} chunks for ${captureId}; expected ${segments.length}`
      ))
    }
    const chunks: Array<MediaChunk> = []
    for (const [index, segment] of segments.entries()) {
      if (!indexes.includes(index)) {
        return yield* Effect.fail(new Error(`Transloadit result omitted chunk ${index} for ${captureId}`))
      }
      const key = remoteChunkKey(captureId, index)
      const stored = yield* bucket.head(key)
      if (stored === null || stored.size === null || stored.size <= 0) {
        return yield* Effect.fail(new Error(`Transloadit completed without R2 chunk ${index} for ${captureId}: ${key}`))
      }
      chunks.push(new MediaChunk({
        index,
        key,
        startSeconds: segment.from,
        durationSeconds: segment.to - segment.from
      }))
    }
    const manifest = new MediaManifest({
      captureId,
      version: MEDIA_VERSION,
      createdAt: new Date().toISOString(),
      sourceDurationSeconds: durationSeconds,
      chunks
    })
    yield* Files.writeJson(dataPath(mediaManifestKey(captureId)), manifest)
    return manifest
  })

  const completeReceipt = (path: string, receipt: TransloaditReceipt) => Files.writeJson(
    path,
    new TransloaditReceipt({
      ...receipt,
      phase: "completed",
      completedAt: new Date().toISOString()
    })
  )

  const normalize = (captureId: string, blobName: string, sourceDurationSeconds: number | null) =>
    !configured ? failUnconfigured() : Effect.gen(function*() {
      const bucket = yield* Bucket
      const path = dataPath(transloaditReceiptKey(captureId))
      const existing = yield* Files.readJson(TransloaditReceipt, path)
      const originalKey = originalKeyFor(captureId, blobName)

      if (Option.isNone(existing)) {
        if (sourceDurationSeconds === null) {
          return yield* Effect.fail(new Error(`no media duration available for ${captureId}`))
        }
        const original = yield* bucket.head(originalKey)
        if (original === null) return yield* Effect.fail(new Error(`archived blob missing for ${captureId}: ${originalKey}`))
        const receipt = yield* createChunkReceipt(captureId, originalKey, originalKey, sourceDurationSeconds, [])
        yield* Files.writeJson(path, receipt)
        return "fired" as const
      }

      const receipt = existing.value
      if (receipt.phase === "completed") return "completed" as const
      const assembly = yield* poll(receipt)
      if (!(yield* requireCompleted(receipt, assembly))) return "pending" as const

      // Upgrade a receipt from the old canonical-output implementation
      // without downloading canonical.ogg back through this host.
      if (receipt.workflowVersion !== WORKFLOW_VERSION || receipt.phase === undefined) {
        const canonicalKey = canonicalMediaKey(captureId)
        const canonical = yield* bucket.head(canonicalKey)
        if (canonical === null || canonical.size === null || canonical.size <= 0) {
          return yield* Effect.fail(new Error(`Transloadit completed without canonical output for ${captureId}`))
        }
        const duration = sourceDurationSeconds ?? resultDuration(assembly, ["encode", "store"])
        if (duration === null) return yield* Effect.fail(new Error(`Transloadit returned no duration for ${captureId}`))
        const next = yield* createChunkReceipt(captureId, canonicalKey, originalKey, duration, [receipt.assemblyId])
        yield* Files.writeJson(path, next)
        return "fired" as const
      }

      if (receipt.phase !== "chunks" || receipt.sourceDurationSeconds == null) {
        return yield* Effect.fail(new Error(`invalid Transloadit receipt for ${captureId}: phase ${receipt.phase ?? "missing"}`))
      }
      yield* manifestFromCompletedChunks(captureId, receipt.sourceDurationSeconds, assembly)
      yield* completeReceipt(path, receipt)
      return "completed" as const
    })

  const ingestDrive = (
    sourceName: string,
    file: RemoteDriveObject,
    request: Effect.Effect<RemoteImportRequest, Error>
  ) => !configured ? failUnconfigured() : Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const bucket = yield* Bucket
    const version = file.checksum ?? file.modifiedTime
    const finalReceiptPath = dataPath(ingestReceiptKey(sourceName, file.id, version))
    if (yield* fs.exists(finalReceiptPath)) return "cached" as const

    const captureId = ingestId(sourceName, file.id, version)
    const originalKey = originalKeyFor(captureId, file.name)
    const jobReceiptPath = dataPath(transloaditDriveReceiptKey(file.id, version))
    const existing = yield* Files.readJson(TransloaditReceipt, jobReceiptPath)

    if (Option.isNone(existing)) {
      const remote = yield* request
      const write = yield* r2.mint({
        permission: "object-read-write",
        objects: [originalKey],
        ttlSeconds: JOB_TTL_SECONDS
      })
      const receipt = yield* create({
        auth: { key: apiKey },
        steps: {
          import: {
            robot: "/http/import",
            url: remote.url,
            headers: remote.headers,
            result: true
          },
          store_original: s3Store(r2, write, ":import", originalKey)
        }
      }, {
        workflowVersion: WORKFLOW_VERSION,
        phase: "import",
        captureId,
        originalKey,
        sourceDurationSeconds: null,
        previousAssemblyIds: []
      })
      yield* Files.writeJson(jobReceiptPath, receipt)
      return "fired" as const
    }

    let receipt = existing.value
    if (receipt.phase === "completed") {
      // A crash can happen after the job receipt is completed but before the
      // source receipt/provenance are committed. Finalization is idempotent.
    } else {
      const assembly = yield* poll(receipt)
      if (!(yield* requireCompleted(receipt, assembly))) return "pending" as const

      if (receipt.phase === "import") {
        const original = yield* bucket.head(originalKey)
        if (original === null || original.size === null || original.size <= 0) {
          return yield* Effect.fail(new Error(`Transloadit completed without R2 original for ${captureId}: ${originalKey}`))
        }
        if (mediaMime(file.mimeType)) {
          const duration = resultDuration(assembly, ["import", "store_original"])
          if (duration === null) {
            return yield* Effect.fail(new Error(`Transloadit returned no media duration for ${file.name} (${file.id})`))
          }
          receipt = yield* createChunkReceipt(captureId, originalKey, originalKey, duration, [receipt.assemblyId])
          yield* Files.writeJson(jobReceiptPath, receipt)
          return "fired" as const
        }
        yield* completeReceipt(jobReceiptPath, receipt)
        receipt = new TransloaditReceipt({ ...receipt, phase: "completed", completedAt: new Date().toISOString() })
      } else if (receipt.phase === "chunks" && receipt.sourceDurationSeconds != null) {
        yield* manifestFromCompletedChunks(captureId, receipt.sourceDurationSeconds, assembly)
        yield* completeReceipt(jobReceiptPath, receipt)
        receipt = new TransloaditReceipt({ ...receipt, phase: "completed", completedAt: new Date().toISOString() })
      } else {
        return yield* Effect.fail(new Error(
          `invalid Transloadit Drive receipt for ${file.id}: phase ${receipt.phase ?? "missing"}`
        ))
      }
    }

    const provenance = yield* Files.readJson(Provenance, dataPath(provenanceKey(captureId)))
    const records = Option.isSome(provenance) ? provenance.value.records : []
    const seen = records.some((entry) =>
      entry.source === sourceName && entry.fileId === file.id && entry.filename === file.name
    )
    if (!seen) {
      yield* Files.writeJson(dataPath(provenanceKey(captureId)), new Provenance({
        captureId,
        records: [...records, {
          source: sourceName,
          filename: file.name,
          fileId: file.id,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
          md5Checksum: file.checksum ?? null,
          fetchedAt: new Date().toISOString()
        }]
      }))
    }
    yield* Files.writeJson(finalReceiptPath, new IngestReceipt({
      captureId,
      ingestedAt: new Date().toISOString()
    }))
    return "completed" as const
  })

  return { configured, normalize, ingestDrive }
}))

export const layer = layerWithClient()
