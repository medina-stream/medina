/**
 * Per-job R2 credentials, minted through the Cloudflare API.
 *
 * The archive bucket's standing credential never leaves this host (it is
 * edge-injected and signs nothing external). When an outside service (a
 * transcoding vendor) must touch the bucket, it gets a temporary credential
 * scoped to exactly the objects/prefixes a job names, expiring on its own.
 * A leaked job credential exposes one capture for a couple of hours -- not
 * the archive.
 *
 * The mint rides the Cloudflare API (edge-injected token via
 * `CLOUDFLARE_API_URL`, default the exe.dev integration host), so no
 * Cloudflare secret lands on the VM either. `R2_PARENT_ACCESS_KEY_ID` names
 * the parent R2 token the temp credentials derive from; only its key *id*
 * is needed here, never its secret.
 */
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export class TempCredentials extends Schema.Class<TempCredentials>("TempCredentials")({
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  sessionToken: Schema.String
}) {}

export interface MintOptions {
  readonly permission: "object-read-only" | "object-read-write"
  readonly ttlSeconds: number
  readonly objects?: ReadonlyArray<string>
  readonly prefixes?: ReadonlyArray<string>
}

export class R2TempCreds extends Context.Service<R2TempCreds, {
  readonly configured: boolean
  /** S3 endpoint external holders of minted credentials must use. */
  readonly endpoint: string
  readonly bucket: string
  readonly mint: (options: MintOptions) => Effect.Effect<TempCredentials, Error>
}>()("medina/R2TempCreds") {}

const Response = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.String })),
  result: Schema.NullOr(Schema.Struct({
    accessKeyId: Schema.optional(Schema.String),
    secretAccessKey: Schema.optional(Schema.String),
    sessionToken: Schema.optional(Schema.String)
  }))
})

const NOT_CONFIGURED =
  "R2 temp credentials are not configured: set R2_ACCOUNT_ID and R2_PARENT_ACCESS_KEY_ID "
  + "(and the Cloudflare API token must carry R2 read/write)"

export const layer: Layer.Layer<R2TempCreds, Config.ConfigError> = Layer.effect(R2TempCreds)(
  Effect.gen(function*() {
    const optional = (name: string) =>
      Effect.map(Config.option(Config.string(name)), (value) => Option.getOrNull(value)?.trim() || null)
    const apiUrl = ((yield* optional("CLOUDFLARE_API_URL")) ?? "https://cloudflare.int.exe.xyz").replace(/\/$/, "")
    const accountId = yield* optional("R2_ACCOUNT_ID")
    const parentAccessKeyId = yield* optional("R2_PARENT_ACCESS_KEY_ID")
    const bucket = (yield* optional("BUCKET_NAME")) ?? ""
    const configured = accountId !== null && parentAccessKeyId !== null && bucket !== ""
    return {
      configured,
      endpoint: accountId === null ? "" : `https://${accountId}.r2.cloudflarestorage.com`,
      bucket,
      mint: (options) =>
        !configured
          ? Effect.fail(new Error(NOT_CONFIGURED))
          : Effect.tryPromise({
            try: async () => {
              const response = await fetch(
                `${apiUrl}/client/v4/accounts/${accountId}/r2/temp-access-credentials`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    bucket,
                    parentAccessKeyId,
                    permission: options.permission,
                    ttlSeconds: options.ttlSeconds,
                    ...(options.objects === undefined ? {} : { objects: options.objects }),
                    ...(options.prefixes === undefined ? {} : { prefixes: options.prefixes })
                  })
                }
              )
              const body = Schema.decodeUnknownSync(Response)(await response.json())
              if (!body.success || body.result === null) {
                throw new Error(`temp credential mint failed: ${body.errors.map((error) => error.message).join("; ")}`)
              }
              const { accessKeyId, secretAccessKey, sessionToken } = body.result
              if (!accessKeyId || !secretAccessKey || !sessionToken) {
                throw new Error("temp credential mint returned an incomplete credential")
              }
              return new TempCredentials({ accessKeyId, secretAccessKey, sessionToken })
            },
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
          })
    }
  })
)
