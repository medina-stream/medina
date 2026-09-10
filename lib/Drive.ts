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

/** One item from a full-drive metadata crawl: `DriveFile` plus placement. */
export class DriveItem extends Schema.Class<DriveItem>("DriveItem")({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  modifiedTime: Schema.String,
  md5Checksum: Schema.optional(Schema.String),
  size: Schema.optional(Schema.String),
  parents: Schema.optional(Schema.Array(Schema.String))
}) {}

const FileList = Schema.Struct({ files: Schema.Array(DriveFile) })
const ItemPage = Schema.Struct({
  nextPageToken: Schema.optional(Schema.String),
  files: Schema.Array(DriveItem)
})
const Token = Schema.Struct({ access_token: Schema.String })

export interface DriveImportRequest {
  /** Google Drive media endpoint. Transloadit, not Medina, reads this URL. */
  readonly url: string
  /** Short-lived authorization headers; callers must never persist or log them. */
  readonly headers: ReadonlyArray<string>
}

export class Drive extends Context.Service<Drive, {
  readonly list: (folderId: string, pageSize: number) => Effect.Effect<ReadonlyArray<DriveFile>, Error>
  /**
   * Every non-trashed item visible to the credential, metadata only — the
   * inspection surface. Nothing here can read content: inventorying a
   * whole Drive must be structurally unable to ingest it.
   */
  readonly listAll: Effect.Effect<ReadonlyArray<DriveItem>, Error>
  /**
   * Mint a short-lived request Transloadit can use to import a private Drive
   * object directly. The bearer token is ephemeral and must not be persisted.
   */
  readonly importRequest: (fileId: string) => Effect.Effect<DriveImportRequest, Error>
  readonly download: (fileId: string) => Effect.Effect<Stream.Stream<Uint8Array, Error>, Error>
}>()("medina/Drive") {}

export const layer: Layer.Layer<Drive, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(Drive)(
  Effect.gen(function*() {
    const tokenUrl = yield* Config.string("GOOGLE_TOKEN_URL").pipe(Config.withDefault("http://127.0.0.1/disabled-google-token"))
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const asError = (cause: unknown) => new Error("Google Drive request failed", { cause })

    // The mint yields a short-lived (~1h) token, and `token` below would
    // otherwise re-run the mint POST on every list/download. Cache it with
    // a TTL that refreshes ahead of expiry: the hourly pass pays ~one mint
    // per 50 minutes instead of one per file. Plain `Effect.cached` would
    // pin the first token for the process lifetime and eventually serve a
    // dead one.
    const token = yield* client.post(tokenUrl).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Token)),
      Effect.map((body) => body.access_token),
      Effect.cachedWithTTL("50 minutes")
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

      listAll: Effect.gen(function*() {
        const items: Array<DriveItem> = []
        let pageToken: string | undefined
        do {
          const request = (yield* authorized("https://www.googleapis.com/drive/v3/files")).pipe(
            HttpClientRequest.setUrlParams({
              q: "trashed = false",
              pageSize: "1000",
              fields: "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,parents)",
              ...(pageToken === undefined ? {} : { pageToken })
            })
          )
          const page = yield* client.execute(request).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ItemPage))
          )
          items.push(...page.files)
          pageToken = page.nextPageToken
        } while (pageToken !== undefined)
        return items as ReadonlyArray<DriveItem>
      }).pipe(Effect.mapError(asError)),

      importRequest: (fileId) =>
        Effect.map(token, (accessToken) => ({
          url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
          headers: [`Authorization: Bearer ${accessToken}`]
        })),

      download: (fileId) =>
        authorized(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`).pipe(
          Effect.flatMap((request) => client.execute(request)),
          Effect.map((response) => Stream.mapError(response.stream, asError)),
          Effect.mapError(asError)
        )
    }
  })
)
