import { afterEach, describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthStoreError, MedinaAuth } from "./Auth.ts"

const directories: string[] = []
const registry = (options?: { readonly requestTtlMs?: number; readonly tokenTtlMs?: number; readonly lastUsedFlushMs?: number }) => {
  const directory = mkdtempSync(join(tmpdir(), "medina-auth-"))
  directories.push(directory)
  return { directory, auth: new MedinaAuth({ directory, ...options }) }
}
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/FileSystem").FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)))

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe("MedinaAuth", () => {
  test("an approved request mints one revocable opaque bearer", async () => {
    const { auth } = registry()
    const request = await run(auth.createRequest("Muse"))
    expect(await run(auth.redeem(request.id))).toBe("pending")
    expect((await run(auth.approve(request.id, "sco@scottraymond.net")))?.status).toBe("approved")

    const redeemed = await run(auth.redeem(request.id))
    expect(typeof redeemed).toBe("object")
    if (typeof redeemed !== "object") throw new Error("expected a token")
    expect(redeemed.token).toStartWith("md_")
    expect(await run(auth.authorize(redeemed.token))).toMatchObject({ clientName: "Muse" })
    expect(await run(auth.redeem(request.id))).toBe("missing")
    expect(await run(auth.revokeId((await run(auth.authorize(redeemed.token)))?.tokenId ?? ""))).toBe(true)
    expect(await run(auth.authorize(redeemed.token))).toBeNull()
  })

  test("denied requests never mint a token", async () => {
    const { auth } = registry()
    const request = await run(auth.createRequest("Muse"))
    expect((await run(auth.deny(request.id, "sco@scottraymond.net")))?.status).toBe("denied")
    expect(await run(auth.redeem(request.id))).toBe("denied")
  })

  test("authorize persists lastUsedAt at most once per flush window", async () => {
    const { directory, auth } = registry()
    const request = await run(auth.createRequest("Muse"))
    await run(auth.approve(request.id, "owner"))
    const redeemed = await run(auth.redeem(request.id))
    if (typeof redeemed !== "object") throw new Error("expected a token")
    await run(auth.authorize(redeemed.token))
    const file = join(directory, "delegations.json")
    const afterFirst = readFileSync(file, "utf8")
    expect(JSON.parse(afterFirst).tokens[0].lastUsedAt).not.toBeNull()
    await run(auth.authorize(redeemed.token))
    await run(auth.authorize(redeemed.token))
    expect(readFileSync(file, "utf8")).toBe(afterFirst)
  })

  test("corrupt state fails with a typed AuthStoreError, not a sync throw", async () => {
    const { directory, auth } = registry()
    writeFileSync(join(directory, "delegations.json"), "{not json")
    const error = await run(auth.authorize("md_whatever")).then(
      () => null,
      (cause: unknown) => cause
    )
    expect(error).toBeInstanceOf(AuthStoreError)
  })

  test("expired entries are pruned on write", async () => {
    const { auth } = registry({ requestTtlMs: 1, tokenTtlMs: 1 })
    const request = await run(auth.createRequest("Muse"))
    await run(auth.approve(request.id, "owner"))
    await run(auth.redeem(request.id))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await run(auth.createRequest("other"))
    expect(await run(auth.listTokens())).toEqual([])
    const remaining = await run(auth.getRequest(request.id))
    expect(remaining).toBeNull()
  })

  test("cache is invalidated when another writer changes the file", async () => {
    const { directory, auth } = registry()
    const other = new MedinaAuth({ directory })
    const request = await run(auth.createRequest("Muse"))
    await run(auth.approve(request.id, "owner"))
    const redeemed = await run(other.redeem(request.id))
    if (typeof redeemed !== "object") throw new Error("expected a token")
    // Ensure a distinct mtime even on coarse filesystems.
    const future = new Date(Date.now() + 2000)
    utimesSync(join(directory, "delegations.json"), future, future)
    expect(await run(auth.authorize(redeemed.token))).toMatchObject({ clientName: "Muse" })
  })
})
