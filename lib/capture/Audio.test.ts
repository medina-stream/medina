import { mkdtemp, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { hashStreamToFile } from "./Audio.ts"

const encode = (text: string) => new TextEncoder().encode(text)

describe("hashStreamToFile", () => {
  test("streams chunked bytes to disk while hashing across chunk boundaries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "medina-audio-test-"))
    try {
      const tmp = join(dir, "capture")
      const digest = await Effect.runPromise(
        hashStreamToFile(Stream.fromIterable([encode("hello "), encode("wor"), encode("ld")]), tmp).pipe(
          Effect.provide(BunFileSystem.layer)
        )
      )
      expect(digest).toBe(createHash("sha256").update("hello world").digest("hex"))
      expect(await readFile(tmp, "utf8")).toBe("hello world")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a failed stream removes the partial file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "medina-audio-test-"))
    try {
      const tmp = join(dir, "capture")
      await expect(Effect.runPromise(
        hashStreamToFile(
          Stream.concat(Stream.make(encode("partial")), Stream.fail(new Error("boom"))),
          tmp
        ).pipe(Effect.provide(BunFileSystem.layer))
      )).rejects.toThrow("boom")
      expect(existsSync(tmp)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
