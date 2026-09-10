import { BunHttpClient, BunServices } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Files from "../lib/Files.ts"
import * as AssemblyAI from "../lib/AssemblyAI.ts"
import * as R2TempCreds from "../lib/R2TempCreds.ts"
import { dataPath } from "../lib/lifelog/Resources.ts"

const objectKey = process.argv[2]
if (!objectKey) throw new Error("usage: bun scripts/assembly-speaker-experiment.ts <r2-object-key>")

const program = Effect.gen(function*() {
  const r2 = yield* R2TempCreds.R2TempCreds
  const assembly = yield* AssemblyAI.AssemblyAI
  const result = yield* assembly.submit(yield* r2.presignGet(objectKey, 2 * 60 * 60))
  const safe = objectKey.replace(/[^a-zA-Z0-9_-]/g, "-")
  const output = dataPath(`experiments/assemblyai-speaker-id/${safe}.submitted.json`)
  yield* Files.writeJson(output, result.raw)
  yield* Effect.log(`submitted ${objectKey}; receipt saved to ${output}`)
})

const Live = Layer.mergeAll(AssemblyAI.layer, R2TempCreds.layer).pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer)
)

await Effect.runPromise(Effect.provide(program, Live))
