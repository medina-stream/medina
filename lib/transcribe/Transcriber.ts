import type * as Effect from "effect/Effect"
import type { VendorTranscript } from "./VendorTranscript.ts"

/**
 * Audio input to a transcription provider. AssemblyAI fetches a remote URL
 * itself and never sees bytes; Meta's one-shot endpoint takes the recording
 * in the request body. One union keeps the provider interface honest about
 * both shapes.
 */
export type TranscriptAudio =
  | { readonly _tag: "url"; readonly url: string }
  | {
    readonly _tag: "file"
    readonly bytes: Uint8Array
    readonly filename: string
    readonly contentType: string
  }

/** Parsed fields Medina depends on plus the untouched vendor JSON. */
export interface TranscriptResult {
  readonly transcript: VendorTranscript
  readonly raw: unknown
}

/**
 * Provider-neutral transcription. Submit audio, get a vendor job id back;
 * poll the job id until it reaches a terminal status. Both the AssemblyAI
 * service and the Meta Muse Voice adapter implement this interface, so the
 * comparison harness (and any future pipeline stage) can drive either
 * provider without knowing which one it is.
 */
export interface TranscriptProvider {
  readonly submit: (audio: TranscriptAudio) => Effect.Effect<TranscriptResult, Error>
  readonly poll: (transcriptId: string) => Effect.Effect<TranscriptResult, Error>
}
