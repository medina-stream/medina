import { describe, expect, test } from "bun:test";

import { createMemoryBucket } from "./bucket.test";
import { artifactRefFromBucket } from "./artifact";

describe("artifact refs", () => {
  test("builds refs from bucket stat without reusing content hashes as integrity", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/example.mp3", "hello", { type: "audio/mpeg" });

    const ref = await artifactRefFromBucket(bucket, "in/example.mp3");

    expect(ref).toMatchObject({
      contentType: "audio/mpeg",
      key: "in/example.mp3",
      sizeBytes: 5,
    });
    expect(ref.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ref.integrity).toBeUndefined();
  });

  test("accepts explicit caller-provided integrity and metadata overrides", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/example.bin", new Uint8Array([1, 2, 3]), { type: "application/octet-stream" });

    expect(await artifactRefFromBucket(bucket, "in/example.bin", {
      contentType: "audio/aac",
      createdAt: "2026-07-17T12:34:56.000Z",
      integrity: { algorithm: "sha256", digest: "abc123" },
    })).toEqual({
      contentType: "audio/aac",
      createdAt: "2026-07-17T12:34:56.000Z",
      integrity: { algorithm: "sha256", digest: "abc123" },
      key: "in/example.bin",
      sizeBytes: 3,
    });
  });
});
