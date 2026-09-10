import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
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

/** Parsed fields Medina depends on plus the untouched JSON response. */
export interface AssemblyAIResult {
  readonly transcript: VendorTranscript
  readonly raw: unknown
}

/**
 * URL-only transcription API. AssemblyAI fetches an R2-signed object itself;
 * Medina never uploads audio to AssemblyAI and never waits in-process for a
 * transcript. The pipeline persists the returned id and polls on later passes.
 */
export class AssemblyAI extends Context.Service<AssemblyAI, {
  readonly submit: (audioUrl: string) => Effect.Effect<AssemblyAIResult, Error>
  readonly poll: (transcriptId: string) => Effect.Effect<AssemblyAIResult, Error>
}>()("medina/AssemblyAI") {}

export const layer: Layer.Layer<AssemblyAI, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(AssemblyAI)(
  Effect.gen(function*() {
    const baseUrl = (yield* Config.string("ASSEMBLYAI_API_URL").pipe(
      Config.withDefault("https://api.assemblyai.com")
    )).replace(/\/$/, "")
    const apiKey = yield* Config.string("ASSEMBLYAI_API_KEY").pipe(Config.withDefault(""))
    const prompt = yield* Config.string("ASSEMBLYAI_PROMPT").pipe(Config.withDefault(""))
    const speakerNames = (yield* Config.string("ASSEMBLYAI_SPEAKER_NAMES").pipe(Config.withDefault("")))
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) => apiKey ? HttpClientRequest.setHeader(request, "authorization", apiKey) : request)
    )
    const asError = (cause: unknown) => new Error("AssemblyAI request failed", { cause })

    const isTransient = (error: unknown) =>
      error instanceof HttpClientError.HttpClientError &&
      (error.reason._tag === "TransportError" ||
        (error.reason._tag === "StatusCodeError" && error.reason.response.status >= 500))
    const retryTransient = {
      while: isTransient,
      schedule: Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(3)])
    } as const

    const decodeTranscript = (raw: unknown) =>
      Schema.decodeUnknownEffect(VendorTranscript)(raw).pipe(Effect.mapError(asError))

    const response = (request: Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>) =>
      request.pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
        Effect.retry(retryTransient),
        Effect.flatMap((raw) => Effect.map(decodeTranscript(raw), (transcript) => ({ transcript, raw }))),
        Effect.mapError(asError)
      )

    return {
      submit: (audioUrl) => response(client.post(`${baseUrl}/v2/transcript`, {
        body: HttpBody.jsonUnsafe({
          audio_url: audioUrl,
          speech_models: ["universal-3-5-pro"],
          speaker_labels: true,
          language_detection: true,
          ...(prompt ? { prompt } : {}),
          ...(speakerNames.length > 0
            ? {
              speech_understanding: {
                request: {
                  speaker_identification: {
                    speaker_type: "name",
                    known_values: speakerNames
                  }
                }
              }
            }
            : {})
        })
      })),
      poll: (transcriptId) => response(client.get(
        `${baseUrl}/v2/transcript/${encodeURIComponent(transcriptId)}`
      ))
    }
  })
)
