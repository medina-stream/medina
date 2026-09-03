/**
 * Medina, the Effect edition: a Bun process that hourly ingests the latest N
 * Drive files, transcribes new audio with AssemblyAI, journals each day with
 * an LLM, and serves the journal at GET /.
 */
import { BunHttpClient, BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type { WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine"
import { ClusterLive, WorkflowEngineLive } from "./Cluster.ts"
import { JournalWorkflowLayer, NotesWorkflowLayer } from "./Lifelog.ts"
import * as Redacted from "effect/Redacted"
import * as Option from "effect/Option"
import * as FileSystem from "effect/FileSystem"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import { JournalsGroup } from "./JournalApi.ts"
import { JournalsHandlersLive } from "./JournalRpc.ts"
import { Tailscale, layer as tailscaleLayer } from "../lib/Tailscale.ts"
import { gpsCompactSource, gpsDay, gpsInboxWrite, locationSummary, parseGpsBody } from "./Gps.ts"
import * as AssemblyAI from "../lib/AssemblyAI.ts"
import * as Drive from "../lib/Drive.ts"
import * as Git from "../lib/Git.ts"
import { runPipeline } from "../lib/Pipeline.ts"
import { dataPath } from "./Resources.ts"
import { dayPage, pendingPage, spaHome } from "./Pages.tsx"
import { audioSource, attributionResource, dayIndexResource, httpIngest, journalCachedForDay, journalResource, notesResource, notesSource, pipelineStatus, todayDay } from "./Lifelog.ts"
import { movementCachedForDay, movementResource } from "./Movement.ts"
import { staysDay, staysSource } from "./Stays.ts"

const Routes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    // The home page is an SPA: a static shell plus the client bundle. All
    // journal data arrives over the typed RPC at POST /rpc.
    yield* router.add(
      "GET",
      "/",
      Effect.succeed(HttpServerResponse.html(spaHome()))
    )
    yield* router.add(
      "GET",
      "/app.js",
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = process.env.CLIENT_BUNDLE ?? "example-lifelog/public/app.js"
        if (!(yield* fs.exists(path))) {
          return HttpServerResponse.text("client bundle missing: run bun run build:client", { status: 503 })
        }
        return HttpServerResponse.text(yield* fs.readFileString(path), {
          contentType: "text/javascript",
          headers: { "cache-control": "private, max-age=60" }
        })
      }).pipe(Effect.orDie)
    )
    yield* router.add(
      "GET",
      "/journal/:day",
      Effect.gen(function*() {
        const { day } = yield* HttpRouter.params
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          return HttpServerResponse.text("not a day: use YYYY-MM-DD", { status: 400 })
        }
        // Same resource, two representations: browsers get the page, tools
        // get the record.
        const request = yield* HttpServerRequest.HttpServerRequest
        const wantsHtml = (request.headers["accept"] ?? "").includes("text/html")
        // Read-only: never materialize here. A stale or missing journal is a
        // 202 placeholder; the hourly pipeline pass converges it.
        const cached = yield* journalCachedForDay(day).pipe(Effect.orDie)
        if (Option.isNone(cached)) {
          return wantsHtml
            ? HttpServerResponse.text(pendingPage(day), {
              status: 202,
              contentType: "text/html",
              headers: { "cache-control": "private, max-age=60" }
            })
            : HttpServerResponse.jsonUnsafe({ status: "pending", day }, {
              status: 202,
              headers: { "cache-control": "private, max-age=60" }
            })
        }
        const journal = cached.value
        // Past days are settled (new audio for them is rare); the current and
        // future days want re-checking as inputs land.
        const today = yield* todayDay
        const cacheControl = journal.day < today
          ? "private, max-age=86400"
          : "private, max-age=60"
        return wantsHtml
          ? HttpServerResponse.text(dayPage(journal), {
            contentType: "text/html",
            headers: { "cache-control": cacheControl }
          })
          : HttpServerResponse.jsonUnsafe(journal, { headers: { "cache-control": cacheControl } })
      })
    )
    yield* router.add(
      "GET",
      "/movement/:day",
      Effect.gen(function*() {
        const { day } = yield* HttpRouter.params
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          return HttpServerResponse.text("not a day: use YYYY-MM-DD", { status: 400 })
        }
        // Read-only: never materialize here. A stale or missing movement is
        // a 202 placeholder; the hourly pipeline pass converges it.
        const cached = yield* movementCachedForDay(day).pipe(Effect.orDie)
        if (Option.isNone(cached)) {
          return HttpServerResponse.jsonUnsafe({ status: "pending", day }, {
            status: 202,
            headers: { "cache-control": "private, max-age=60" }
          })
        }
        const movement = cached.value
        const today = yield* todayDay
        const cacheControl = day < today
          ? "private, max-age=86400"
          : "private, max-age=60"
        return HttpServerResponse.jsonUnsafe(movement, { headers: { "cache-control": cacheControl } })
      })
    )
    yield* router.add(
      "GET",
      "/status",
      pipelineStatus.pipe(
        Effect.map((status) => HttpServerResponse.jsonUnsafe(status)),
        Effect.orDie
      )
    )
    // "My location" for assistants and UIs: last fix plus a movement summary.
    yield* router.add(
      "GET",
      "/location",
      Effect.gen(function*() {
        const location = yield* Effect.orDie(locationSummary)
        return HttpServerResponse.jsonUnsafe({ location }, { headers: { "cache-control": "no-store" } })
      })
    )
    yield* router.add(
      "GET",
      "/gps/:day",
      Effect.gen(function*() {
        const { day } = yield* HttpRouter.params
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          return HttpServerResponse.text("not a day: use YYYY-MM-DD", { status: 400 })
        }
        const points = yield* Effect.orDie(gpsDay(day))
        const today = yield* todayDay
        const cacheControl = day < today ? "private, max-age=3600" : "private, max-age=60"
        return HttpServerResponse.jsonUnsafe({ day, count: points.length, points }, {
          headers: { "cache-control": cacheControl }
        })
      })
    )
    yield* router.add(
      "GET",
      "/stays/:day",
      Effect.gen(function*() {
        const { day } = yield* HttpRouter.params
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          return HttpServerResponse.text("not a day: use YYYY-MM-DD", { status: 400 })
        }
        const stays = yield* Effect.orDie(staysDay(day))
        const today = yield* todayDay
        const cacheControl = day < today ? "private, max-age=3600" : "private, max-age=60"
        return HttpServerResponse.jsonUnsafe({ day, count: stays.length, stays }, {
          headers: { "cache-control": cacheControl }
        })
      })
    )
    // Push ingest: apps (e.g. a GPS logger) POST batches here from the
    // tailnet. Identity comes from Tailscale: the WireGuard peer behind the
    // source address must map to the owner's login. No tokens — the tailnet
    // is the credential. `?source=` labels the provenance (default "http").
    // The body is stored as an uninterpreted capture; deriving anything
    // from it is a future resource's job.
    yield* router.add(
      "POST",
      "/in",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const params = yield* HttpServerRequest.ParsedSearchParams
        const owner = yield* Config.string("INGEST_OWNER")
        const address = Option.getOrNull(request.remoteAddress)
        const tailscale = yield* Tailscale
        const login = yield* tailscale.identify(address, request.headers)
        if (!login || login !== owner) {
          yield* Effect.log(`ingest rejected: ${address ?? "unknown"} -> ${login ?? "unidentified"}`)
          return HttpServerResponse.text("forbidden: not you", { status: 403 })
        }
        const source = typeof params.source === "string" && params.source ? params.source : "http"
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) {
          return HttpServerResponse.text("source must be [a-z0-9-], e.g. gps-gpslogger", { status: 400 })
        }
        const body = new Uint8Array(yield* Effect.orDie(request.arrayBuffer))
        if (body.length === 0) return HttpServerResponse.text("empty body", { status: 400 })
        const contentType = request.headers["content-type"] ?? "application/octet-stream"
        // GPS is recognized by content, not by source label — the phone just
        // posts to /in, like Drive files are recognized as audio by mimeType.
        // The points are the signal, the envelope is scaffolding; unparseable
        // bodies still land as blob captures so nothing is silently dropped.
        {
          const points = parseGpsBody(source === "http" ? "gps-gpslogger" : source, new TextDecoder().decode(body))
          if (points) {
            const count = yield* Effect.orDie(gpsInboxWrite(points))
            yield* Effect.log(`gps ingest ${source} (${login}): ${count} points`)
            return HttpServerResponse.jsonUnsafe({ ok: true, points: count })
          }
        }
        const result = yield* Effect.orDie(httpIngest(source, body, contentType))
        yield* Effect.log(
          `http ingest ${source} (${login}): ${result.bytes} bytes -> ${result.captureId.slice(0, 12)}${
            result.duplicate ? " (duplicate)" : ""
          }`
        )
        return HttpServerResponse.jsonUnsafe({ ok: true, captureId: result.captureId, duplicate: result.duplicate })
      })
    )
  })
)

