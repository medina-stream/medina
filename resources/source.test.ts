import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryBucket } from "../lib/bucket.test";
import {
  readSourceStatus,
  registerSourceDefinition,
  writeSourceConfig,
  writeSyncState,
  type Source,
  type SourceConfig,
  type SourceFile,
} from "../lib/source";
import { syncAllSources, syncOneSourceById, syncSource } from "./source";
import { executeSourceFetchWork, sourceFetchWorkDefinition } from "./source-fetch";
import { claimWork } from "../lib/work-queue";

const originalEnv = { ...process.env };

beforeEach(() => { process.env = { ...originalEnv }; });
afterEach(() => { process.env = { ...originalEnv }; });

function makeFakeSource(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return { id: "fake-1", type: "fake", enabled: true, extensions: [".m4a"], ...overrides };
}

function fakeDefinition(files: SourceFile[], bodies: Record<string, ArrayBuffer>, errors: Set<string>) {
  return {
    type: "fake",
    validate() {},
    create(config: SourceConfig): Source {
      return {
        config,
        async listFiles() { return files; },
        async fetchFile(file: SourceFile) {
          if (errors.has(file.id)) throw new Error(`fake fetch error ${file.id}`);
          return { body: bodies[file.id] ?? new ArrayBuffer(4), contentType: file.mimeType ?? "application/octet-stream", filename: file.name };
        },
      };
    },
  };
}

async function drainSourceFetchWork(bucket: ReturnType<typeof createMemoryBucket>, maxItems = 20) {
  let processed = 0;
  const noopPublish = async () => {};
  while (processed < maxItems) {
    const work = await claimWork({ bucket, definitionName: sourceFetchWorkDefinition.name, workerId: "test-worker" });
    if (!work) break;
    await executeSourceFetchWork({ backend: bucket, maxAttempts: 1, publishEvent: noopPublish, work });
    processed += 1;
  }
  return processed;
}

