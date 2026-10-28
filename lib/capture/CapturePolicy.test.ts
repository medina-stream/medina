import { afterEach, describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeMemoryObjectStore } from "../ArtifactStore.ts"
import {
  CapturePolicyError,
  CapturePolicyStore,
  POLICY_OBJECT_KEY,
  TOKENS_OBJECT_KEY,
  decodePolicy,
  defaultPolicy
} from "./CapturePolicy.ts"

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

  test("the apk section decodes, round-trips, and is tolerated absent", async () => {
    const base = JSON.parse(JSON.stringify(defaultPolicy()))
    const withApk = decodePolicy({
      ...base,
      apk: {
        stamp: "0202610280317",
        url: "https://edge.example/bucket-capture/0202610280317.apk",
        sha256: "a".repeat(64),
        sizeBytes: 31569815,
        publishedAt: "2026-10-28T03:17:00Z",
        notes: "spectrogram build"
      }
    })
    expect(withApk).not.toBeNull()
    expect(withApk!.apk?.stamp).toBe("0202610280317")
    expect(withApk!.apk?.sizeBytes).toBe(31569815)
    expect(withApk!.apk?.notes).toBe("spectrogram build")
    // A policy written before APK distribution has no apk section.
    const without = decodePolicy(base)
    expect(without).not.toBeNull()
    expect(without!.apk ?? null).toBeNull()
    expect(decodePolicy({ ...base, apk: null })!.apk).toBeNull()
    // A malformed apk section invalidates the document rather than
    // being silently half-trusted.
    expect(decodePolicy({ ...base, apk: { stamp: 42 } })).toBeNull()
    // And the section survives a store round-trip.
    const s = store()
    await run(s.writePolicy(withApk!))
    const read = await run(s.readPolicy())
    expect(read.apk?.stamp).toBe("0202610280317")
    expect(read.apk?.sha256).toBe("a".repeat(64))
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

describe("CapturePolicyStore with a bucket backend", () => {
  const bucketStore = () => {
    const directory = mkdtempSync(join(tmpdir(), "medina-policy-"))
    directories.push(directory)
    const backing = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    const objects = makeMemoryObjectStore(backing)
    return {
      directory,
      backing,
      objects,
      store: new CapturePolicyStore({ directory, policyObjects: objects })
    }
  }

  test("writes land in the bucket and a fresh store reads them back", async () => {
    const { backing, objects, store: first } = bucketStore()
    const updated = decodePolicy({
      ...JSON.parse(JSON.stringify(defaultPolicy())),
      version: 2,
      apk: {
        stamp: "0202610280317",
        url: "https://edge.example/bucket-capture/0202610280317.apk",
        sha256: "b".repeat(64),
        sizeBytes: 123,
        publishedAt: "2026-10-28T03:17:00Z"
      }
    })
    await run(first.writePolicy(updated!))
    expect(backing.has(POLICY_OBJECT_KEY)).toBe(true)
    const secondDirectory = mkdtempSync(join(tmpdir(), "medina-policy-"))
    directories.push(secondDirectory)
    const second = new CapturePolicyStore({ directory: secondDirectory, policyObjects: objects })
    const read = await run(second.readPolicy())
    expect(read.version).toBe(2)
    expect(read.apk?.stamp).toBe("0202610280317")
  })

  test("the on-disk policy seeds the bucket on first read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "medina-policy-"))
    directories.push(directory)
    // Provision on disk only, as the deployment exists today.
    const fileOnly = new CapturePolicyStore({ directory })
    const provisioned = decodePolicy({
      ...JSON.parse(JSON.stringify(defaultPolicy())),
      upload: {
        ...JSON.parse(JSON.stringify(defaultPolicy().upload)),
        bucket: "sco-lifelog-in",
        accessKeyId: "AKID",
        secretAccessKey: "shh"
      }
    })
    await run(fileOnly.writePolicy(provisioned!))
    // A bucket-backed store over the same directory migrates it up.
    const backing = new Map<string, { bytes: Uint8Array; contentType?: string }>()
    const objects = makeMemoryObjectStore(backing)
    const migrated = new CapturePolicyStore({ directory, policyObjects: objects })
    const read = await run(migrated.readPolicy())
    expect(read.upload.accessKeyId).toBe("AKID")
    expect(backing.has(POLICY_OBJECT_KEY)).toBe(true)
    const seeded = JSON.parse(new TextDecoder().decode(backing.get(POLICY_OBJECT_KEY)!.bytes))
    expect(seeded.upload.secretAccessKey).toBe("shh")
  })

  test("an out-of-band bucket write is picked up on the next read", async () => {
    const { backing, objects, store: s } = bucketStore()
    await run(s.writePolicy(defaultPolicy()))
    // The publish script is a separate process writing the same object.
    const newer = {
      ...JSON.parse(JSON.stringify(defaultPolicy())),
      updatedAt: new Date().toISOString(),
      apk: {
        stamp: "0202610280400",
        url: "https://edge.example/bucket-capture/0202610280400.apk",
        sha256: "c".repeat(64),
        sizeBytes: 5,
        publishedAt: "2026-10-28T04:00:00Z"
      }
    }
    await Effect.runPromise(objects.put(POLICY_OBJECT_KEY, new TextEncoder().encode(JSON.stringify(newer)), "application/json"))
    const read = await run(s.readPolicy())
    expect(read.apk?.stamp).toBe("0202610280400")
  })

  test("token writes mirror the registry (hashes only) to the bucket", async () => {
    const { backing, objects, store: s } = bucketStore()
    const { token } = await run(s.issueToken("pixel"))
    expect(backing.has(TOKENS_OBJECT_KEY)).toBe(true)
    const mirror = new TextDecoder().decode(backing.get(TOKENS_OBJECT_KEY)!.bytes)
    expect(mirror).not.toContain(token)
    const parsed = JSON.parse(mirror)
    expect(parsed.tokens.length).toBe(1)
    expect(parsed.tokens[0].label).toBe("pixel")
    expect(typeof parsed.tokens[0].hash).toBe("string")
    // Revocation propagates to the mirror too.
    const listed = await run(s.listTokens())
    await run(s.revokeToken(listed[0]!.id))
    const after = JSON.parse(new TextDecoder().decode(backing.get(TOKENS_OBJECT_KEY)!.bytes))
    expect(after.tokens[0].revokedAt).not.toBeNull()
  })
})