type LifelogEnv = Drive.Drive | AssemblyAI.AssemblyAI | Git.Git | FileSystem.FileSystem | LanguageModel.LanguageModel | WorkflowEngine

const Ingest = Layer.effectDiscard(
  Effect.gen(function*() {
    const folderId = yield* Config.string("GDRIVE_FOLDER_ID")
    const latest = yield* Config.int("SOURCE_LATEST").pipe(Config.withDefault(25))
    const notesRepo = yield* Config.string("NOTES_REPO_DIR")
    yield* runPipeline<LifelogEnv>(
      [audioSource(folderId, latest), notesSource(notesRepo), gpsCompactSource, staysSource],
      // Order matters: movement enriches journals, after attribution/index.
      // Order matters: notes are extraction from audio (stable across movement
      // changes), movement enriches journals, and the journal reads both.
      [attributionResource, dayIndexResource, movementResource, notesResource, journalResource],
      dataPath
    ).pipe(
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

// The journal workflow's LLM activities need the language model at
// registration time. Layer memoization means LlmLive builds once even
// though it also appears in Services.
const WorkflowsLive = Layer.mergeAll(
  JournalWorkflowLayer,
  NotesWorkflowLayer
).pipe(Layer.provide(LlmLive))

const Services = Layer.mergeAll(
  Drive.layer,
  AssemblyAI.layer,
  Git.layer,
  tailscaleLayer,
  LlmLive,
  WorkflowsLive
).pipe(
  // Engine on top of the single-process cluster; everything above can
  // execute workflows, the pipeline and routes included.
  Layer.provideMerge(WorkflowEngineLive),
  Layer.provideMerge(ClusterLive),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer)
)

/** Typed journals RPC at POST /rpc, over plain HTTP on the same router. */
const RpcLive = RpcServer.layerHttp({ group: JournalsGroup, path: "/rpc", protocol: "http" }).pipe(
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(JournalsHandlersLive)
)

const Main = Layer.mergeAll(
  HttpRouter.serve(Layer.mergeAll(Routes, RpcLive)),
  Ingest
).pipe(
  Layer.provide(Services),
  // Cold caches over the network mount can push the first / render past
  // Bun's default 10s request timeout; give handlers more room.
  Layer.provide(BunHttpServer.layer({ port: Number(process.env.PORT ?? 8000), idleTimeout: 120 }))
)

BunRuntime.runMain(Layer.launch(Main))
