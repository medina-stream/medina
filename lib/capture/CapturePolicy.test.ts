import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CapturePolicyStore, decodePolicy, defaultPolicy } from "./CapturePolicy.ts"

const directories: string[] = []
const store = () => {
  const directory = mkdtempSync(join(tmpdir(), "medina-policy-"))
  directories.push(directory)
  return new CapturePolicyStore({ directory })
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe("CapturePolicyStore", () => {
  test("serves the default policy when none is stored", () => {
    const policy = store().readPolicy()
    expect(policy.version).toBe(1)
    expect(policy.audio.codec).toBe("aac")
    expect(policy.audio.channels).toBe(1)
    expect(policy.audio.sampleRateHz).toBe(16000)
    expect(policy.gps.enabled).toBe(true)
    expect(policy.upload.accessKeyId).toBe("")
  })

  test("a written policy round-trips and validates", () => {
    const s = store()
    const base = defaultPolicy()
    const updated = decodePolicy({
      ...JSON.parse(JSON.stringify(base)),
      version: 2,
      upload: { ...JSON.parse(JSON.stringify(base.upload)), bucket: "sco-lifelog-in", accessKeyId: "AKID", secretAccessKey: "shh" }
    })
    expect(updated).not.toBeNull()
    s.writePolicy(updated!)
    const read = s.readPolicy()
    expect(read.version).toBe(2)
    expect(read.upload.bucket).toBe("sco-lifelog-in")
    expect(read.upload.secretAccessKey).toBe("shh")
  })

  test("rejects a malformed policy document", () => {
    expect(decodePolicy({ version: "one" })).toBeNull()
    expect(decodePolicy(null)).toBeNull()
    expect(decodePolicy(defaultPolicy())).not.toBeNull()
  })

  test("issues opaque capability tokens that verify until revoked", () => {
    const s = store()
    const { id, token } = s.issueToken("pixel 10a")
    expect(token).toStartWith("cpol_")
    expect(s.verifyToken(token)).toBe(true)
    expect(s.verifyToken("cpol_bogus")).toBe(false)
    expect(s.verifyToken("md_bogus")).toBe(false)
    const listed = s.listTokens()
    expect(listed.length).toBe(1)
    expect(listed[0]!.id).toBe(id)
    expect(listed[0]!.label).toBe("pixel 10a")
    expect("hash" in listed[0]!).toBe(false)
    expect(s.revokeToken(id)).toBe(true)
    expect(s.revokeToken(id)).toBe(false)
    expect(s.verifyToken(token)).toBe(false)
  })

  test("tokens survive a store reload (hashes only on disk)", () => {
    const directory = mkdtempSync(join(tmpdir(), "medina-policy-"))
    directories.push(directory)
    const first = new CapturePolicyStore({ directory })
    const { token } = first.issueToken("pixel")
    const second = new CapturePolicyStore({ directory })
    expect(second.verifyToken(token)).toBe(true)
  })
})
