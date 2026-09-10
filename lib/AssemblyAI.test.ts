import { describe, expect, test } from "bun:test"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { AssemblyAI, layer } from "./AssemblyAI.ts"

const BASE_URL = "https://assemblyai.test"
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("AssemblyAI URL jobs", () => {
  test("submits a remote URL directly, retries a transient failure, and never calls upload", async () => {
    const submitHits = await Effect.runPromise(Ref.make(0))
    const seenUrls: Array<string> = []
    const client = HttpClient.make((request) => {
      seenUrls.push(String(request.url))
      if (String(request.url) !== `${BASE_URL}/v2/transcript`) {
        return Effect.die(new Error(`unexpected request: ${request.url}`))
      }
      return Ref.updateAndGet(submitHits, (hits) => hits + 1).pipe(
        Effect.map((hits) => HttpClientResponse.fromWeb(
          request,
          hits === 1 ? new Response("boom", { status: 500 }) : json({ id: "t-1", status: "queued" })
        ))
      )
    })
    const TestConfig = ConfigProvider.fromEnv({ env: { ASSEMBLYAI_API_URL: BASE_URL } })
    const result = await Effect.runPromise(
      Effect.flatMap(AssemblyAI, (assemblyai) => assemblyai.submit("https://r2.test/signed-chunk.ogg")).pipe(
        Effect.provide(Layer.provide(layer, Layer.succeed(HttpClient.HttpClient, client))),
        Effect.provideService(ConfigProvider.ConfigProvider, TestConfig)
      )
    )
    expect(result.transcript.status).toBe("queued")
    expect(await Effect.runPromise(Ref.get(submitHits))).toBe(2)
    expect(seenUrls).toEqual([`${BASE_URL}/v2/transcript`, `${BASE_URL}/v2/transcript`])
  })

  test("poll is one request and returns pending status to the caller", async () => {
    let hits = 0
    const client = HttpClient.make((request) => {
      hits++
      return Effect.succeed(HttpClientResponse.fromWeb(request, json({ id: "t-2", status: "processing" })))
    })
    const TestConfig = ConfigProvider.fromEnv({ env: { ASSEMBLYAI_API_URL: BASE_URL } })
    const result = await Effect.runPromise(
      Effect.flatMap(AssemblyAI, (assemblyai) => assemblyai.poll("t-2")).pipe(
        Effect.provide(Layer.provide(layer, Layer.succeed(HttpClient.HttpClient, client))),
        Effect.provideService(ConfigProvider.ConfigProvider, TestConfig)
      )
    )
    expect(hits).toBe(1)
    expect(result.transcript.status).toBe("processing")
  })

  test("a persistent submit 500 exhausts bounded retries", async () => {
    let hits = 0
    const client = HttpClient.make((request) => {
      hits++
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("boom", { status: 500 })))
    })
    const TestConfig = ConfigProvider.fromEnv({ env: { ASSEMBLYAI_API_URL: BASE_URL } })
    const exit = await Effect.runPromise(
      Effect.flatMap(AssemblyAI, (assemblyai) => assemblyai.submit("https://r2.test/chunk.ogg")).pipe(
        Effect.provide(Layer.provide(layer, Layer.succeed(HttpClient.HttpClient, client))),
        Effect.provideService(ConfigProvider.ConfigProvider, TestConfig),
        Effect.exit
      )
    )
    expect(exit._tag).toBe("Failure")
    expect(hits).toBe(4)
  })
})
