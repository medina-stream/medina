/**
 * Publish a built Bucket Capture APK for self-hosted distribution.
 *
 *   bun scripts/capture-apk-publish.ts --apk app-debug.apk [--stamp 0202610280317] [--notes "what changed"] [--public-base https://medina-index.alignlabs.workers.dev]
 *
 * Order matters: the APK object lands in the artifact bucket first
 * (`bucket-capture/<stamp>.apk`), and only then is the policy document's
 * `apk` section updated to name it — a device that reads the new policy
 * can always fetch the bytes it names. The stamp defaults to the
 * current UTC minute ("0" + yyyyMMddHHmm, the CaptureApk contract) and
 * must match the stamp baked into the APK at build time (-PAPK_STAMP).
 * The public base is where devices actually download from: the public
 * edge serving the bucket (default: $CAPTURE_PUBLIC_BASE_URL, else
 * $MEDINA_INDEX_URL). No secrets are involved or printed.
 */
import { createHash } from "node:crypto"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as ArtifactStore from "../lib/ArtifactStore.ts"
import { apkKey, apkPath, apkStamp, isApkStamp } from "../lib/capture/CaptureApk.ts"
import { CapturePolicyStore, decodePolicy } from "../lib/capture/CapturePolicy.ts"
import { dataPath } from "../lib/lifelog/Resources.ts"

const usage = `usage: bun scripts/capture-apk-publish.ts --apk FILE [options]
  --apk FILE          the built APK to publish (required)
  --stamp STAMP       build stamp, "0" + UTC yyyyMMddHHmm (default: now)
  --notes TEXT        short release note shown in the app's update prompt
  --public-base URL   public base the policy's apk.url is built from
                      (default: $CAPTURE_PUBLIC_BASE_URL else $MEDINA_INDEX_URL)
  --help              this text`

const parseArgs = (argv: string[]) => {
  const options: Record<string, string> = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ""
    if (arg === "--help") return { help: true as const }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg)
    if (match) { options[match[1] as string] = match[2] as string; continue }
    if (arg.startsWith("--")) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--")) throw new Error(`flag ${arg} needs a value`)
      options[arg.slice(2)] = value
      index++
    } else throw new Error(`unexpected argument: ${arg}`)
  }
  return { help: false as const, options }
}

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) { console.log(usage); return }
  const { options } = parsed
  const apkFile = options.apk
  if (!apkFile) throw new Error("--apk is required")
  const stamp = options.stamp ?? apkStamp(new Date())
  if (!isApkStamp(stamp)) throw new Error(`stamp must be "0" + UTC yyyyMMddHHmm (13 chars), got: ${stamp}`)
  const publicBase = (options["public-base"] ?? process.env.CAPTURE_PUBLIC_BASE_URL ?? process.env.MEDINA_INDEX_URL ?? "")
    .replace(/\/$/, "")
  if (!publicBase.startsWith("https://")) throw new Error("pass --public-base (or set CAPTURE_PUBLIC_BASE_URL / MEDINA_INDEX_URL)")

  const objects = ArtifactStore.objectStoreFromEnv()
  if (objects === null) throw new Error("ARTIFACT_BUCKET_* is not configured: nowhere to publish")

  const file = Bun.file(apkFile)
  if (!(await file.exists())) throw new Error(`no such file: ${apkFile}`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const key = apkKey(stamp)
  if (key === null) throw new Error("unreachable: stamp validated above")

  const run = <A, E>(effect: Effect.Effect<A, E, import("effect/FileSystem").FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)))

  // 1. The bytes first.
  await Effect.runPromise(objects.put(key, bytes, "application/vnd.android.package-archive"))
  console.log(`uploaded ${key} (${bytes.length} bytes, sha256 ${sha256})`)

  // 2. Then the policy names them.
  const store = new CapturePolicyStore({ directory: dataPath("capture-policy"), policyObjects: objects })
  const current = await run(store.readPolicy())
  const updated = decodePolicy({
    ...JSON.parse(JSON.stringify(current)),
    updatedAt: new Date().toISOString(),
    apk: {
      stamp,
      url: `${publicBase}${apkPath(stamp)}`,
      sha256,
      sizeBytes: bytes.length,
      publishedAt: new Date().toISOString(),
      ...(options.notes ? { notes: options.notes } : {})
    }
  })
  if (!updated) throw new Error("the merged policy failed validation; the APK is uploaded but unpublished")
  await run(store.writePolicy(updated))
  console.log(`policy updated: apk ${stamp} is now the published build`)
}

main().catch((error) => { console.error(`error: ${(error as Error).message}`); process.exit(1) })
