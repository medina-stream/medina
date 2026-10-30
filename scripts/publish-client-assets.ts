/**
 * Publish the journal UI's static client assets to the artifact bucket
 * under `client/` keys, where the Cloudflare Worker serves them
 * (migration milestone 4, docs/cloudflare-migration.md §4.3).
 *
 * The assets are build outputs — `example-lifelog/public/app.js` (from
 * `bun run build:client`), the self-hosted Inter variable font, and the
 * generated app icons under `example-lifelog/public/icons/` — not
 * pipeline artifacts, so they are written through the raw object store
 * (the same path CapturePolicy uses for the policy document) and are
 * deliberately NOT registered in the artifact index: nothing on the
 * server lists them, and the Worker reads them through its R2 binding.
 * Re-running republishes; keys are unversioned for the transition, so
 * run this after any client build that should reach the Worker.
 *
 * Run it ON the Medina host, where the build and the bucket
 * credentials (ARTIFACT_BUCKET_*) live:
 *
 *   bun run build && bun scripts/publish-client-assets.ts
 */
import * as Effect from "effect/Effect"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { objectStoreFromEnv } from "../lib/ArtifactStore.ts"

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
}

const contentTypeFor = (name: string): string => {
  const dot = name.lastIndexOf(".")
  return CONTENT_TYPES[dot === -1 ? "" : name.slice(dot)] ?? "application/octet-stream"
}

interface Asset {
  readonly key: string
  readonly path: string
}

const assets: Array<Asset> = [
  { key: "client/app.js", path: "example-lifelog/public/app.js" },
  {
    key: "client/inter.woff2",
    path: "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"
  }
]

const program = Effect.gen(function*() {
  const store = objectStoreFromEnv()
  if (store === null) {
    return yield* Effect.fail(
      new Error("ARTIFACT_BUCKET_* is not configured: the client assets have nowhere to go")
    )
  }
  const iconDir = "example-lifelog/public/icons"
  const iconNames = yield* Effect.promise(() => readdir(iconDir))
  const all: Array<Asset> = [
    ...assets,
    ...iconNames
      .filter((name) => !name.startsWith("."))
      .map((name) => ({ key: `client/icons/${name}`, path: join(iconDir, name) }))
  ]
  const published: Array<{ key: string; size: number; sha256: string }> = []
  for (const asset of all) {
    const bytes = yield* Effect.promise(() => readFile(asset.path))
    yield* store.put(asset.key, bytes, contentTypeFor(asset.path))
    published.push({
      key: asset.key,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    })
    console.log(`published ${asset.key} (${bytes.length} bytes)`)
  }
  console.log(JSON.stringify({ published }, null, 2))
})

Effect.runPromise(program).catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
