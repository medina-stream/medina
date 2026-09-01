/**
 * Medina, the Effect edition: a Node process that hourly ingests the latest N
 * Drive files, transcribes new audio with AssemblyAI, journals each day with
 * an LLM, and serves the journal at GET /.
 */
import { createServer } from "node:http"
import { NodeHttpClient, NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel"
import * as Redacted from "effect/Redacted"
import * as Artifacts from "./Artifacts.ts"
import * as AssemblyAI from "./AssemblyAI.ts"
import type { Journal } from "./Domain.ts"
import * as Drive from "./Drive.ts"
import { currentJournals, pipelineStatus, runPipeline } from "./Pipeline.ts"

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character)

const reportHtml = (report: string) =>
  report
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("")

const page = (journals: ReadonlyArray<Journal>) => {
  const sections = journals.length
    ? journals.map((journal) => `<section><h2>${escapeHtml(journal.day)}</h2>${reportHtml(journal.report)}</section>`)
      .join("\n")
    : "<p class=empty>No journal days yet.</p>"
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Medina</title><style>
  :root { color-scheme: light dark; font-family: ui-serif, Georgia, serif; }
  body { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 6rem; line-height: 1.6; }
  h1 { font-size: 2.25rem; margin: 0; } header p, .empty { color: #777; } section { border-top: 1px solid #bbb; margin-top: 2.5rem; padding-top: 1.5rem; }
  h2 { font-size: 1.25rem; margin: 0 0 1rem; } p { margin: .75rem 0; }
</style></head><body><header><h1>Journal</h1><p>Daily reports from available Medina artifacts.</p></header><main>${sections}</main></body></html>`
}

const Routes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    yield* router.add(
      "GET",
      "/",
      currentJournals.pipe(
        Effect.map((journals) => HttpServerResponse.html(page(journals))),
        Effect.orDie
      )
    )
    yield* router.add(
      "GET",
      "/status",
      pipelineStatus.pipe(
        Effect.map((status) => HttpServerResponse.jsonUnsafe(status)),
        Effect.orDie
      )
    )
  })
)

/** Runs the pipeline immediately, then hourly. */
const Ingest = Layer.effectDiscard(
  Effect.gen(function*() {
    const folderId = yield* Config.string("GDRIVE_FOLDER_ID")
    const latest = yield* Config.int("SOURCE_LATEST").pipe(Config.withDefault(25))
    yield* runPipeline(folderId, latest).pipe(
      Effect.catchCause((cause) => Effect.logError("pipeline run failed", cause)),
      Effect.repeat(Schedule.spaced("1 hour")),
      Effect.forkScoped
    )
  })
)

/** The journal language model: OpenAI Responses API via the exe.dev relay. */
const LlmLive = Layer.unwrap(
  Effect.gen(function*() {
    const apiUrl = (yield* Config.string("JOURNAL_LLM_API_URL")).replace(/\/$/, "")
    const model = yield* Config.string("JOURNAL_LLM_MODEL")
    const apiKey = yield* Config.string("JOURNAL_LLM_API_KEY").pipe(Config.withDefault(""))
    return OpenAiLanguageModel.layer({ model, config: { reasoning: { effort: "low" } } }).pipe(
      Layer.provide(OpenAiClient.layer({ apiUrl, ...(apiKey ? { apiKey: Redacted.make(apiKey) } : {}) }))
    )
  })
)

const Services = Layer.mergeAll(
  Drive.layer,
  AssemblyAI.layer,
  LlmLive
).pipe(
  Layer.provideMerge(Artifacts.layer(process.env.ARTIFACTS_DIR ?? "data/artifacts")),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici)
)

const Main = Layer.mergeAll(
  HttpRouter.serve(Routes),
  Ingest
).pipe(
  Layer.provide(Services),
  Layer.provide(NodeHttpServer.layer(createServer, { port: Number(process.env.PORT ?? 8000) }))
)

NodeRuntime.runMain(Layer.launch(Main))
