import { afterEach, describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppIconTarget, IMMUTABLE_CACHE, appIconManifest, appIconResponse, materializeAppIcon, webAppIconTarget } from "./AppIconResource.ts"
import { spaHome } from "../lib/lifelog/Pages.tsx"

const roots: string[] = []
const target = () => {
  const root = mkdtempSync(join(tmpdir(), "medina-app-icon-"))
  roots.push(root)
  return { root, value: webAppIconTarget(root) }
}
const run = <A>(effect: Effect.Effect<A, Error, import("effect/FileSystem").FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)))

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe("AppIcon materialization", () => {
  test("writes exactly the requested, content-addressed web target", async () => {
    const { value } = target()
    await run(materializeAppIcon(value))
    expect(value.outputs.every((output) => output.route.includes("/icons/") && /\.[a-f0-9]{16}\./.test(output.route))).toBe(true)
    expect(value.outputs.every((output) => readFileSync(output.path).length > 0)).toBe(true)

    for (const output of value.outputs.filter((entry) => entry.kind === "png" || entry.kind === "maskable")) {
      const bytes = readFileSync(output.path)
      expect(bytes.subarray(1, 4).toString()).toBe("PNG")
      expect(bytes.readUInt32BE(16)).toBe(output.size!)
      expect(bytes.readUInt32BE(20)).toBe(output.size!)
    }
    const ico = readFileSync(value.outputs.find((output) => output.kind === "ico")!.path)
    expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 3, 0])
  })

  test("rewrites incorrect outputs and emits a schema-shaped manifest", async () => {
    const { value } = target()
    await run(materializeAppIcon(value))
    const svg = value.outputs.find((output) => output.kind === "svg")!
    writeFileSync(svg.path, "stale")
    await run(materializeAppIcon(value))
    expect(readFileSync(svg.path, "utf8")).toStartWith("<svg")
    expect(appIconManifest(value).icons).toHaveLength(5)
  })
})

describe("AppIcon web integration", () => {
  test("serves only declared routes with immutable headers and content types", async () => {
    const { value } = target()
    await run(materializeAppIcon(value))
    for (const output of value.outputs) {
      const response = await run(appIconResponse(output.route, value))
      expect(response?.contentType).toBe(output.contentType)
      expect(response?.cacheControl).toBe(IMMUTABLE_CACHE)
      expect(response?.bytes.length).toBeGreaterThan(0)
    }
    expect(await run(appIconResponse("/icons/not-declared.png", value))).toBeNull()
  })

  test("shared HTML metadata points only at hashed generated URLs", () => {
    const html = spaHome()
    expect(html).toContain('name="theme-color"')
    expect(html).toMatch(/rel="manifest" href="\/icons\/manifest\.[a-f0-9]{16}\.webmanifest"/)
    expect(html).toMatch(/rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.[a-f0-9]{16}\.png"/)
    expect(html).toMatch(/rel="icon" type="image\/svg\+xml" href="\/icons\/favicon\.[a-f0-9]{16}\.svg"/)
  })
})
