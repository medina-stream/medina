/** Read-only access to one S3-compatible object bucket. */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

export interface BucketObject {
  readonly key: string
  readonly size: number | null
  readonly etag: string | null
  readonly lastModified: string | null
}

export class Bucket extends Context.Service<Bucket, {
  readonly list: (prefix: string, limit: number) => Effect.Effect<ReadonlyArray<BucketObject>, Error>
  readonly download: (key: string) => Effect.Effect<Stream.Stream<Uint8Array, Error>, Error>
}>()("medina/Bucket") {}

export const layer: Layer.Layer<Bucket, Config.ConfigError> = Layer.effect(Bucket)(
  Effect.gen(function*() {
    const endpoint = yield* Config.string("BUCKET_ENDPOINT").pipe(Config.withDefault("http://127.0.0.1"))
    const bucket = yield* Config.string("BUCKET_NAME").pipe(Config.withDefault("disabled"))
    const region = yield* Config.string("BUCKET_REGION").pipe(Config.withDefault("us-east-1"))
    const accessKeyId = yield* Config.string("BUCKET_ACCESS_KEY_ID").pipe(Config.withDefault("disabled"))
    const secretAccessKey = yield* Config.string("BUCKET_SECRET_ACCESS_KEY").pipe(Config.withDefault("disabled"))
    const forcePathStyle = yield* Config.boolean("BUCKET_FORCE_PATH_STYLE").pipe(Config.withDefault(true))
    const client = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    })
    const asError = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause))

    return {
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
      }))
    }
  })
)
