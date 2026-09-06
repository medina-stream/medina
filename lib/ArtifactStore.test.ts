import { describe, expect, test } from "bun:test"
import { artifactPath, key } from "./ArtifactStore.ts"

describe("artifact keys", () => {
  test("resolve beneath the configured root", () => {
    expect(artifactPath("data/artifacts", "journal/v1/day.json")).toBe("data/artifacts/journal/v1/day.json")
  })

  test("reject absolute and parent-traversing paths", () => {
    expect(() => key("/etc/passwd")).toThrow()
    expect(() => key("../outside")).toThrow()
  })
})
