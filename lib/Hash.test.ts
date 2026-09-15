import { describe, expect, test } from "bun:test"
import { sha256 } from "./Hash.ts"

describe("sha256", () => {
  test("hashes a string to its known hex digest", () => {
    expect(sha256("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    )
  })

  test("hashes the empty string", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
  })

  test("Uint8Array input matches the same string input", () => {
    const bytes = new TextEncoder().encode("hello")
    expect(sha256(bytes)).toBe(sha256("hello"))
  })
})
