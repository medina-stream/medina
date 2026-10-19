/**
 * Manual requeue for media captures — the escape hatch Media.ts documents:
 * reset a capture's normalize/transcribe state so the pipeline re-normalizes
 * it from its archived original and transcribes the result exactly once.
 *
 * Written for the 2026-10-18 un-quarantine of the eleven 2021 archive
 * captures whose manifests had been renamed to
 * `<captureId>.json.quarantined-2026-10-18`. Their stale one-hour chunk
 * objects would poison manifest validation on re-normalization (duplicate /
 * surplus chunk indices), and any stale receipts would either short-circuit
 * re-normalization or fail receipt-vs-manifest validation in transcription.
 *
 * For each capture id:
 *   - refuse when a COMPLETED canonical transcript already exists (a requeue
 *     would re-buy finished work — that is never this script's job);
 *   - delete every R2 object under `media/media-v1/<captureId>/` (the stale
 *     chunks), using a temporary credential minted through the app's own
 *     R2TempCreds layer, scoped to exactly that prefix;
 *   - delete the local Transloadit normalize receipt, the transcript jobs
 *     receipt, and any transcribe-settled marker.
 *
 * Left untouched: the manifest (present or quarantined — re-normalization
 * needs it ABSENT at the canonical key, which this verifies), provenance,
 * ingest receipts, the archived original, and vendor receipts.
 *
 * Run it ON the Medina host, from the repo root (bun loads the service .env):
 *
 *   bun scripts/requeue-media-captures.ts <captureId> [more ids...]
 *   bun scripts/requeue-media-captures.ts --file /path/to/id-list.txt
 *
 * The --file form takes the first whitespace-separated token of each line,
 * matching media/quarantined-2026-10-18.txt's layout. Exits non-zero when
 * any capture failed or was refused.
 */
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import { existsSync, readFileSync, rmSync } from "node:fs"
import * as Effect from "effect/Effect"
import {
  MEDIA_VERSION,
  mediaManifestKey,
  transcriptJobsKey,
  transcriptSettledKey
} from "../lib/capture/Media.ts"
import { transloaditReceiptKey } from "../lib/capture/TransloaditNormalize.ts"
import { DATA_DIR, dataPath, transcriptKey } from "../lib/lifelog/Resources.ts"
import { R2TempCreds } from "../lib/R2TempCreds.ts"

const args = process.argv.slice(2)
const fileArg = args.find((arg) => arg.startsWith("--file="))?.slice("--file=".length)
  ?? (args.includes("--file") ? args[args.indexOf("--file") + 1] : undefined)
const idsFromFile = fileArg === undefined
  ? []
  : readFileSync(fileArg, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((token): token is string => token !== undefined && token.length > 0 && !token.startsWith("#"))
const captureIds = [...idsFromFile, ...args.filter((arg) => !arg.startsWith("--") && arg !== fileArg)]

if (captureIds.length === 0) {
  console.error("usage: bun scripts/requeue-media-captures.ts <captureId>... | --file <id-list>")
  process.exit(2)
}

console.log(`DATA_DIR=${DATA_DIR}`)
console.log(`requeueing ${captureIds.length} capture(s)`)

const deletePrefix = (
  r2: R2TempCreds["Service"],
  prefix: string
): Effect.Effect<number, Error> =>
  Effect.gen(function*() {
    const creds = yield* r2.mint({ permission: "object-read-write", prefixes: [prefix], ttlSeconds: 3600 })
    const client = new S3Client({
      endpoint: r2.endpoint,
      region: "auto",
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken
      }
    })
    let deleted = 0
    let continuation: string | undefined
    do {
      const page = yield* Effect.tryPromise({
        try: () => client.send(new ListObjectsV2Command({
          Bucket: r2.bucket,
          Prefix: prefix,
          ContinuationToken: continuation
        })),
        catch: (cause) => new Error(`list ${prefix} failed: ${String(cause)}`)
      })
      const keys = (page.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => typeof key === "string")
      if (keys.length > 0) {
        yield* Effect.tryPromise({
          try: () => client.send(new DeleteObjectsCommand({
            Bucket: r2.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true }
          })),
          catch: (cause) => new Error(`delete under ${prefix} failed: ${String(cause)}`)
        })
        deleted += keys.length
      }
      continuation = page.IsTruncated === true ? page.NextContinuationToken : undefined
    } while (continuation !== undefined)
    return deleted
  })

const requeueOne = (
  r2: R2TempCreds["Service"],
  captureId: string
): Effect.Effect<void, Error> =>
  Effect.gen(function*() {
    const canonicalPath = dataPath(transcriptKey(captureId))
    if (existsSync(canonicalPath)) {
      const status = (JSON.parse(readFileSync(canonicalPath, "utf8")) as { status?: unknown }).status
      if (status === "completed") {
        return yield* Effect.fail(new Error(
          `${captureId}: a completed canonical transcript already exists — refusing to requeue`
        ))
      }
      console.log(`${captureId}: canonical transcript present with status ${String(status)} (left in place)`)
    }
    if (existsSync(dataPath(mediaManifestKey(captureId)))) {
      return yield* Effect.fail(new Error(
        `${captureId}: a manifest exists at the canonical key — re-normalization would not re-fire; ` +
        `rename or remove it first (this script does not touch manifests)`
      ))
    }
    const prefix = `media/${MEDIA_VERSION}/${captureId}/`
    const deleted = yield* deletePrefix(r2, prefix)
    const removed: Array<string> = []
    for (const key of [transloaditReceiptKey(captureId), transcriptJobsKey(captureId), transcriptSettledKey(captureId)]) {
      const path = dataPath(key)
      if (existsSync(path)) {
        rmSync(path, { force: true })
        removed.push(key)
      }
    }
    console.log(
      `${captureId}: deleted ${deleted} R2 object(s) under ${prefix}; ` +
      `removed local state: ${removed.length > 0 ? removed.join(", ") : "(none present)"}`
    )
  })

const program = Effect.gen(function*() {
  const r2 = yield* R2TempCreds
  if (!r2.configured) {
    return yield* Effect.fail(new Error("R2TempCreds is not configured in this environment"))
  }
  const failures: Array<string> = []
  for (const captureId of captureIds) {
    const outcome = yield* Effect.either(requeueOne(r2, captureId))
    if (outcome._tag === "Left") failures.push(outcome.left.message)
  }
  if (failures.length > 0) {
    return yield* Effect.fail(new Error(`failures:\n${failures.join("\n")}`))
  }
})

await Effect.runPromise(program.pipe(Effect.provide(R2TempCreds.layer))).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
console.log("done — the pipeline re-normalizes and transcribes on its next passes")