describe("syncSource orchestrator", () => {
  test("queues fetch work for new files, skips unchanged", async () => {
    const bucket = createMemoryBucket();
    await writeSourceConfig(bucket, makeFakeSource());
    const files = [
      { id: "a", name: "a.m4a", mimeType: "audio/mp4", md5Checksum: "h1", modifiedTime: "2026-01-02T00:00:00.000Z" },
      { id: "b", name: "notes.txt", mimeType: "text/plain", modifiedTime: "2026-01-02T00:00:00.000Z" },
    ];
    registerSourceDefinition(fakeDefinition(files, { a: new ArrayBuffer(8) }, new Set()));
    const result = await syncSource({ bucket, config: makeFakeSource() });
    expect(result.synced).toBe(true);
    expect(result.summary?.queued).toBe(1);
    expect(result.summary?.skipped).toBe(1);
    expect((await bucket.list({ prefix: "in/" })).contents?.length ?? 0).toBe(0);

    expect(await drainSourceFetchWork(bucket)).toBe(1);
    const ingests = (await bucket.list({ prefix: "in/" })).contents ?? [];
    expect(ingests.length).toBe(1);

    const second = await syncSource({ bucket, config: makeFakeSource() });
    expect(second.summary?.queued).toBe(0);
    expect(second.summary?.skipped).toBe(2);
  });

  test("re-queues when md5 changes", async () => {
    const bucket = createMemoryBucket();
    await writeSyncState(bucket, "fake-1", { fileId: "a", md5Checksum: "old", modifiedTime: "2026-01-02T00:00:00.000Z", ingestKey: "in/old", ingestedAt: "2026-01-02T00:00:00.000Z" });
    const changed = [{ id: "a", name: "a.m4a", mimeType: "audio/mp4", md5Checksum: "new", modifiedTime: "2026-01-02T00:00:00.000Z" }];
    registerSourceDefinition(fakeDefinition(changed, { a: new ArrayBuffer(4) }, new Set()));
    const result = await syncSource({ bucket, config: makeFakeSource() });
    expect(result.summary?.queued).toBe(1);
  });

  test("fetch executor records failure without failing other work", async () => {
    const bucket = createMemoryBucket();
    const config = makeFakeSource();
    await writeSourceConfig(bucket, config);
    const files = [
      { id: "a", name: "a.m4a", mimeType: "audio/mp4", md5Checksum: "h1", modifiedTime: "2026-01-02T00:00:00.000Z" },
      { id: "b", name: "b.m4a", mimeType: "audio/mp4", md5Checksum: "h2", modifiedTime: "2026-01-02T00:00:00.000Z" },
    ];
    registerSourceDefinition(fakeDefinition(files, { a: new ArrayBuffer(4) }, new Set(["b"])));
    const result = await syncSource({ bucket, config });
    expect(result.summary?.queued).toBe(2);
    expect(await drainSourceFetchWork(bucket)).toBe(2);
    expect((await bucket.list({ prefix: "in/" })).contents?.length).toBe(1);
    const failed = (await bucket.list({ prefix: "work/source-fetch/" })).contents ?? [];
    expect(failed.length).toBeGreaterThan(0);
  });

  test("fetch executor skips work when the source is deleted", async () => {
    const bucket = createMemoryBucket();
    const config = makeFakeSource();
    await writeSourceConfig(bucket, config);
    const files = [{ id: "a", name: "a.m4a", mimeType: "audio/mp4", md5Checksum: "h", modifiedTime: "2026-01-02T00:00:00.000Z" }];
    registerSourceDefinition(fakeDefinition(files, { a: new ArrayBuffer(4) }, new Set()));
    await syncSource({ bucket, config });
    await bucket.delete(`sources/${config.id}.json`);
    expect(await drainSourceFetchWork(bucket)).toBe(1);
    expect((await bucket.list({ prefix: "in/" })).contents?.length ?? 0).toBe(0);
  });

  test("skips disabled sources", async () => {
    const bucket = createMemoryBucket();
    const files = [{ id: "a", name: "a.m4a", mimeType: "audio/mp4", modifiedTime: "2026-01-02T00:00:00.000Z" }];
    registerSourceDefinition(fakeDefinition(files, { a: new ArrayBuffer(4) }, new Set()));
    const result = await syncSource({ bucket, config: makeFakeSource({ enabled: false }) });
    expect(result.synced).toBe(false);
    expect((await bucket.list({ prefix: "in/" })).contents?.length).toBe(0);
  });

  test("records started/finished status and clears lastSyncError on success", async () => {
    const bucket = createMemoryBucket();
    const config = makeFakeSource();
    await writeSourceConfig(bucket, config);
    const files = [{ id: "a", name: "a.m4a", mimeType: "audio/mp4", md5Checksum: "h", modifiedTime: "2026-01-02T00:00:00.000Z" }];
    registerSourceDefinition(fakeDefinition(files, { a: new ArrayBuffer(4) }, new Set()));
    await syncSource({ bucket, config });
    const status = await readSourceStatus(bucket, config.id);
    expect(status.lastSyncStartedAt).toBeTruthy();
    expect(status.lastSyncAt).toBeTruthy();
    expect(status.lastSyncError).toBeNull();
    expect(status.lastSyncSummary?.queued).toBe(1);
  });

  test("records lastSyncError when listing files fails", async () => {
    const bucket = createMemoryBucket();
    const config = makeFakeSource();
    await writeSourceConfig(bucket, config);
    registerSourceDefinition({
      type: "fake",
      validate() {},
      create(cfg: SourceConfig): Source {
        return {
          config: cfg,
          async listFiles(): Promise<SourceFile[]> { throw new Error("drive token expired"); },
          async fetchFile() { throw new Error("unreachable"); },
        };
      },
    });
    await expect(syncSource({ bucket, config })).rejects.toThrow("drive token expired");
    const status = await readSourceStatus(bucket, config.id);
    expect(status.lastSyncError).toBe("drive token expired");
    expect(status.lastSyncStartedAt).toBeTruthy();
    expect(status.lastSyncAt).toBeNull();
  });

  test("creates triage work for each fetched file", async () => {
    const bucket = createMemoryBucket();
    const config = makeFakeSource();
    await writeSourceConfig(bucket, config);
    const files = [{ id: "a", name: "a.m4a", mimeType: "audio/mp4", md5Checksum: "h", modifiedTime: "2026-01-02T00:00:00.000Z" }];
    registerSourceDefinition(fakeDefinition(files, { a: new ArrayBuffer(4) }, new Set()));
    await syncSource({ bucket, config });
    await drainSourceFetchWork(bucket);
    const work = (await bucket.list({ prefix: "work/triage/" })).contents ?? [];
    expect(work.length).toBe(1);
  });
});

describe("syncAllSources", () => {
  test("syncs every enabled source config in the bucket", async () => {
    const bucket = createMemoryBucket();
    await writeSourceConfig(bucket, makeFakeSource({ id: "s1" }));
    await writeSourceConfig(bucket, makeFakeSource({ id: "s2", enabled: false }));
    const files = [{ id: "a", name: "a.m4a", mimeType: "audio/mp4", md5Checksum: "h", modifiedTime: "2026-01-02T00:00:00.000Z" }];
    registerSourceDefinition(fakeDefinition(files, { a: new ArrayBuffer(4) }, new Set()));
    const results = await syncAllSources({ bucket });
    expect(results.length).toBe(1);
    expect(results[0]?.sourceId).toBe("s1");
  });

  test("syncOneSourceById throws for an unknown id", async () => {
    const bucket = createMemoryBucket();
    expect(async () => await syncOneSourceById({ bucket, id: "nope" })).toThrow("No source with id nope.");
  });
});
