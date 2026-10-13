import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Files from "../Files.ts"
import { currentDayIndex } from "./DayIndex.ts"
import { layerDefault } from "./StartTimeRules.ts"
import { DATA_DIR, dataPath, Transcript, transcriptKey, TRANSCRIPT_VERSION } from "./Resources.ts"

if (!DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run against a non-temp data dir: ${DATA_DIR}`)
}

const layers = Layer.mergeAll(BunFileSystem.layer, layerDefault)

const writeTranscript = (captureId: string, status: "completed" | "error", text: string | null) =>
  Effect.runPromise(
    Files.writeJson(dataPath(transcriptKey(captureId)), new Transcript({
      provider: "assemblyai",
      version: TRANSCRIPT_VERSION,
      ingestId: captureId,
      inputKey: `media/media-v1/${captureId}.json`,
      capturedAt: "2026-01-02T12:00:00",
      transcriptId: "transcript-1",
      vendorKey: null,
      status,
      completedAt: "2026-01-03T00:00:00.000Z",
      text,
      utterances: [],
      error: status === "error" ? "vendor download failed" : null
    })).pipe(Effect.provide(BunFileSystem.layer))
  )

describe("currentDayIndex", () => {
  test("a capture whose transcript is retried from error to completed becomes usable", async () => {
    const captureId = "day-index-error-retry"
    await writeTranscript(captureId, "error", null)
    const whileErrored = await Effect.runPromise(currentDayIndex.pipe(Effect.provide(layers)))
    expect(Object.values(whileErrored.days).flat().map((entry) => entry.captureId)).not.toContain(captureId)

    // Same canonical path, now completed: the index basis must change, so
    // the index built while the capture was unusable is not served forever.
    await writeTranscript(captureId, "completed", "recovered transcript")
    const afterFix = await Effect.runPromise(currentDayIndex.pipe(Effect.provide(layers)))
    const entries = Object.values(afterFix.days).flat()
    expect(entries.map((entry) => entry.captureId)).toContain(captureId)
    expect(entries.find((entry) => entry.captureId === captureId)!.transcriptKey).toBe(transcriptKey(captureId))
  })
})
