import { describe, expect, test } from "bun:test"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { AssemblyAI, layer } from "./AssemblyAI.ts"

const BASE_URL = "https://assemblyai.test"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// Upload/submit fail once with a 500, then succeed; the poll is completed.
const flakyClient = (uploadHits: Ref.Ref<number>, submitHits: Ref.Ref<number>) =>
  HttpClient.make((request) => {
    const url = String(request.url)
    if (url === `${BASE_URL}/v2/upload`) {
      return Ref.updateAndGet(uploadHits, (hits) => hits + 1).pipe(
        Effect.map((hits) =>
          HttpClientResponse.fromWeb(
            request,
            hits === 1 ? new Response("boom", { status: 500 }) : json({ upload_url: "https://cdn.test/audio" })
          )
        )
      )
    }
    if (url === `${BASE_URL}/v2/transcript` && request.method === "POST") {
      return Ref.updateAndGet(submitHits, (hits) => hits + 1).pipe(
        Effect.map((hits) =>
          HttpClientResponse.fromWeb(
            request,
            hits === 1 ? new Response("boom", { status: 500 }) : json({ id: "t-1", status: "queued" })
          )
        )
      )
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, json({ id: "t-1", status: "completed", text: "hi" }))
    )
  })

describe("AssemblyAI transient retries", () => {
  test("a single 500 on upload and submit each is retried", async () => {
    const TestConfig = ConfigProvider.fromEnv({ env: { ASSEMBLYAI_API_URL: BASE_URL } })
    const prog = Effect.gen(function*() {
      const uploadHits = yield* Ref.make(0)
      const submitHits = yield* Ref.make(0)
      const TestLive = Layer.provide(layer, Layer.succeed(HttpClient.HttpClient, flakyClient(uploadHits, submitHits)))
      const transcript = yield* AssemblyAI.pipe(
        Effect.flatMap((assemblyai) =>
          assemblyai.transcribe(Stream.fromIterable([new TextEncoder().encode("audio")]))
        ),
        Effect.provide(TestLive),
        Effect.provideService(ConfigProvider.ConfigProvider, TestConfig)
      )
      return {
        transcript,
        uploads: yield* Ref.get(uploadHits),
        submits: yield* Ref.get(submitHits)
      }
    })
    const { transcript, uploads, submits } = await Effect.runPromise(prog)
    expect(transcript.status).toBe("completed")
    expect(transcript.text).toBe("hi")
    expect(uploads).toBe(2)
    expect(submits).toBe(2)
  })

  test("a persistent 500 exhausts retries and fails", async () => {
    const TestConfig = ConfigProvider.fromEnv({ env: { ASSEMBLYAI_API_URL: BASE_URL } })
    const prog = Effect.gen(function*() {
      const uploadHits = yield* Ref.make(0)
      const stub = HttpClient.make((request) =>
        Ref.updateAndGet(uploadHits, (hits) => hits + 1).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response("down", { status: 500 })))
        )
      )
      const TestLive = Layer.provide(layer, Layer.succeed(HttpClient.HttpClient, stub))
      const exit = yield* AssemblyAI.pipe(
        Effect.flatMap((assemblyai) =>
          assemblyai.transcribe(Stream.fromIterable([new TextEncoder().encode("audio")]))
        ),
        Effect.provide(TestLive),
        Effect.provideService(ConfigProvider.ConfigProvider, TestConfig),
        Effect.exit
      )
      return { exit, uploads: yield* Ref.get(uploadHits) }
    })
    const { exit, uploads } = await Effect.runPromise(prog)
    expect(exit._tag).toBe("Failure")
    // Initial attempt + 3 retries, then the error surfaces.
    expect(uploads).toBe(4)
  })
})
