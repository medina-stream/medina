import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import { transcriptJobsKey } from "../capture/Media.ts"
import * as Files from "../Files.ts"
import { DATA_DIR, dataPath, transcriptKey, vendorKey } from "./Resources.ts"
import { transcribedCaptures } from "./Attribution.ts"

// Same guard as the capture tests: the preload points DATA_DIR at a fresh
// temp dir; never run this against the real lifelog.
if (!DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run against a non-temp data dir: ${DATA_DIR}`)
}

describe("transcribedCaptures", () => {
  test("ignores chunk-job and vendor sidecars in the transcript dir", async () => {
    const captureId = "abc123"
    const layers = BunFileSystem.layer
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Files.writeJson(dataPath(transcriptKey(captureId)), { provider: "assemblyai" })
        yield* Files.writeJson(dataPath(transcriptJobsKey(captureId)), { chunks: [] })
        yield* Files.writeJson(dataPath(vendorKey(captureId)), { id: "vendor-1" })
      }).pipe(Effect.provide(layers))
    )

    const ids = await Effect.runPromise(transcribedCaptures.pipe(Effect.provide(layers)))
    // Tolerant of other test files sharing the temp data dir: the point is
    // the sidecars never surface as capture ids.
    expect(ids).toContain(captureId)
    expect(ids.some((id) => id.endsWith(".jobs") || id.endsWith(".assemblyai"))).toBe(false)
  })
})
