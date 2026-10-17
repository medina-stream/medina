/**
 * One-shot migration of the local artifact tree into the bucket store.
 *
 * Walks DATA_DIR (the local store), uploads every artifact to the
 * ARTIFACT_BUCKET_* bucket under its existing key, and registers every
 * key in the medina-index worker (MEDINA_INDEX_URL + INDEX_API_TOKEN).
 * Idempotent and resumable — re-running skips objects whose bucket size
 * already matches; see lib/MigrateArtifacts.ts.
 *
 * Run it ON the Medina host, where the data dir (the Archil mount) is
 * local:
 *
 *   bun scripts/migrate-artifacts-to-bucket.ts [--dry-run] [--prefix=star] [--sample=25]
 *
 * Exits non-zero when any artifact failed or any sampled object failed
 * hash verification. After a clean run, cut over by setting
 * ARTIFACT_STORE=bucket in the service environment and restarting.
 */
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import { bucketFromConfig, makeLocal } from "../lib/ArtifactStore.ts"
import { migrateArtifacts } from "../lib/MigrateArtifacts.ts"

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [name, value] = arg.replace(/^--/, "").split("=")
    return [name, value ?? "true"] as const
  })
)

const program = Effect.gen(function*() {
  const dataDir = process.env.DATA_DIR ?? "data/artifacts"
  const local = yield* makeLocal(dataDir)
  const { index, store: bucket } = yield* bucketFromConfig
  const summary = yield* migrateArtifacts(local, bucket, index, {
    dryRun: args.has("dry-run"),
    ...(args.get("prefix") ? { prefix: args.get("prefix") } : {}),
    ...(args.get("sample") ? { sampleSize: Number(args.get("sample")) } : {}),
    log: (line) => console.log(line)
  })
  console.log(JSON.stringify(summary, null, 2))
  if (summary.failures.length > 0 || summary.verification.mismatches.length > 0) {
    console.error(
      `migration incomplete: ${summary.failures.length} failures, ` +
      `${summary.verification.mismatches.length} verification mismatches — fix and re-run (it resumes)`
    )
    process.exitCode = 1
  }
})

Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer))).catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
