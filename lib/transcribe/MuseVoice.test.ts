import { describe, expect, test } from "bun:test"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { MuseVoice, layer, toMillis } from "./MuseVoice.ts"

const client = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
  ))
)
const httpLayer = Layer.succeed(HttpClient.HttpClient, client)
const withKey = ConfigProvider.fromEnv({ env: { MODEL_API_KEY: "test-key" } })
const withoutKey = ConfigProvider.fromEnv({ env: {} })

const fileAudio = {
  _tag: "file",
  bytes: new Uint8Array([1, 2, 3]),
  filename: "chunk-000.ogg",
  contentType: "audio/ogg"
} as const

describe("MuseVoice adapter", () => {
  test("toMillis converts seconds and passes milliseconds through", () => {
    expect(toMillis(1.5, "seconds")).toBe(1500)
    expect(toMillis(1500, "milliseconds")).toBe(1500)
    expect(toMillis(1.2345, "seconds")).toBe(1235)
  })

  test("submit rejects URL audio: Meta takes file bytes, not a vendor-fetched URL", async () => {
    const exit = await Effect.runPromise(
      Effect.flatMap(MuseVoice, (muse) => muse.submit({ _tag: "url", url: "https://r2.test/chunk.ogg" })).pipe(
        Effect.provide(Layer.provide(layer, httpLayer)),
        Effect.provideService(ConfigProvider.ConfigProvider, withKey),
        Effect.exit
      )
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toMatch(/file bytes/)
    }
  })

  test("submit with file audio fails loudly until the wire format is verified", async () => {
    const exit = await Effect.runPromise(
      Effect.flatMap(MuseVoice, (muse) => muse.submit(fileAudio)).pipe(
        Effect.provide(Layer.provide(layer, httpLayer)),
        Effect.provideService(ConfigProvider.ConfigProvider, withKey),
        Effect.exit
      )
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const message = String(exit.cause)
      expect(message).toMatch(/wire format not yet verified/)
      expect(message).toMatch(/dev\.meta\.ai\/docs\/speech-to-text/)
    }
  })

  test("poll fails loudly until the wire format is verified", async () => {
    const exit = await Effect.runPromise(
      Effect.flatMap(MuseVoice, (muse) => muse.poll("job-1")).pipe(
        Effect.provide(Layer.provide(layer, httpLayer)),
        Effect.provideService(ConfigProvider.ConfigProvider, withKey),
        Effect.exit
      )
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toMatch(/wire format not yet verified/)
    }
  })

  test("layer build fails fast without MODEL_API_KEY", async () => {
    const exit = await Effect.runPromise(
      Effect.flatMap(MuseVoice, (muse) => muse.poll("job-1")).pipe(
        Effect.provide(Layer.provide(layer, httpLayer)),
        Effect.provideService(ConfigProvider.ConfigProvider, withoutKey),
        Effect.exit
      )
    )
    expect(exit._tag).toBe("Failure")
  })
})
