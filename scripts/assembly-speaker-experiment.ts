import { BunHttpClient, BunServices } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as Files from "../lib/Files.ts"
import * as AssemblyAI from "../lib/AssemblyAI.ts"
import { captureDir, dataPath } from "../lib/lifelog/Resources.ts"

const captureId = process.argv[2]
if (!captureId) throw new Error("usage: bun scripts/assembly-speaker-experiment.ts <capture-id>")

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const dir = dataPath(captureDir(captureId))
  const entries = yield* fs.readDirectory(dir)
  const blob = entries.find((name) => name !== "provenance.json" && !name.startsWith(".tmp-"))
  if (!blob) return yield* Effect.fail(new Error(`capture audio not found: ${captureId}`))

  const assembly = yield* AssemblyAI.AssemblyAI
  const audio = fs.stream(`${dir}/${blob}`).pipe(Stream.mapError((cause) => new Error(String(cause))))
  const result = yield* assembly.transcribe(audio)
  const output = dataPath(`experiments/assemblyai-speaker-id/${captureId}.json`)
  yield* Files.writeJson(output, result.raw)
  yield* Effect.log(`saved complete AssemblyAI response to ${output}`)
})

const Live = AssemblyAI.layer.pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer)
)

await Effect.runPromise(Effect.provide(program, Live))
