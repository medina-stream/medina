/**
 * One S3-compatible object bucket: the durable home for capture bytes.
 *
 * The filesystem doctrine (see README) is amended, not reversed: the local
 * data dir remains the working set and derivation cache, but born evidence
 * -- audio blobs and their provenance -- must also live in the bucket,
 * because a VM disk is not an archive. Keys in the bucket mirror artifact
 * keys exactly (`capture/<sha256>/<blob>`), so the bucket is readable with
 * nothing but this repo and `aws s3 ls`.
 *
 * An unconfigured bucket still builds (so tests and read-only work run
 * without credentials), but `configured` is false and every operation fails
 * with instructions. Callers that archive best-effort log and move on; the
 * sweep stage fails visibly in pipeline status until the bucket exists.
 *
 * A second bucket can be attached as a *source*: `SourceBucket` (below)
 * lists and downloads from it, and its API has no write operations at all,
 * so the pipeline physically cannot store anything there. The capture app's
 * bucket is attached this way -- medina ingests from it, never writes to it.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3"
import { open } from "node:fs/promises"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"

export interface BucketObject {
  readonly key: string
  readonly size: number | null
  readonly etag: string | null
  readonly lastModified: string | null
}

export interface BucketApi {
  /** False when credentials are absent; operations then fail with setup help. */
  readonly configured: boolean
  readonly list: (prefix: string, limit: number) => Effect.Effect<ReadonlyArray<BucketObject>, Error>
  readonly download: (key: string) => Effect.Effect<Stream.Stream<Uint8Array, Error>, Error>
  /** The object's metadata, or null when absent. */
  readonly head: (key: string) => Effect.Effect<BucketObject | null, Error>
  /** Resolves to the stored object's etag when the store reports one. */
  readonly put: (key: string, bytes: Uint8Array, contentType?: string) => Effect.Effect<string | null, Error>
  /** Streamed from disk: capture blobs can be hundreds of MB. */
  readonly putFile: (key: string, path: string, contentType?: string) => Effect.Effect<string | null, Error>
}

export class Bucket extends Context.Service<Bucket, BucketApi>()("medina/Bucket") {}

const NOT_CONFIGURED = "bucket is not configured: set BUCKET_NAME and BUCKET_ENDPOINT "
  + "(plus BUCKET_ACCESS_KEY_ID/BUCKET_SECRET_ACCESS_KEY unless the endpoint "
  + "signs at the network edge, like an exe.dev s3 integration)"

const asError = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause))

const unconfigured: BucketApi = {
  configured: false,
  list: () => Effect.fail(new Error(NOT_CONFIGURED)),
  download: () => Effect.fail(new Error(NOT_CONFIGURED)),
  head: () => Effect.fail(new Error(NOT_CONFIGURED)),
  put: () => Effect.fail(new Error(NOT_CONFIGURED)),
  putFile: () => Effect.fail(new Error(NOT_CONFIGURED))
}

interface S3Connection {
  readonly bucket: string | null
  readonly endpoint: string | null
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly region: string
  readonly forcePathStyle: boolean
}

const readS3Connection = (
  prefix: "BUCKET" | "SOURCE_BUCKET",
  regionDefault: string
): Effect.Effect<S3Connection, Config.ConfigError> =>
  Effect.gen(function*() {
    const optional = (name: string) =>
      Effect.map(
        Config.option(Config.string(`${prefix}_${name}`)),
        (value) => Option.getOrNull(value)?.trim() || null
      )
    // Keyless is a real configuration: an edge-signing endpoint (e.g. an
    // exe.dev s3 integration) injects credentials at the network boundary
    // and ignores the SDK's signature. The SDK still requires credential
    // strings to build a request, so placeholders stand in. Against a real
    // S3 endpoint the placeholders fail per-operation, which the stages
    // surface -- misconfiguration is visible either way.
    return {
      bucket: yield* optional("NAME"),
      endpoint: yield* optional("ENDPOINT"),
      accessKeyId: (yield* optional("ACCESS_KEY_ID")) ?? "edge-injected",
      secretAccessKey: (yield* optional("SECRET_ACCESS_KEY")) ?? "edge-injected",
      region: (yield* optional("REGION")) ?? regionDefault,
      forcePathStyle: yield* Config.boolean(`${prefix}_FORCE_PATH_STYLE`).pipe(Config.withDefault(true))
    }
  })

const makeS3Client = (connection: Omit<S3Connection, "bucket">): S3Client =>
  new S3Client({
    ...(connection.endpoint === null ? {} : { endpoint: connection.endpoint }),
    region: connection.region,
    forcePathStyle: connection.forcePathStyle,
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey
    }
  })

