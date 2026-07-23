import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMemoryBucket } from "./bucket.test";
import { artifactRefKey, readArtifactRef } from "./artifact";
import { createArtifactResolver } from "./artifact-bun";

function stream(...chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("artifact resolver", () => {
  test("publishes streamed bytes to durable storage and a SHA-256 CAS", async () => {
    const bucket = createMemoryBucket();
    const cacheDir = await mkdtemp(join(tmpdir(), "medina-artifact-test-"));
    try {
      const resolver = createArtifactResolver({ bucket, cacheDir, workerId: "test" });
      const ref = await resolver.publish({
        contentType: "audio/mpeg",
        key: "in/streamed",
        source: { kind: "stream", stream: stream("hello ", "world") },
      });
      const lease = await resolver.resolve(ref);

      expect(await bucket.readText("in/streamed")).toBe("hello world");
      expect(ref).toMatchObject({
        contentType: "audio/mpeg",
        integrity: { algorithm: "sha256", digest: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9" },
        sizeBytes: 11,
      });
      expect(await Bun.file(lease.localPath).text()).toBe("hello world");
      expect(await bucket.exists(artifactRefKey("in/streamed"))).toBe(true);
      await lease.release();
    } finally {
      await rm(cacheDir, { force: true, recursive: true });
    }
  });

  test("legacy objects acquire integrity metadata when resolved", async () => {
    const bucket = createMemoryBucket();
    const cacheDir = await mkdtemp(join(tmpdir(), "medina-artifact-legacy-test-"));
    try {
      await bucket.write("in/legacy", "legacy bytes", { type: "application/octet-stream" });
      const resolver = createArtifactResolver({ bucket, cacheDir, workerId: "test" });
      const lease = await resolver.resolve({ key: "in/legacy" });

      expect(lease.artifact.integrity?.algorithm).toBe("sha256");
      expect((await readArtifactRef(bucket, "in/legacy"))?.integrity).toEqual(lease.artifact.integrity);
      await lease.release();
    } finally {
      await rm(cacheDir, { force: true, recursive: true });
    }
  });
});


describe("artifact resolver concurrency", () => {
  test("shared resolvers preserve leased files and do not clear each other's temporary space", async () => {
    const bucket = createMemoryBucket();
    const cacheDir = await mkdtemp(join(tmpdir(), "medina-artifact-concurrency-test-"));
    try {
      const first = createArtifactResolver({ bucket, cacheDir, cacheMaxBytes: 1, workerId: "first" });
      const second = createArtifactResolver({ bucket, cacheDir, cacheMaxBytes: 1, workerId: "second" });
      const firstRef = await first.publish({ key: "in/first", source: { kind: "stream", stream: stream("first") } });
      const firstLease = await first.resolve(firstRef);
      const secondRef = await second.publish({ key: "in/second", source: { kind: "stream", stream: stream("second") } });
      const secondLease = await second.resolve(secondRef);

      expect(await Bun.file(firstLease.localPath).text()).toBe("first");
      expect(await Bun.file(secondLease.localPath).text()).toBe("second");
      await firstLease.release();
      await secondLease.release();
    } finally {
      await rm(cacheDir, { force: true, recursive: true });
    }
  });

  test("publishes completed local files into the CAS", async () => {
    const bucket = createMemoryBucket();
    const cacheDir = await mkdtemp(join(tmpdir(), "medina-artifact-local-test-"));
    const sourcePath = join(cacheDir, "chunk.ogg");
    try {
      await writeFile(sourcePath, "local chunk");
      const resolver = createArtifactResolver({ bucket, cacheDir: join(cacheDir, "cas"), workerId: "test" });
      const ref = await resolver.publish({
        contentType: "audio/ogg",
        key: "chunks/0202607171200/recording.ogg",
        source: { kind: "local-path", path: sourcePath },
      });
      const lease = await resolver.resolve({ key: ref.key });

      expect(await Bun.file(lease.localPath).text()).toBe("local chunk");
      expect(await bucket.readText(ref.key)).toBe("local chunk");
      await lease.release();
    } finally {
      await rm(cacheDir, { force: true, recursive: true });
    }
  });
});
