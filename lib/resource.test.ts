import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryBucket } from "./bucket.test";
import {
  bucketObject,
  createDeterministicResourceUuid,
  createMaterializationReceipt,
  defineResource,
  getDependencySetHash,
  fingerprintDependency,
  fetchBucketObjectToTempFile,
  getMaterializationFreshness,
  getMaterializationReceiptKey,
  resolveTempFilePath,
  Resource,
  runResource,
} from "./resource";

describe("Resource", () => {
  test("creates a bucket-backed resource reference", () => {
    const notes = new Resource<{ text: string }>({ kind: "notes" });

    expect(notes.ref({ id: "note-1" })).toEqual({
      id: "note-1",
      key: "notes/note-1.json",
      kind: "notes",
    });
  });

  test("does not expose bucket-backed resources by default", () => {
    const notes = new Resource<{ text: string }>({ kind: "notes" });

    expect(notes.ref({ id: "note-1" }).url).toBeUndefined();
  });

  test("creates stable UUID-shaped ids for resource names", async () => {
    const first = await createDeterministicResourceUuid("medina:test:resource");
    const second = await createDeterministicResourceUuid("medina:test:resource");
    const other = await createDeterministicResourceUuid("medina:test:other");

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("stores materialization receipts under a predictable key", () => {
    expect(getMaterializationReceiptKey("02026/05/05/recordings/example.json")).toBe(
      "resource-receipts/02026/05/05/recordings/example.json.receipt.json",
    );
  });

  test("fingerprints bucket object dependencies", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/example", "hello", { type: "text/plain" });

    await expect(fingerprintDependency(bucket, bucketObject("in/example"))).resolves.toMatchObject({
      contentType: "text/plain",
      contentHash: expect.any(String),
      exists: true,
      key: "in/example",
      size: 5,
      type: "bucket-object",
    });

    await expect(fingerprintDependency(bucket, bucketObject("in/missing"))).resolves.toEqual({
      contentType: null,
      contentHash: null,
      exists: false,
      key: "in/missing",
      lastModified: null,
      size: null,
      type: "bucket-object",
    });
  });

  test("uses stat-provided content hashes without rereading object bodies", async () => {
    const bucket = {
      async exists() { return true; },
      async list() { return { contents: [], isTruncated: false }; },
      async readArrayBuffer() { throw new Error("readArrayBuffer should not be called"); },
      async readJson() { throw new Error("readJson should not be called"); },
      async readText() { throw new Error("readText should not be called"); },
      async stat() {
        return {
          contentHash: "etag-123",
          lastModified: new Date("2026-05-07T12:00:00.000Z"),
          size: 100,
          type: "audio/mpeg",
        };
      },
      async write() { throw new Error("write should not be called"); },
    };

    await expect(fingerprintDependency(bucket, bucketObject("in/example"))).resolves.toEqual({
      contentType: "audio/mpeg",
      contentHash: "etag-123",
      exists: true,
      key: "in/example",
      lastModified: "2026-05-07T12:00:00.000Z",
      size: 100,
      type: "bucket-object",
    });
  });

  test("decides freshness from output, receipt, definition, and dependencies", async () => {
    const definition = { name: "recordings", version: "1" };
    const dependencies = [{
      contentHash: "abc123",
      contentType: "audio/mpeg",
      exists: true,
      key: "in/example",
      lastModified: "2026-05-07T12:00:00.000Z",
      size: 100,
      type: "bucket-object" as const,
    }];
    const receipt = createMaterializationReceipt({
      dependencies,
      definition,
      dependencySetHash: await getDependencySetHash(dependencies),
      materializedAt: new Date("2026-05-07T12:01:00.000Z"),
      resourceKey: "recordings/example.json",
    });

    expect(getMaterializationFreshness({
      currentDependencies: dependencies,
      definition,
      outputExists: true,
      receipt,
    })).toEqual({ fresh: true });

    expect(getMaterializationFreshness({
      currentDependencies: dependencies,
      definition,
      outputExists: false,
      receipt,
    })).toEqual({ fresh: false, reason: "missing-output" });

    expect(getMaterializationFreshness({
      currentDependencies: dependencies,
      definition: { name: "recordings", version: "2" },
      outputExists: true,
      receipt,
    })).toEqual({ fresh: false, reason: "definition-changed" });

    expect(getMaterializationFreshness({
      currentDependencies: [{ ...dependencies[0]!, size: 101 }],
      definition,
      outputExists: true,
      receipt,
    })).toEqual({ fresh: false, reason: "dependencies-changed" });
  });
});

describe("resource execution", () => {
  test("bounds output freshness checks", async () => {
    const backend = createMemoryBucket();
    let activeChecks = 0;
    let maxActiveChecks = 0;
    const bucket = {
      ...backend,
      async exists(key: string) {
        if (!key.startsWith("derived/")) return backend.exists(key);
        activeChecks += 1;
        maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
        await Bun.sleep(2);
        activeChecks -= 1;
        return backend.exists(key);
      },
    };
    const outputs = Array.from({ length: 40 }, (_, index) => `derived/${index}.json`);
    const resource = defineResource({
      async materialize({ bucket }) {
        for (const output of outputs) await bucket.write(output, "{}");
      },
      name: "bounded-checks",
      async plan() {
        return { dependencies: [], outputs, state: null };
      },
      version: "1",
    });

    await runResource(resource, { bucket, inputKey: "in/example" });

    expect(maxActiveChecks).toBeLessThanOrEqual(8);
  });

  test("materializes planned outputs and writes receipts", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/example.txt", "hello", { type: "text/plain" });
    let runCount = 0;

    const resource = defineResource({
      async materialize({ bucket }) {
        runCount += 1;
        await bucket.write("derived/example.json", JSON.stringify({ ok: true }), {
          type: "application/json; charset=utf-8",
        });
      },
      name: "example-resource",
      async plan() {
        return {
          dependencies: [bucketObject("in/example.txt")],
          outputs: ["derived/example.json"],
          state: { primaryOutput: "derived/example.json" },
        };
      },
      version: "1",
    });

    const first = await runResource(resource, {
      bucket,
      inputKey: "in/example.txt",
      now: new Date("2026-05-15T12:00:00.000Z"),
    });

    expect(first.materialized).toBe(true);
    expect(first.outputs).toEqual(["derived/example.json"]);
    expect(await bucket.readJson(getMaterializationReceiptKey("derived/example.json"))).toMatchObject({
      dependencySetHash: expect.any(String),
      definition: {
        name: "example-resource",
        version: "1",
      },
      materializedAt: "2026-05-15T12:00:00.000Z",
      resourceKey: "derived/example.json",
    });

    const second = await runResource(resource, {
      bucket,
      inputKey: "in/example.txt",
      now: new Date("2026-05-15T12:05:00.000Z"),
    });

    expect(second.materialized).toBe(false);
    expect(runCount).toBe(1);
  });

  test("reruns when forced", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/example.txt", "hello", { type: "text/plain" });
    let runCount = 0;

    const resource = defineResource({
      async materialize({ bucket }) {
        runCount += 1;
        await bucket.write("derived/example.json", JSON.stringify({ runCount }), {
          type: "application/json; charset=utf-8",
        });
      },
      name: "example-resource",
      async plan() {
        return {
          dependencies: [bucketObject("in/example.txt")],
          outputs: ["derived/example.json"],
          state: null,
        };
      },
      version: "1",
    });

    await runResource(resource, {
      bucket,
      inputKey: "in/example.txt",
      now: new Date("2026-05-15T12:00:00.000Z"),
    });

    const rerun = await runResource(resource, {
      bucket,
      force: true,
      inputKey: "in/example.txt",
      now: new Date("2026-05-15T12:10:00.000Z"),
    });

    expect(rerun.materialized).toBe(true);
    expect(runCount).toBe(2);
    expect(await bucket.readJson("derived/example.json")).toEqual({ runCount: 2 });
  });

  test("records warnings in receipts and retries degraded outputs after the retry delay", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/example.txt", "hello", { type: "text/plain" });
    let runCount = 0;
    let degrade = true;

    const resource = defineResource({
      async materialize({ bucket, warn }) {
        runCount += 1;
        if (degrade) warn({ code: "llm-unconfigured", message: "no api key" });
        await bucket.write("derived/example.json", JSON.stringify({ runCount }), {
          type: "application/json; charset=utf-8",
        });
      },
      name: "degradable-resource",
      async plan() {
        return {
          dependencies: [bucketObject("in/example.txt")],
          outputs: ["derived/example.json"],
          state: {},
        };
      },
      version: "1",
    });

    const first = await runResource(resource, {
      bucket,
      inputKey: "in/example.txt",
      now: new Date("2026-05-15T12:00:00.000Z"),
    });
    expect(first.materialized).toBe(true);
    expect(first.warnings).toEqual([{ code: "llm-unconfigured", message: "no api key" }]);
    expect(await bucket.readJson(getMaterializationReceiptKey("derived/example.json"))).toMatchObject({
      warnings: [{ code: "llm-unconfigured", message: "no api key" }],
    });

    const soonAfter = await runResource(resource, {
      bucket,
      inputKey: "in/example.txt",
      now: new Date("2026-05-15T12:05:00.000Z"),
    });
    expect(soonAfter.materialized).toBe(false);
    expect(soonAfter.warnings).toEqual([{ code: "llm-unconfigured", message: "no api key" }]);

    degrade = false;
    const afterDelay = await runResource(resource, {
      bucket,
      inputKey: "in/example.txt",
      now: new Date("2026-05-15T12:20:00.000Z"),
    });
    expect(afterDelay.materialized).toBe(true);
    expect(afterDelay.freshness).toEqual([{ fresh: false, reason: "degraded" }]);
    expect(afterDelay.warnings).toEqual([]);
    const receipt = await bucket.readJson<{ warnings?: unknown[] }>(getMaterializationReceiptKey("derived/example.json"));
    expect(receipt.warnings).toBeUndefined();

    const healthy = await runResource(resource, {
      bucket,
      inputKey: "in/example.txt",
      now: new Date("2026-05-15T13:00:00.000Z"),
    });
    expect(healthy.materialized).toBe(false);
    expect(runCount).toBe(2);
  });
});

describe("resource temp helpers", () => {
  test("preserves the original file extension", () => {
    expect(resolveTempFilePath("medina-capture-123.mp3")).toBe("/tmp/medina-capture-123.mp3");
  });

  test("sanitizes directory components", () => {
    expect(resolveTempFilePath("../nested/clip.m4a")).toBe("/tmp/clip.m4a");
  });
});


describe("resource temp files", () => {
  test("uses bucket-native downloads without buffering the object", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "medina-resource-test-"));
    let downloaded = false;
    const bucket = {
      async delete() {},
      async downloadToFile(_key: string, destination: string) {
        downloaded = true;
        await Bun.write(destination, "streamed");
      },
      async exists() { return true; },
      async list() { return { contents: [], isTruncated: false }; },
      async readArrayBuffer() { throw new Error("readArrayBuffer should not be called"); },
      async readJson() { throw new Error("readJson should not be called"); },
      async readText() { throw new Error("readText should not be called"); },
      async stat() { throw new Error("stat should not be called"); },
      async write() {},
    };

    try {
      const path = await fetchBucketObjectToTempFile("in/example", "example.mp3", { bucket, tempDir });
      expect(downloaded).toBe(true);
      expect(await readFile(path, "utf8")).toBe("streamed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