/** The read half of an S3 bucket: list, download, head. Shared by both buckets. */
const s3ReadApi = (
  client: S3Client,
  bucket: string
): Pick<BucketApi, "list" | "download" | "head"> => ({
  list: (prefix, limit) => Effect.tryPromise({
    try: async () => {
      if (limit <= 0) return []
      const objects: Array<BucketObject> = []
      let continuationToken: string | undefined
      do {
        const response = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken })
        }))
        objects.push(...(response.Contents ?? []).flatMap((object) => object.Key === undefined ? [] : [{
          key: object.Key,
          size: object.Size ?? null,
          etag: object.ETag?.replace(/^"|"$/g, "") ?? null,
          lastModified: object.LastModified?.toISOString() ?? null
        }]))
        continuationToken = response.NextContinuationToken
      } while (continuationToken !== undefined)
      return objects
        // Newest-first: ingest priority is newest data first -- newer
        // captures are almost always more valuable. This can't starve older
        // objects the way the old fixed-window sort did: discovery filters
        // receipted objects before the per-pass slice, so the window always
        // advances and a backlog always drains.
        .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""))
        .slice(0, limit)
    },
    catch: asError
  }),

  download: (key) => Effect.tryPromise({
    try: () => client.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
    catch: asError
  }).pipe(Effect.flatMap((response) => {
    const body = response.Body
    if (body === undefined || !(Symbol.asyncIterator in body)) {
      return Effect.fail(new Error(`bucket object has no streaming body: ${key}`))
    }
    return Effect.succeed(Stream.fromAsyncIterable(
      body as AsyncIterable<Uint8Array>,
      asError
    ))
  })),

  head: (key) => Effect.tryPromise({
    try: async () => {
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return {
          key,
          size: response.ContentLength ?? null,
          etag: response.ETag?.replace(/^"|"$/g, "") ?? null,
          lastModified: response.LastModified?.toISOString() ?? null
        }
      } catch (cause) {
        const status = (cause as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        const name = (cause as { name?: string }).name
        if (status === 404 || name === "NotFound" || name === "NoSuchKey") return null
        throw cause
      }
    },
    catch: asError
  })
})

/** The write half of an S3 bucket: put, putFile. Only the archive bucket gets this. */
const s3WriteApi = (
  client: S3Client,
  bucket: string
): Pick<BucketApi, "put" | "putFile"> => ({
  put: (key, bytes, contentType) => Effect.tryPromise({
    try: async () => {
      const response = await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.length,
        ...(contentType === undefined ? {} : { ContentType: contentType })
      }))
      return response.ETag?.replace(/^"|"$/g, "") ?? null
    },
    catch: asError
  }),

  putFile: (key, path, contentType) => Effect.tryPromise({
    try: async () => {
      // The SDK's node-stream body handling stalls under Bun (and web
      // streams trip its hashing), so files are read with positional
      // reads and sent as buffers: one plain put when small, multipart
      // in fixed parts when large. Bounded memory either way, and
      // multipart keeps each HTTP body a signed, sized buffer -- which
      // also suits edge-signing proxies that re-sign whole requests.
      const PART = 8 * 1024 * 1024
      const size = (await Bun.file(path).stat()).size
      if (size <= PART) {
        const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
        const response = await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ...(contentType === undefined ? {} : { ContentType: contentType })
        }))
        return response.ETag?.replace(/^"|"$/g, "") ?? null
      }
      const created = await client.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ...(contentType === undefined ? {} : { ContentType: contentType })
      }))
      try {
        const handle = await open(path, "r")
        const parts: Array<{ ETag: string; PartNumber: number }> = []
        try {
          let offset = 0
          while (offset < size) {
            const length = Math.min(PART, size - offset)
            const buffer = Buffer.alloc(length)
            await handle.read(buffer, 0, length, offset)
            const part = await client.send(new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: created.UploadId,
              PartNumber: parts.length + 1,
              Body: buffer,
              ContentLength: length
            }))
            if (part.ETag === undefined) throw new Error(`part ${parts.length + 1} returned no etag`)
            parts.push({ ETag: part.ETag, PartNumber: parts.length + 1 })
            offset += length
          }
        } finally {
          await handle.close()
        }
        const completed = await client.send(new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: created.UploadId,
          MultipartUpload: { Parts: parts }
        }))
        return completed.ETag?.replace(/^"|"$/g, "") ?? null
      } catch (cause) {
        await client.send(new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: created.UploadId
        })).catch(() => undefined)
        throw cause
      }
    },
    catch: asError
  })
})

