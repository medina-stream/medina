/**
 * Google Drive access via the exe.dev service-account token mint: POST to the
 * token URL yields a short-lived access token used directly against the Drive
 * API.
 */
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

export class DriveFile extends Schema.Class<DriveFile>("DriveFile")({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  modifiedTime: Schema.String,
  md5Checksum: Schema.optional(Schema.String),
  size: Schema.optional(Schema.String)
}) {}

const FileList = Schema.Struct({ files: Schema.Array(DriveFile) })
const Token = Schema.Struct({ access_token: Schema.String })

export class Drive extends Context.Service<Drive, {
  readonly list: (folderId: string, pageSize: number) => Effect.Effect<ReadonlyArray<DriveFile>, Error>
  readonly download: (fileId: string) => Effect.Effect<Stream.Stream<Uint8Array, Error>, Error>
}>()("medina/Drive") {}

export const layer: Layer.Layer<Drive, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(Drive)(
  Effect.gen(function*() {
    const tokenUrl = yield* Config.string("GOOGLE_TOKEN_URL")
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const asError = (cause: unknown) => new Error("Google Drive request failed", { cause })

    const token = client.post(tokenUrl).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Token)),
      Effect.map((body) => body.access_token)
    )

    const authorized = (url: string) =>
      Effect.map(token, (accessToken) =>
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${accessToken}`)
        ))

    return {
      list: (folderId, pageSize) =>
        authorized("https://www.googleapis.com/drive/v3/files").pipe(
          Effect.map(HttpClientRequest.setUrlParams({
            q: `'${folderId}' in parents and trashed = false`,
            orderBy: "modifiedTime desc",
            pageSize: `${pageSize}`,
            fields: "files(id,name,mimeType,modifiedTime,md5Checksum,size)"
          })),
          Effect.flatMap((request) => client.execute(request)),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(FileList)),
          Effect.map((body) => body.files.filter((file) => !file.mimeType.startsWith("application/vnd.google-apps."))),
          Effect.mapError(asError)
        ),

      download: (fileId) =>
        authorized(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`).pipe(
          Effect.flatMap((request) => client.execute(request)),
          Effect.map((response) => Stream.mapError(response.stream, asError)),
          Effect.mapError(asError)
        )
    }
  })
)
