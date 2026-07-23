import { describe, expect, test } from "bun:test";
import { createMemoryBucket } from "./bucket.test";
import {
  createSource,
  deleteSourceConfig,
  fileMatchesExtensions,
  isStale,
  listSourceConfigs,
  listSyncStates,
  migrateLegacyGdriveConnection,
  readSourceConfig,
  readSyncState,
  sourceConfigKey,
  sourceIngestKey,
  sourceProvenance,
  toPublicSourceConfig,
  updateSourceConfig,
  writeSourceStatus,
  writeSourceConfig,
  writeSyncState,
  type SourceConfig,
  type SourceFile,
  type SourceSyncState,
} from "./source";

function makeConfig(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: "src-1",
    type: "filesystem",
    enabled: true,
    extensions: [".m4a"],
    path: "/tmp/audio",
    ...overrides,
  };
}

function makeFile(overrides: Partial<SourceFile> = {}): SourceFile {
  return { id: "talk.m4a", name: "talk.m4a", mimeType: "audio/mp4", md5Checksum: "abc", modifiedTime: "2026-01-01T00:00:00.000Z", ...overrides };
}

describe("source config persistence", () => {
  test("writes and reads a config", async () => {
    const bucket = createMemoryBucket();
    await writeSourceConfig(bucket, makeConfig());
    const read = await readSourceConfig(bucket, "src-1");
    expect(read?.type).toBe("filesystem");
  });

  test("returns null when no config exists", async () => {
    const bucket = createMemoryBucket();
    expect(await readSourceConfig(bucket, "missing")).toBeNull();
  });

  test("listSourceConfigs returns top-level configs only", async () => {
    const bucket = createMemoryBucket();
    await writeSourceConfig(bucket, makeConfig({ id: "a" }));
    await writeSourceConfig(bucket, makeConfig({ id: "b", type: "google-drive", refreshToken: "r", folderId: "f" }));
    const configs = await listSourceConfigs(bucket);
    expect(configs.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  test("deleteSourceConfig removes the config and its sync state", async () => {
    const bucket = createMemoryBucket();
    await writeSourceConfig(bucket, makeConfig());
    await writeSyncState(bucket, "src-1", { fileId: "talk.m4a", modifiedTime: "2026-01-01T00:00:00.000Z", ingestKey: "in/x", ingestedAt: "2026-01-01T00:00:00.000Z" });
    await deleteSourceConfig(bucket, "src-1");
    expect(await bucket.exists(sourceConfigKey("src-1"))).toBe(false);
  });

  test("updateSourceConfig merges a patch without losing other fields", async () => {
    const bucket = createMemoryBucket();
    await writeSourceConfig(bucket, makeConfig());
    const updated = await updateSourceConfig(bucket, "src-1", { extensions: [".mp3"], path: "/new" });
    expect(updated.extensions).toEqual([".mp3"]);
    expect(updated.path).toBe("/new");
    expect(updated.type).toBe("filesystem");
  });

  test("toPublicSourceConfig strips the refresh token and includes status", async () => {
    const bucket = createMemoryBucket();
    const config = makeConfig({ type: "google-drive", refreshToken: "secret" } as SourceConfig & { refreshToken: string });
    await writeSourceStatus(bucket, config.id, {
      lastSyncAt: "2026-01-03T00:00:00.000Z",
      lastSyncSummary: { queued: 1, skipped: 2, errors: 0, finishedAt: "2026-01-03T00:00:00.000Z" },
    });
    const pub = await toPublicSourceConfig(bucket, config);
    expect("refreshToken" in pub).toBe(false);
    expect(pub.lastSyncSummary?.queued).toBe(1);
  });
});

describe("source file filtering and staleness", () => {
  test("fileMatchesExtensions matches configured extensions case-insensitively", () => {
    expect(fileMatchesExtensions("talk.m4a", [".m4a", ".mp3"])).toBe(true);
    expect(fileMatchesExtensions("talk.MP3", [".m4a", ".mp3"])).toBe(true);
    expect(fileMatchesExtensions("notes.txt", [".m4a", ".mp3"])).toBe(false);
  });

  test("fileMatchesExtensions allows everything when extensions is empty", () => {
    expect(fileMatchesExtensions("anything.bin", [])).toBe(true);
  });

  test("isStale is true when no prior state exists", () => {
    expect(isStale(makeFile(), null)).toBe(true);
  });

  test("isStale is false when md5 and modifiedTime match", () => {
    const state: SourceSyncState = { fileId: "talk.m4a", md5Checksum: "abc", modifiedTime: "2026-01-01T00:00:00.000Z", ingestKey: "in/x", ingestedAt: "2026-01-01T00:00:00.000Z" };
    expect(isStale(makeFile(), state)).toBe(false);
  });

  test("isStale is true when md5 changes", () => {
    const state: SourceSyncState = { fileId: "talk.m4a", md5Checksum: "old", modifiedTime: "2026-01-01T00:00:00.000Z", ingestKey: "in/x", ingestedAt: "2026-01-01T00:00:00.000Z" };
    expect(isStale(makeFile({ md5Checksum: "new" }), state)).toBe(true);
  });

  test("isStale is true when modifiedTime changes even without md5", () => {
    const state: SourceSyncState = { fileId: "talk.m4a", modifiedTime: "2026-01-01T00:00:00.000Z", ingestKey: "in/x", ingestedAt: "2026-01-01T00:00:00.000Z" };
    expect(isStale(makeFile({ md5Checksum: undefined, modifiedTime: "2026-02-01T00:00:00.000Z" }), state)).toBe(true);
  });
});

describe("source sync state", () => {
  test("writes and reads sync state keyed by a hash of file id", async () => {
    const bucket = createMemoryBucket();
    await writeSyncState(bucket, "src-1", { fileId: "sub/talk.m4a", modifiedTime: "2026-01-01T00:00:00.000Z", ingestKey: "in/abc", ingestedAt: "2026-01-01T00:00:00.000Z" });
    const state = await readSyncState(bucket, "src-1", "sub/talk.m4a");
    expect(state?.ingestKey).toBe("in/abc");
    expect((await listSyncStates(bucket, "src-1")).get("sub/talk.m4a")?.ingestKey).toBe("in/abc");
  });
});

describe("source ingest identity", () => {
  test("is stable for the same source file version and changes with the version", async () => {
    const file = makeFile();
    expect(await sourceIngestKey("src-1", file)).toBe(await sourceIngestKey("src-1", file));
    expect(await sourceIngestKey("src-1", file)).not.toBe(await sourceIngestKey("src-1", makeFile({ md5Checksum: "new" })));
  });
});

describe("source provenance", () => {
  test("records source type, id, and file id", () => {
    const meta = sourceProvenance(makeConfig({ id: "src-9", type: "filesystem" }), makeFile({ id: "2026/talk.m4a" }));
    expect(meta).toEqual({ source: "filesystem", "source-id": "src-9", "source-file-id": "2026/talk.m4a" });
  });
});

describe("legacy gdrive connection migration", () => {
  test("migrates connections/google-drive.json into a sources/<id>.json and carries sync state", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("connections/google-drive.json", JSON.stringify({
      provider: "google-drive",
      refreshToken: "legacy-refresh",
      scope: "https://www.googleapis.com/auth/drive.readonly",
      account: "me@example.com",
      folderId: "folder-1",
      extensions: [".m4a"],
      connectedAt: "2026-01-01T00:00:00.000Z",
      lastSyncAt: null,
      lastSyncSummary: null,
    }), { type: "application/json" });
    await bucket.write("gdrive-sync/fileA.json", JSON.stringify({
      fileId: "fileA", md5Checksum: "h", modifiedTime: "2026-01-02T00:00:00.000Z", ingestKey: "in/legacy", ingestedAt: "2026-01-02T00:00:00.000Z",
    }), { type: "application/json" });

    const migrated = await migrateLegacyGdriveConnection(bucket);
    expect(migrated?.type).toBe("google-drive");
    expect(migrated?.refreshToken).toBe("legacy-refresh");
    expect(await bucket.exists("connections/google-drive.json")).toBe(false);

    const configs = await listSourceConfigs(bucket);
    expect(configs.length).toBe(1);
    const state = await readSyncState(bucket, migrated!.id, "fileA");
    expect(state?.ingestKey).toBe("in/legacy");
  });

  test("returns null when there is nothing to migrate", async () => {
    const bucket = createMemoryBucket();
    expect(await migrateLegacyGdriveConnection(bucket)).toBeNull();
  });
});