export const layer: Layer.Layer<Bucket, Config.ConfigError> = Layer.effect(Bucket)(
  Effect.gen(function*() {
    const connection = yield* readS3Connection("BUCKET", "us-east-1")
    // "disabled" grandfathers earlier configs that used it as an explicit off.
    if (!connection.bucket || connection.bucket === "disabled") {
      return unconfigured
    }
    const client = makeS3Client(connection)
    return {
      configured: true,
      ...s3ReadApi(client, connection.bucket),
      ...s3WriteApi(client, connection.bucket)
    }
  })
)

/**
 * A source-only bucket: medina lists and downloads from it, and the type
 * system makes writes impossible -- this API has no put operations at all.
 * The capture app's bucket is attached this way: medina ingests from it and
 * can never write back, so the app's write-only credential stays meaningful
 * and the bucket stays a pure source of born evidence.
 */
export interface SourceBucketApi {
  /** False when SOURCE_BUCKET_NAME is absent; operations then fail with setup help. */
  readonly configured: boolean
  readonly list: BucketApi["list"]
  readonly download: BucketApi["download"]
  /** The object's metadata, or null when absent. */
  readonly head: BucketApi["head"]
}

export class SourceBucket extends Context.Service<SourceBucket, SourceBucketApi>()("medina/SourceBucket") {}

const SOURCE_NOT_CONFIGURED = "source bucket is not configured: set SOURCE_BUCKET_NAME and SOURCE_BUCKET_ENDPOINT "
  + "(an exe.dev s3 integration signs at the network edge, so no access keys are needed)"

const sourceUnconfigured: SourceBucketApi = {
  configured: false,
  list: () => Effect.fail(new Error(SOURCE_NOT_CONFIGURED)),
  download: () => Effect.fail(new Error(SOURCE_NOT_CONFIGURED)),
  head: () => Effect.fail(new Error(SOURCE_NOT_CONFIGURED))
}

export const sourceLayer: Layer.Layer<SourceBucket, Config.ConfigError> = Layer.effect(SourceBucket)(
  Effect.gen(function*() {
    const connection = yield* readS3Connection("SOURCE_BUCKET", "auto")
    // "disabled" grandfathers the same explicit-off convention as BUCKET_NAME.
    if (!connection.bucket || connection.bucket === "disabled") {
      return sourceUnconfigured
    }
    const client = makeS3Client(connection)
    return {
      configured: true,
      ...s3ReadApi(client, connection.bucket)
    }
  })
)

/** The read half of the in-memory bucket, shared by both memory layers. */
const memoryReadApi = (
  store: Map<string, { bytes: Uint8Array; contentType?: string }>
): Pick<BucketApi, "list" | "download" | "head"> => ({
  list: (prefix, limit) =>
    Effect.sync(() =>
      [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .slice(0, Math.max(0, limit))
        .map(([key, value]) => ({
          key,
          size: value.bytes.length,
          etag: md5Hex(value.bytes),
          lastModified: null
        }))
    ),
  download: (key) => {
    const entry = store.get(key)
    return entry === undefined
      ? Effect.fail(new Error(`no such key: ${key}`))
      : Effect.succeed(Stream.make(entry.bytes))
  },
  head: (key) =>
    Effect.sync(() => {
      const entry = store.get(key)
      return entry === undefined ? null : {
        key,
        size: entry.bytes.length,
        etag: md5Hex(entry.bytes),
        lastModified: null
      }
    })
})

/**
 * An in-memory bucket for tests: the same contract with a Map behind it.
 * The etag is the md5 hex of the bytes, matching a non-multipart S3 put,
 * because the archive sweep compares etags to skip unchanged uploads.
 */
export const layerMemory = (
  store: Map<string, { bytes: Uint8Array; contentType?: string }> = new Map()
): Layer.Layer<Bucket> =>
  Layer.succeed(Bucket)({
    configured: true,
    ...memoryReadApi(store),
    put: (key, bytes, contentType) =>
      Effect.sync(() => {
        store.set(key, { bytes: bytes.slice(), ...(contentType === undefined ? {} : { contentType }) })
        return md5Hex(bytes)
      }),
    putFile: (key, path, contentType) =>
      Effect.tryPromise({
        try: async () => {
          const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
          store.set(key, { bytes, ...(contentType === undefined ? {} : { contentType }) })
          return md5Hex(bytes)
        },
        catch: asError
      })
  })

/**
 * An in-memory source bucket for tests: reads only, like the real thing.
 */
export const sourceLayerMemory = (
  store: Map<string, { bytes: Uint8Array; contentType?: string }> = new Map()
): Layer.Layer<SourceBucket> =>
  Layer.succeed(SourceBucket)({
    configured: true,
    ...memoryReadApi(store)
  })

const md5Hex = (bytes: Uint8Array) => {
  const hasher = new Bun.CryptoHasher("md5")
  hasher.update(bytes)
  return hasher.digest("hex")
}
