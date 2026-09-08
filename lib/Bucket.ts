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
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3"
import { createReadStream } from "node:fs"
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

export const layer: Layer.Layer<Bucket, Config.ConfigError> = Layer.effect(Bucket)(
  Effect.gen(function*() {
    const optional = (name: string) =>
      Effect.map(
        Config.option(Config.string(name)),
        (value) => Option.getOrNull(value)?.trim() || null
      )
    const bucket = yield* optional("BUCKET_NAME")
    // "disabled" grandfathers earlier configs that used it as an explicit off.
    if (!bucket || bucket === "disabled") {
      return unconfigured
    }
    const endpoint = yield* optional("BUCKET_ENDPOINT")
    // Keyless is a real configuration: an edge-signing endpoint (e.g. an
    // exe.dev s3 integration) injects credentials at the network boundary
    // and ignores the SDK's signature. The SDK still requires credential
    // strings to build a request, so placeholders stand in. Against a real
    // S3 endpoint the placeholders fail per-operation, which the archive
    // stage surfaces — misconfiguration is visible either way.
    const accessKeyId = (yield* optional("BUCKET_ACCESS_KEY_ID")) ?? "edge-injected"
    const secretAccessKey = (yield* optional("BUCKET_SECRET_ACCESS_KEY")) ?? "edge-injected"
    const region = (yield* optional("BUCKET_REGION")) ?? "us-east-1"
    const forcePathStyle = yield* Config.boolean("BUCKET_FORCE_PATH_STYLE").pipe(Config.withDefault(true))
    const client = new S3Client({
      ...(endpoint === null ? {} : { endpoint }),
      region,
      forcePathStyle,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    })

    return {
      configured: true,

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
      }),

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
          const size = (await Bun.file(path).stat()).size
          const response = await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: createReadStream(path),
            ContentLength: size,
            ...(contentType === undefined ? {} : { ContentType: contentType })
          }))
          return response.ETag?.replace(/^"|"$/g, "") ?? null
        },
        catch: asError
      })
    }
  })
)

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
      }),
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

const md5Hex = (bytes: Uint8Array) => {
  const hasher = new Bun.CryptoHasher("md5")
  hasher.update(bytes)
  return hasher.digest("hex")
}
