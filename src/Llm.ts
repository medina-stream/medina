/**
 * Journal LLM: an OpenAI-compatible chat-completions client that demands a
 * final answer. A response with reasoning but no `content` fails the run, so
 * working notes never reach the page.
 */
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

export type Message = { readonly role: "system" | "user"; readonly content: string }

const Completion = Schema.Struct({
  choices: Schema.optional(Schema.Array(Schema.Struct({
    finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
    message: Schema.optional(Schema.Struct({
      content: Schema.optional(Schema.NullOr(Schema.String))
    }))
  })))
})

export class Llm extends Context.Service<Llm, {
  readonly model: string
  readonly complete: (messages: ReadonlyArray<Message>, maxTokens: number) => Effect.Effect<string, Error>
}>()("medina/Llm") {}

export const layer: Layer.Layer<Llm, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(Llm)(
  Effect.gen(function*() {
    const baseUrl = (yield* Config.string("JOURNAL_LLM_API_URL")).replace(/\/$/, "")
    const model = yield* Config.string("JOURNAL_LLM_MODEL")
    const apiKey = yield* Config.string("JOURNAL_LLM_API_KEY").pipe(Config.withDefault(""))
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) =>
        apiKey ? HttpClientRequest.setHeader(request, "authorization", `Bearer ${apiKey}`) : request
      )
    )

    return {
      model,
      complete: (messages, maxTokens) =>
        client.post(`${baseUrl}/chat/completions`, {
          body: HttpBody.jsonUnsafe({
            model,
            messages,
            max_completion_tokens: maxTokens,
            reasoning_effort: "low"
          })
        }).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Completion)),
          Effect.mapError((cause) => new Error("journal LLM request failed", { cause })),
          Effect.flatMap((completion) => {
            const choice = completion.choices?.[0]
            const content = choice?.message?.content?.trim()
            return content
              ? Effect.succeed(content)
              : Effect.fail(
                new Error(
                  `journal LLM returned no final content (finish_reason: ${choice?.finish_reason ?? "none"})`
                )
              )
          })
        )
    }
  })
)
