import { describe, expect, test } from "bun:test"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { Drive, layer } from "./Drive.ts"

const TOKEN_URL = "https://mint.test/token"

const fileList = {
  files: [
    {
      id: "file-1",
      name: "20260901T120000.m4a",
      mimeType: "audio/mp4",
      modifiedTime: "2026-09-01T12:00:00.000Z"
    }
  ]
}

// Every HTTP call routes through here; mint POSTs are counted so the test
// can prove the token is fetched once and reused.
const stubClient = (mintHits: Ref.Ref<number>) =>
  HttpClient.make((request) =>
    String(request.url).startsWith(TOKEN_URL)
      ? Ref.update(mintHits, (hits) => hits + 1).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, Response.json({ access_token: "cached-token" })))
      )
      : Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          String(request.url).includes("alt=media") ? new Response("fake-audio-bytes") : Response.json(fileList)
        )
      )
  )

describe("Drive token caching", () => {
  test("mints once across repeated list/download calls", async () => {
    const mintHits = await Effect.runPromise(Ref.make(0))
    const TestLive = Layer.provide(layer, Layer.succeed(HttpClient.HttpClient, stubClient(mintHits)))
    // Explicit config record: process.env mutation leaks across test files
    // sharing one process (the default provider snapshots the env), so each
    // test pins its own values here.
    const TestConfig = ConfigProvider.fromEnv({ env: { GOOGLE_TOKEN_URL: TOKEN_URL } })
    const { first, second } = await Effect.runPromise(
      Effect.gen(function*() {
        const drive = yield* Drive
        const first = yield* drive.list("folder-1", 10)
        const second = yield* drive.list("folder-1", 10)
        yield* drive.download("file-1")
        return { first, second }
      }).pipe(
        Effect.provide(TestLive),
        Effect.provideService(ConfigProvider.ConfigProvider, TestConfig)
      )
    )
    expect(first.map((file) => file.id)).toEqual(["file-1"])
    expect(second.map((file) => file.id)).toEqual(["file-1"])
    expect(await Effect.runPromise(Ref.get(mintHits))).toBe(1)
  })
})
