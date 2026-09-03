import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

export class VendorTranscript extends Schema.Class<VendorTranscript>("VendorTranscript")({
  id: Schema.String,
  status: Schema.Literals(["queued", "processing", "completed", "error"]),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  utterances: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({
    speaker: Schema.optional(Schema.NullOr(Schema.String)),
    start: Schema.Number,
    end: Schema.Number,
    text: Schema.String,
    confidence: Schema.optional(Schema.NullOr(Schema.Number))
  })))),
  error: Schema.optional(Schema.NullOr(Schema.String))
}) {}

const Upload = Schema.Struct({ upload_url: Schema.String })

export class AssemblyAI extends Context.Service<AssemblyAI, {
  readonly transcribe: (audio: Stream.Stream<Uint8Array, Error>) => Effect.Effect<VendorTranscript, Error>
}>()("medina/AssemblyAI") {}

export const layer: Layer.Layer<AssemblyAI, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(AssemblyAI)(
  Effect.gen(function*() {
    const baseUrl = (yield* Config.string("ASSEMBLYAI_API_URL")).replace(/\/$/, "")
    const apiKey = yield* Config.string("ASSEMBLYAI_API_KEY").pipe(Config.withDefault(""))
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) => apiKey ? HttpClientRequest.setHeader(request, "authorization", apiKey) : request)
    )
    const asError = (cause: unknown) => new Error("AssemblyAI request failed", { cause })

    // Only transport-level and 5xx failures are worth retrying: a 4xx or a
    // bad body will fail the same way next second. Previously any of these
    // on upload/submit failed the whole file until the next hourly pass
    // re-uploaded it.
    const isTransient = (error: unknown) =>
      error instanceof HttpClientError.HttpClientError &&
      (error.reason._tag === "TransportError" ||
        (error.reason._tag === "StatusCodeError" && error.reason.response.status >= 500))
    const retryTransient = {
      while: isTransient,
      schedule: Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(3)])
    } as const

    const getTranscript = (id: string) =>
      client.get(`${baseUrl}/v2/transcript/${encodeURIComponent(id)}`).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(VendorTranscript)),
        Effect.mapError(asError)
      )

    return {
      transcribe: (audio) =>
        Effect.gen(function*() {
          const upload = yield* client.post(`${baseUrl}/v2/upload`, {
            body: HttpBody.stream(audio, "application/octet-stream")
          }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Upload)),
            Effect.retry(retryTransient),
            Effect.mapError(asError)
          )

          const submitted = yield* client.post(`${baseUrl}/v2/transcript`, {
            body: HttpBody.jsonUnsafe({
              audio_url: upload.upload_url,
              speech_models: ["universal-3-5-pro"],
              speaker_labels: true,
              language_detection: true
            })
          }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(VendorTranscript)),
            Effect.retry(retryTransient),
            Effect.mapError(asError)
          )

          return yield* getTranscript(submitted.id).pipe(
            Effect.flatMap((transcript) =>
              transcript.status === "completed" || transcript.status === "error"
                ? Effect.succeed(transcript)
                : Effect.fail(new Pending(transcript.id))
            ),
            Effect.retry({
              while: (error) => error instanceof Pending,
              schedule: Schedule.spaced("10 seconds").pipe(Schedule.upTo({ duration: "2 hours" }))
            }),
            Effect.mapError((error) =>
              error instanceof Pending ? new Error(`AssemblyAI transcript ${error.id} did not finish in time`) : error
            )
          )
        })
    }
  })
)

class Pending extends Error {
  readonly id: string
  constructor(id: string) {
    super(`transcript ${id} still processing`)
    this.id = id
  }
}
