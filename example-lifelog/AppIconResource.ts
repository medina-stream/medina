import { Resvg } from "@resvg/resvg-js"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { dirname, join } from "node:path"
import { sha256 } from "../lib/Hash.ts"
import type { Resource, TargetMaterializable } from "../lib/Resource.ts"
import { AppIcon } from "./app-icon.ts"

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

const OutputKind = Schema.Literals(["svg", "png", "maskable", "ico", "manifest"])
export class AppIconOutput extends Schema.Class<AppIconOutput>("AppIconOutput")({
  kind: OutputKind,
  path: Schema.String,
  route: Schema.String,
  contentType: Schema.String,
  size: Schema.optional(Schema.Number)
}) {}

export class AppIconTarget extends Schema.Class<AppIconTarget>("AppIconTarget")({
  outputs: Schema.Array(AppIconOutput)
}) {}

const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${AppIcon.backgroundColor}"/><g transform="translate(102.4 102.4) scale(.8)">${AppIcon.foregroundSvg}</g></svg>`
const png = (svg: string, size: number) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng()

const ico = (images: ReadonlyArray<{ size: number; bytes: Uint8Array }>) => {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, bytes }, index) => {
    const at = 6 + index * 16
    header[at] = size === 256 ? 0 : size; header[at + 1] = size === 256 ? 0 : size
    header[at + 2] = 0; header[at + 3] = 0
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(bytes.length, at + 8); header.writeUInt32LE(offset, at + 12)
    offset += bytes.length
  })
  return new Uint8Array(Buffer.concat([header, ...images.map(({ bytes }) => bytes)]))
}

const svgBytes = new TextEncoder().encode(AppIcon.svg)
const icoBytes = ico([16, 32, 48].map((size) => ({ size, bytes: png(AppIcon.svg, size) })))
const contentRoute = (stem: string, extension: string, bytes: Uint8Array) =>
  `/icons/${stem}.${sha256(bytes).slice(0, 16)}.${extension}`
const output = (root: string, values: Omit<ConstructorParameters<typeof AppIconOutput>[0], "path" | "route"> & { stem: string; extension: string; bytes: Uint8Array }) => {
  const route = contentRoute(values.stem, values.extension, values.bytes)
  return new AppIconOutput({ kind: values.kind, contentType: values.contentType, ...(values.size === undefined ? {} : { size: values.size }), route, path: join(root, route) })
}

const baseOutputs = (root: string) => [
  output(root, { kind: "svg", stem: "favicon", extension: "svg", bytes: svgBytes, contentType: "image/svg+xml" }),
  output(root, { kind: "ico", stem: "favicon", extension: "ico", bytes: icoBytes, contentType: "image/x-icon" }),
  ...([180, 192, 512] as const).map((size) => output(root, { kind: "png", size, stem: size === 180 ? "apple-touch-icon" : `icon-${size}`, extension: "png", bytes: png(AppIcon.svg, size), contentType: "image/png" })),
  ...([192, 512] as const).map((size) => output(root, { kind: "maskable", size, stem: `icon-maskable-${size}`, extension: "png", bytes: png(maskableSvg, size), contentType: "image/png" }))
]

export const appIconManifest = (target: AppIconTarget = webIconTarget) => ({
  id: "/", start_url: "/", scope: "/", display: "standalone",
  name: AppIcon.name, short_name: AppIcon.shortName, description: AppIcon.description,
  theme_color: AppIcon.themeColor, background_color: AppIcon.backgroundColor,
  icons: target.outputs.flatMap((output) => {
    if (output.kind === "svg") return [{ src: output.route, sizes: "any", type: output.contentType, purpose: "any" }]
    if (output.kind === "png" && output.size !== 180) return [{ src: output.route, sizes: `${output.size}x${output.size}`, type: output.contentType, purpose: "any" }]
    if (output.kind === "maskable") return [{ src: output.route, sizes: `${output.size}x${output.size}`, type: output.contentType, purpose: "maskable" }]
    return []
  })
})

export const webAppIconTarget = (root = "example-lifelog/public") => {
  const outputs = baseOutputs(root)
  const withoutManifest = new AppIconTarget({ outputs })
  const manifestBytes = new TextEncoder().encode(JSON.stringify(appIconManifest(withoutManifest), null, 2) + "\n")
  return new AppIconTarget({ outputs: [...outputs, output(root, { kind: "manifest", stem: "manifest", extension: "webmanifest", bytes: manifestBytes, contentType: "application/manifest+json" })] })
}

export const webIconTarget = webAppIconTarget()
export const webIconOutput = (kind: AppIconOutput["kind"], size?: number) => {
  const found = webIconTarget.outputs.find((entry) => entry.kind === kind && (size === undefined || entry.size === size))
  if (!found) throw new Error(`missing AppIcon output ${kind}/${size ?? "default"}`)
  return found
}

export const materializeAppIcon = (target: AppIconTarget): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* Schema.decodeUnknownEffect(AppIconTarget)(target)
    for (const output of target.outputs) {
      yield* fs.makeDirectory(dirname(output.path), { recursive: true })
      const body = output.kind === "svg" ? new TextEncoder().encode(AppIcon.svg)
        : output.kind === "ico" ? icoBytes
        : output.kind === "manifest" ? new TextEncoder().encode(JSON.stringify(appIconManifest(target), null, 2) + "\n")
        : png(output.kind === "maskable" ? maskableSvg : AppIcon.svg, output.size!)
      yield* fs.writeFile(output.path, body)
    }
  }).pipe(Effect.mapError((cause) => cause instanceof Error ? cause : new Error(String(cause))))

export const appIconResource: Resource<FileSystem.FileSystem> & TargetMaterializable<FileSystem.FileSystem, AppIconTarget> = {
  name: "app-icon",
  instances: Effect.succeed([]),
  materialize: materializeAppIcon
}

export const appIconResponse = (requestedRoute: string, target: AppIconTarget = webIconTarget) =>
  Effect.gen(function*() {
    const output = target.outputs.find(({ route }) => route === requestedRoute)
    if (!output) return null
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(output.path))) return null
    return { bytes: yield* fs.readFile(output.path), contentType: output.contentType, cacheControl: IMMUTABLE_CACHE }
  })

/** The build is only an invoker; AppIcon remains the owner of materialization. */
export const buildWebAppIcon = () =>
  Effect.runPromise(appIconResource.materialize(webIconTarget).pipe(Effect.provide(BunFileSystem.layer)))
