/**
 * Journal LLM built on Effect's AI stack: `@effect/ai-openai` provides a
 * `LanguageModel` over the OpenAI Responses API. This service keeps one house
 * rule on top: a response must carry final text — reasoning-only output fails
 * the run, so working notes never reach the page.
 */
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"

export type Message = { readonly role: "system" | "user"; readonly content: string }

export class Llm extends Context.Service<Llm, {
  readonly model: string
  readonly complete: (messages: ReadonlyArray<Message>, maxTokens: number) => Effect.Effect<string, Error>
}>()("medina/Llm") {}

export const layer: Layer.Layer<Llm, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(Llm)(
  Effect.gen(function*() {
    const apiUrl = (yield* Config.string("JOURNAL_LLM_API_URL")).replace(/\/$/, "")
    const model = yield* Config.string("JOURNAL_LLM_MODEL")
    const apiKey = yield* Config.string("JOURNAL_LLM_API_KEY").pipe(Config.withDefault(""))

    const languageModel = OpenAiLanguageModel.layer({
      model,
      config: { reasoning: { effort: "low" } }
    }).pipe(
      Layer.provide(OpenAiClient.layer({
        apiUrl,
        ...(apiKey ? { apiKey: Redacted.make(apiKey) } : {})
      }))
    )
    const services = yield* Layer.build(languageModel)

    return {
      model,
      complete: (messages, maxTokens) =>
        Effect.gen(function*() {
          const llm = yield* LanguageModel.LanguageModel
          const response = yield* llm.generateText({
            prompt: Prompt.make(messages.map((message) =>
              message.role === "system"
                ? { role: "system" as const, content: message.content }
                : { role: "user" as const, content: message.content }
            ))
          }).pipe(OpenAiLanguageModel.withConfigOverride({ max_output_tokens: maxTokens }))
          const content = response.text.trim()
          return content
            ? content
            : yield* Effect.fail(
              new Error(`journal LLM returned no final content (finish: ${response.finishReason})`)
            )
        }).pipe(
          Effect.provideContext(services),
          Effect.catchTag("AiError", (error) => Effect.fail(new Error("journal LLM request failed", { cause: error })))
        )
    }
  })
)
