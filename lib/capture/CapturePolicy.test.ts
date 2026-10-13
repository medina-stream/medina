import { afterEach, describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CapturePolicyError, CapturePolicyStore, decodePolicy, defaultPolicy } from "./CapturePolicy.ts"

const directories: string[] = []
const store = () => {
  const directory = mkdtempSync(join(tmpdir(), "medina-policy-"))
  directories.push(directory)
  return new CapturePolicyStore({ directory })
}
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/FileSystem").FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)))

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe("CapturePolicyStore", () => {
  test("serves the default policy when none is stored", async () => {
    const policy = await run(store().readPolicy())
    expect(policy.version).toBe(1)
    expect(policy.audio.codec).toBe("aac")
    expect(policy.audio.channels).toBe(1)
    expect(policy.audio.sampleRateHz).toBe(16000)
    expect(policy.gps.enabled).toBe(true)
    expect(policy.upload.accessKeyId).toBe("")
  })

  test("a written policy round-trips and validates", async () => {
    const s = store()
    const base = defaultPolicy()
    const updated = decodePolicy({
      ...JSON.parse(JSON.stringify(base)),
      version: 2,
      upload: { ...JSON.parse(JSON.stringify(base.upload)), bucket: "sco-lifelog-in", accessKeyId: "AKID", secretAccessKey: "shh" }
    })
    expect(updated).not.toBeNull()
    await run(s.writePolicy(updated!))
    const read = await run(s.readPolicy())
    expect(read.version).toBe(2)
    expect(read.upload.bucket).toBe("sco-lifelog-in")
    expect(read.upload.secretAccessKey).toBe("shh")
  })

  test("rejects a malformed policy document", () => {
    expect(decodePolicy({ version: "one" })).toBeNull()
    expect(decodePolicy(null)).toBeNull()
    expect(decodePolicy(defaultPolicy())).not.toBeNull()
  })

  test("issues opaque capability tokens that verify until revoked", async () => {
    const s = store()
    const { id, token } = await run(s.issueToken("pixel 10a"))
    expect(token).toStartWith("cpol_")
    expect(await run(s.verifyToken(token))).toBe(true)
    expect(await run(s.verifyToken("cpol_bogus"))).toBe(false)
    expect(await run(s.verifyToken("md_bogus"))).toBe(false)
    const listed = await run(s.listTokens())
    expect(listed.length).toBe(1)
    expect(listed[0]!.id).toBe(id)
    expect(listed[0]!.label).toBe("pixel 10a")
    expect("hash" in listed[0]!).toBe(false)
    expect(await run(s.revokeToken(id))).toBe(true)
    expect(await run(s.revokeToken(id))).toBe(false)
    expect(await run(s.verifyToken(token))).toBe(false)
  })

  test("tokens survive a store reload (hashes only on disk)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "medina-policy-"))
    directories.push(directory)
    const first = new CapturePolicyStore({ directory })
    const { token } = await run(first.issueToken("pixel"))
    const second = new CapturePolicyStore({ directory })
    expect(await run(second.verifyToken(token))).toBe(true)
  })

  test("verifyToken persists lastUsedAt at most once per flush window", async () => {
    const directory = mkdtempSync(join(tmpdir(), "medina-policy-"))
    directories.push(directory)
    const s = new CapturePolicyStore({ directory })
    const { token } = await run(s.issueToken("pixel"))
    expect(await run(s.verifyToken(token))).toBe(true)
    const file = join(directory, "tokens.json")
    const afterFirst = readFileSync(file, "utf8")
    expect(JSON.parse(afterFirst).tokens[0].lastUsedAt).not.toBeNull()
    await run(s.verifyToken(token))
    await run(s.verifyToken(token))
    expect(readFileSync(file, "utf8")).toBe(afterFirst)
  })

  test("corrupt token state fails with a typed CapturePolicyError", async () => {
    const directory = mkdtempSync(join(tmpdir(), "medina-policy-"))
    directories.push(directory)
    writeFileSync(join(directory, "tokens.json"), "{not json")
    const s = new CapturePolicyStore({ directory })
    const error = await run(s.verifyToken("cpol_whatever")).then(
      () => null,
      (cause: unknown) => cause
    )
    expect(error).toBeInstanceOf(CapturePolicyError)
  })

  test("long-revoked tokens are pruned on write", async () => {
    const directory = mkdtempSync(join(tmpdir(), "medina-policy-"))
    directories.push(directory)
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString()
    writeFileSync(join(directory, "tokens.json"), JSON.stringify({
      version: 1,
      tokens: [{ id: "old", label: "old", hash: "00", createdAt: old, revokedAt: old, lastUsedAt: null }]
    }))
    const s = new CapturePolicyStore({ directory })
    await run(s.issueToken("new device"))
    const listed = await run(s.listTokens())
    expect(listed.map((token) => token.label)).toEqual(["new device"])
  })
})
