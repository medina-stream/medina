import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MedinaAuth } from "./Auth.ts"

const directories: string[] = []
const registry = () => {
  const directory = mkdtempSync(join(tmpdir(), "medina-auth-"))
  directories.push(directory)
  return new MedinaAuth({ directory })
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe("MedinaAuth", () => {
  test("an approved request mints one revocable opaque bearer", () => {
    const auth = registry()
    const request = auth.createRequest("Muse")
    expect(auth.redeem(request.id)).toBe("pending")
    expect(auth.approve(request.id, "sco@scottraymond.net")?.status).toBe("approved")

    const redeemed = auth.redeem(request.id)
    expect(typeof redeemed).toBe("object")
    if (typeof redeemed !== "object") throw new Error("expected a token")
    expect(redeemed.token).toStartWith("md_")
    expect(auth.authorize(redeemed.token)).toMatchObject({ clientName: "Muse" })
    expect(auth.redeem(request.id)).toBe("missing")
    expect(auth.revokeId(auth.authorize(redeemed.token)?.tokenId ?? "")).toBe(true)
    expect(auth.authorize(redeemed.token)).toBeNull()
  })

  test("denied requests never mint a token", () => {
    const auth = registry()
    const request = auth.createRequest("Muse")
    expect(auth.deny(request.id, "sco@scottraymond.net")?.status).toBe("denied")
    expect(auth.redeem(request.id)).toBe("denied")
  })
})
