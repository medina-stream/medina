import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type { TranscriptAudio, TranscriptProvider } from "./Transcriber.ts"

/** Version tag for comparison-harness output. Production transcripts keep
 * their own version; nothing written under this version is ever discovered
 * as a production transcript. */
export const MUSE_VOICE_VERSION = "meta-muse-vt1-compare-v1"

/** Public price of muse-voice-transcribe-1.0: $3 per 1,000 audio minutes. */
export const MUSE_VOICE_PRICE_PER_AUDIO_SECOND = 3 / (1000 * 60)
/** Effective production rate being compared against: Universal-3.5 Pro
 * ($0.21/hr) + diarization ($0.02/hr). */
export const ASSEMBLYAI_PRICE_PER_AUDIO_SECOND = 0.23 / 3600

/**
 * Convert a vendor timestamp to milliseconds. Meta reports speaker-turn
 * timestamps (not word timestamps); the unit comes from the API docs.
 */
export const toMillis = (value: number, unit: "seconds" | "milliseconds"): number =>
  unit === "seconds" ? Math.round(value * 1000) : Math.round(value)

export class MuseVoice extends Context.Service<MuseVoice, TranscriptProvider>()("medina/MuseVoice") {}

/**
 * Meta Muse Voice Transcribe adapter (`muse-voice-transcribe-1.0`).
 *
 * What is known (Meta's cookbook + launch coverage, Sep 2026):
 * - One-shot endpoint: POST https://api.meta.ai/v1/asr/transcribe — post a
 *   whole recording in one HTTP request, get the transcript back.
 * - Streaming endpoint: wss://api.meta.ai/v1/asr/realtime (not used here).
 * - Auth key comes from the `MODEL_API_KEY` environment variable.
 * - Diarization mode emits speaker tags like `speaker_A` with turn
 *   timestamps; no confidence scores; supports >1h audio.
 *
 * WIRE FORMAT PENDING — do not guess. Before this adapter can run, the exact
 * contract for POST /v1/asr/transcribe must be read from
 * https://dev.meta.ai/docs/speech-to-text/ (or the cookbook's
 * transcribe_file.py) and filled into `submit`/`poll` below:
 *   1. request body: multipart file field name? JSON with audio bytes/URL?
 *      extra params for diarization mode (DIARIZATION) and biasing?
 *   2. auth header scheme: `Authorization: Bearer <key>` or an api-key header?
 *   3. response JSON: field names for the transcript text and the turn list,
 *      and the timestamp unit (seconds vs milliseconds) for `toMillis`.
 *   4. sync vs async: does the response carry the full transcript, or a job
 *      id to poll (and if so, the status endpoint and status values)?
 *
 * Until then `submit`/`poll` fail loudly with the message below instead of
 * sending a malformed request.
 */
export const layer: Layer.Layer<MuseVoice, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(MuseVoice)(
  Effect.gen(function*() {
    const baseUrl = (yield* Config.string("MUSE_VOICE_API_URL").pipe(
      Config.withDefault("https://api.meta.ai")
    )).replace(/\/$/, "")
    // Required on purpose: fail at layer build, not on the first request. The
    // binding itself gets wired into the real request once the wire format lands.
    yield* Config.string("MODEL_API_KEY")

    const wireFormatError = () => new Error(
      "Muse Voice one-shot wire format not yet verified: the exact request body and " +
      "response JSON for POST /v1/asr/transcribe are still needed from " +
      "https://dev.meta.ai/docs/speech-to-text/ (field names and timestamp units). " +
      "See the WIRE FORMAT PENDING note on `layer` in lib/transcribe/MuseVoice.ts. " +
      `Using base URL ${baseUrl} once the format lands.`
    )

    const submit: TranscriptProvider["submit"] = (audio: TranscriptAudio) =>
      audio._tag === "url"
        ? Effect.fail(new Error(
          "MuseVoice.submit takes file bytes ({ _tag: \"file\", ... }): Meta's one-shot " +
          "endpoint receives the recording in the request body, it does not fetch a URL."
        ))
        : Effect.fail(wireFormatError())

    const poll: TranscriptProvider["poll"] = (_transcriptId: string) =>
      Effect.fail(wireFormatError())

    return { submit, poll }
  })
)
