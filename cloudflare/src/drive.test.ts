/**
 * Tests for the Drive sources port (src/drive.ts): the key
 * recipes against the server's own functions (imported from
 * lib), the inventory build on hand-computed fixtures, the
 * streaming primitives, and the pass's source flows against
 * fake services — the live parity evidence is the shadow pass
 * itself, run against medina-dev's still-authoritative sources.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  captureBlobName,
  ingestId,
  ingestReceiptKey,
  provenanceKey,
  transcriptKey,
} from "../../lib/lifelog/Resources.ts";
import { sha256Hex } from "./capture.ts";
import {
  DriveApi,
  DriveApiError,
  DriveConfig,
  DriveData,
  DriveNotebook,
  buildDriveInventory,
  driveCaptureBlobKey,
  driveCaptureBlobName,
  driveIngestId,
  driveIngestReceiptKey,
  driveJobReceiptKey,
  driveProvenanceKey,
  driveTranscriptKey,
  putStreamMultipart,
  runDrivePass,
  sha256OfStream,
  type DriveBucketLike,
  type DriveFile,
} from "./drive.ts";
import {
  NormalizeData,
  NormalizeVendor,
  NormalizeVendorError,
} from "./normalize.ts";
import type { S3CredentialsValue } from "./r2creds.ts";

const file = (partial: Partial<DriveFile> & { id: string }): DriveFile => ({
  name: `${partial.id}.m4a`,
  mimeType: "audio/mp4",
  modifiedTime: "2026-09-14T00:00:00.000Z",
  ...partial,
});

describe("key recipes match lib's", () => {
  test("ingest id / receipt key / provenance / transcript / blob name", () => {
    const version = "2026-09-14T02:29:28.724Z";
    expect(driveIngestId("audio-drive", "1-b7gI", version)).toBe(
      ingestId("audio-drive", "1-b7gI", version),
    );
    expect(driveIngestReceiptKey("audio-drive", "1-b7gI", "abc:def")).toBe(
      ingestReceiptKey("audio-drive", "1-b7gI", "abc:def"),
    );
    expect(driveProvenanceKey("cap123")).toBe(provenanceKey("cap123"));
    expect(driveTranscriptKey("ingest-1")).toBe(transcriptKey("ingest-1"));
    expect(driveCaptureBlobName("a/b\\c.m4a")).toBe(
      captureBlobName("a/b\\c.m4a"),
    );
    expect(driveCaptureBlobName("provenance.json")).toBe("_provenance.json");
    expect(driveCaptureBlobKey("cap123", "x.m4a")).toBe(
      "capture/cap123/x.m4a",
    );
  });

  test("the drive job receipt key sanitizes like lib's", () => {
    // lib/capture/TransloaditNormalize.ts transloaditDriveReceiptKey:
    // `ingest/drive-allow-transloadit/${fileId}-${version}` sanitized.
    expect(driveJobReceiptKey("FILE", "2026-01-01T00:00:00.000Z")).toBe(
      "ingest/drive-allow-transloadit/FILE-2026-01-01T000000000Z.json",
    );
  });
});

describe("buildDriveInventory", () => {
  const items: Array<DriveFile> = [
    file({ id: "FA", name: "Recordings", mimeType: "application/vnd.google-apps.folder", parents: [] }),
    file({ id: "FB", name: "2026", mimeType: "application/vnd.google-apps.folder", parents: ["FA"] }),
    file({ id: "F1", name: "a.m4a", parents: ["FB"], size: "10", md5Checksum: "m1" }),
    file({ id: "F2", name: "b.m4a", parents: ["FA"], size: "20" }),
    file({ id: "F3", name: "c.m4a", parents: ["UNKNOWN"], size: "30" }),
    file({ id: "F4", name: "d.m4a", parents: [], size: "40" }),
  ];

  test("paths resolve through the parents graph; orphans sit at the root", () => {
    const inventory = buildDriveInventory(items, "2026-11-09T00:00:00.000Z");
    expect(inventory.fileCount).toBe(4);
    expect(inventory.folderCount).toBe(2);
    expect(inventory.totalBytes).toBe(100);
    const byId = new Map(inventory.entries.map((e) => [e.id, e]));
    expect(byId.get("F1")?.path).toBe("Recordings/2026");
    expect(byId.get("F2")?.path).toBe("Recordings");
    expect(byId.get("F3")?.path).toBe("");
    expect(byId.get("F4")?.path).toBe("");
    expect(byId.get("F1")?.size).toBe(10);
    expect(byId.get("F2")?.md5Checksum).toBeNull();
    // Entries come out sorted by `${path}/${name}` under the
    // server's own comparator (localeCompare) — the same code
    // path, so the order is the server's by construction; assert
    // it is applied consistently.
    const keys = inventory.entries.map((e) => `${e.path}/${e.name}`);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });

  test("same-named folders keep separate identities (the twin case)", () => {
    const twin: Array<DriveFile> = [
      file({ id: "REAL", name: "AudioRec Recordings", mimeType: "application/vnd.google-apps.folder", parents: [] }),
      file({ id: "TWIN", name: "AudioRec Recordings", mimeType: "application/vnd.google-apps.folder", parents: [] }),
      file({ id: "R1", name: "r.wav", parents: ["REAL"], size: "1" }),
      file({ id: "T1", name: "t.wav", parents: ["TWIN"], size: "2" }),
    ];
    const inventory = buildDriveInventory(twin, "2026-11-09T00:00:00.000Z");
    expect(inventory.folderCount).toBe(2);
    expect(inventory.fileCount).toBe(2);
    // Paths are name-based (the server's semantics): both read the
    // same, and identity stays the id.
    expect(
      inventory.entries.filter((e) => e.path === "AudioRec Recordings").length,
    ).toBe(2);
  });
});

describe("streaming primitives", () => {
  const streamOf = (bytes: Uint8Array, chunkSize = 3): ReadableStream =>
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.slice(i, i + chunkSize));
        }
        controller.close();
      },
    });

  test("sha256OfStream hashes chunked bytes", async () => {
    const bytes = new TextEncoder().encode("abc");
    expect(await sha256OfStream(streamOf(bytes))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("putStreamMultipart assembles parts and counts bytes", async () => {
    const parts: Array<{ partNumber: number; size: number }> = [];
    let completed: ReadonlyArray<{ partNumber: number; etag: string }> = [];
    let aborted = false;
    const bucket: DriveBucketLike = {
      head: async () => null,
      get: async () => null,
      put: async () => null,
      list: async () => ({ objects: [], truncated: false }),
      createMultipartUpload: async () => ({
        uploadId: "up-1",
        uploadPart: async (partNumber, value) => {
          parts.push({ partNumber, size: value.byteLength });
          return { etag: `etag-${partNumber}` };
        },
        complete: async (done) => {
          completed = done;
          return {};
        },
        abort: async () => {
          aborted = true;
        },
      }),
    };
    // 8 MiB part + 5 bytes tail, fed in 1 MiB chunks.
    const total = 8 * 1024 * 1024 + 5;
    const bytes = new Uint8Array(total).fill(7);
    const written = await putStreamMultipart(
      bucket,
      "capture/x/blob.m4a",
      streamOf(bytes, 1024 * 1024),
      "application/octet-stream",
    );
    expect(written).toBe(total);
    expect(parts.map((p) => p.size)).toEqual([8 * 1024 * 1024, 5]);
    expect(completed.map((p) => p.partNumber)).toEqual([1, 2]);
    expect(aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pass flows against fakes
// ---------------------------------------------------------------------------

interface FakeWorld {
  readonly texts: Map<string, string>;
  readonly blobs: Map<string, Uint8Array>;
  readonly assemblies: Array<Record<string, unknown>>;
  layer: Layer.Layer<
    DriveApi | DriveData | DriveNotebook | DriveConfig | NormalizeData | NormalizeVendor
  >;
}

const s3: S3CredentialsValue = {
  endpoint: "https://22e64798cbb760891764f349b53f573a.r2.cloudflarestorage.com",
  bucketName: "sco-lifelog",
  region: "auto",
  accessKeyId: "parent-key",
  secretAccessKey: "parent-secret",
};

const fakeWorld = (options: {
  folderFiles: ReadonlyArray<DriveFile>;
  allItems: ReadonlyArray<DriveFile>;
  downloads: ReadonlyMap<string, Uint8Array>;
  texts?: ReadonlyMap<string, string>;
  assemblyResponses?: ReadonlyMap<string, unknown>;
}): FakeWorld => {
  const texts = new Map(options.texts ?? []);
  const blobs = new Map<string, Uint8Array>();
  const assemblies: Array<Record<string, unknown>> = [];
  const streamOfBytes = (bytes: Uint8Array): ReadableStream =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

  const api = Layer.succeed(DriveApi, {
    bindingStates: { email: "ok", privateKey: "ok" },
    configured: true,
    listFolder: () => Effect.succeed(options.folderFiles),
    listAll: Effect.succeed(options.allItems),
    download: (fileId) => {
      const bytes = options.downloads.get(fileId);
      return bytes === undefined
        ? Effect.fail(
            new DriveApiError({
              message: `no such download ${fileId}`,
              cause: null,
            }),
          )
        : Effect.succeed(streamOfBytes(bytes));
    },
    importRequest: (fileId) =>
      Effect.succeed({
        url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        headers: ["Authorization: Bearer test-token"],
      }),
  });

  const data = Layer.succeed(DriveData, {
    exists: (key) =>
      Effect.succeed(texts.has(key) || blobs.has(key)),
    readJson: (key) => {
      const text = texts.get(key);
      if (text === undefined) return Effect.succeed(null);
      try {
        return Effect.succeed(JSON.parse(text) as unknown);
      } catch {
        return Effect.succeed(null);
      }
    },
    readText: (key) => Effect.succeed(texts.get(key) ?? null),
    writeText: (key, text) =>
      Effect.sync(() => {
        texts.set(key, text);
      }),
    head: (key) => {
      const blob = blobs.get(key);
      const text = texts.get(key);
      const size =
        blob?.byteLength ?? (text === undefined ? null : text.length);
      return Effect.succeed(
        size === null ? null : { size, etag: "e", uploaded: null },
      );
    },
    putBlobStream: (key, body) =>
      Effect.promise(async () => {
        const bytes = new Uint8Array(
          await new Response(body).arrayBuffer(),
        );
        blobs.set(key, bytes);
        return bytes.byteLength;
      }),
  });

  const notebook = Layer.succeed(DriveNotebook, {
    record: () => Effect.void,
    latest: Effect.succeed(Option.none()),
    lastInventoryAt: Effect.succeed(null),
    setLastInventoryAt: () => Effect.void,
  });

  const config = Layer.succeed(DriveConfig, {
    folderId: "EVR_FOLDER",
    sourceLatest: 10,
  });

  const vendor = Layer.succeed(NormalizeVendor, {
    configured: true,
    authKey: Effect.succeed("scoped-key"),
    createAssembly: (params) => {
      assemblies.push(params);
      return Effect.succeed({
        assemblyId: `assembly-${assemblies.length}`,
        assemblySslUrl: `https://api2.transloadit.com/assemblies/assembly-${assemblies.length}`,
      });
    },
    getAssembly: (assemblyId) => {
      const response = options.assemblyResponses?.get(assemblyId);
      return response === undefined
        ? Effect.fail(
            new NormalizeVendorError({
              message: `no assembly ${assemblyId}`,
              cause: null,
            }),
          )
        : Effect.succeed(response);
    },
  });

  const normalizeData = Layer.succeed(NormalizeData, {
    captureIds: Effect.succeed([]),
    manifestIds: Effect.succeed([]),
    receiptIds: Effect.succeed([]),
    settledIds: Effect.succeed([]),
    listFiles: () => Effect.succeed([]),
    readText: () => Effect.succeed(null),
    head: () => Effect.succeed(null),
    listChunks: () => Effect.succeed([]),
    rangeReader: (key, size) => ({
      size,
      read: () => Effect.succeed(new Uint8Array(0)),
    }),
    s3Credentials: s3,
  });

  return {
    texts,
    blobs,
    assemblies,
    layer: Layer.mergeAll(api, data, notebook, config, vendor, normalizeData),
  };
};

const runPass = (
  world: FakeWorld,
  overrides: Partial<Parameters<typeof runDrivePass>[0]> = {},
) =>
  Effect.runPromise(
    runDrivePass({
      mode: "manual",
      now: new Date("2026-11-09T12:00:00.000Z"),
      perform: false,
      inventory: "skip",
      ...overrides,
    }).pipe(Effect.provide(world.layer)),
  );

describe("runDrivePass — audio-drive", () => {
  const receipted = file({ id: "DONE1", md5Checksum: "md5done" });
  const skippedFile = file({ id: "DOC1", name: "notes.txt", mimeType: "text/plain", md5Checksum: "md5doc" });
  const freshBytes = new TextEncoder().encode("fresh audio bytes");
  const fresh = file({ id: "NEW1", name: "new.m4a", md5Checksum: "md5new", size: String(freshBytes.byteLength) });

  const world = () =>
    fakeWorld({
      folderFiles: [receipted, skippedFile, fresh],
      allItems: [],
      downloads: new Map([["NEW1", freshBytes]]),
      texts: new Map([
        [
          "ingest/audio-drive/DONE1-md5done.json",
          JSON.stringify({ captureId: "capdone", ingestedAt: "2026-09-14T00:00:00.000Z" }),
        ],
      ]),
    });

  test("shadow: receipted is cached, non-audio skipped, new file would-ingest", async () => {
    const w = world();
    const report = await runPass(w);
    expect(report.audio.discovered).toBe(3);
    expect(report.audio.discoveredIds).toEqual(["DONE1", "DOC1", "NEW1"]);
    expect(report.audio.cached).toBe(1);
    expect(report.audio.skipped).toBe(1);
    expect(report.audio.wouldIngest).toEqual(["new.m4a"]);
    expect(report.audio.ingested).toBe(0);
    expect(w.blobs.size).toBe(0);
  });

  test("live: the new file lands as blob + provenance + receipt under its sha256", async () => {
    const w = world();
    const report = await runPass(w, { perform: true });
    expect(report.audio.ingested).toBe(1);
    const captureId = await sha256Hex(freshBytes);
    expect(w.blobs.has(`capture/${captureId}/new.m4a`)).toBe(true);
    const provenance = JSON.parse(
      w.texts.get(`capture/${captureId}/provenance.json`) ?? "{}",
    ) as { records: Array<{ source: string; fileId: string }> };
    expect(provenance.records[0]?.source).toBe("audio-drive");
    expect(provenance.records[0]?.fileId).toBe("NEW1");
    const receipt = JSON.parse(
      w.texts.get("ingest/audio-drive/NEW1-md5new.json") ?? "{}",
    ) as { captureId: string };
    expect(receipt.captureId).toBe(captureId);
  });

  test("byte check: a receipted file's download hashes to its receipt's capture id", async () => {
    const w = world();
    const report = await runPass(w, { byteCheck: "DONE1" });
    // DONE1 has no fake download, so the check errors rather than
    // matching — the report names it instead of claiming success.
    expect(report.byteCheck).toBeNull();
    expect(report.errors.some((e) => e.item === "byte-check")).toBe(true);
  });
});

describe("runDrivePass — drive-allow", () => {
  const allowFile = file({ id: "ALLOW1", name: "legacy.wav", mimeType: "audio/wav", md5Checksum: "md5allow", size: "100" });
  const cachedFile = file({ id: "ALLOW2", name: "done.wav", mimeType: "audio/wav", md5Checksum: "md5done2" });
  const allowlist = JSON.stringify({
    files: [{ id: "ALLOW1" }, { id: "ALLOW2" }, { id: "GHOST" }],
  });

  const world = (assemblyResponses?: ReadonlyMap<string, unknown>) =>
    fakeWorld({
      folderFiles: [],
      allItems: [allowFile, cachedFile],
      downloads: new Map(),
      texts: new Map([
        ["allow/drive.json", allowlist],
        [
          "ingest/drive-allow/ALLOW2-md5done2.json",
          JSON.stringify({ captureId: "cap-allow2", ingestedAt: "2026-09-09T00:00:00.000Z" }),
        ],
      ]),
      assemblyResponses,
    });

  test("shadow: cached stays cached, the ghost is named missing, the rest would fire an import", async () => {
    const report = await runPass(world());
    expect(report.allow.listed).toBe(3);
    expect(report.allow.cached).toBe(1);
    expect(report.allow.missing).toEqual(["GHOST"]);
    expect(report.allow.wouldIngest).toEqual([
      { id: "ALLOW1", state: "fire-import" },
    ]);
    expect(report.allow.failures.map((f) => f.item)).toEqual(["GHOST"]);
  });

  test("live: firing the import builds the server's assembly (Drive URL + bearer header, store at the capture key)", async () => {
    const w = world();
    const report = await runPass(w, { perform: true });
    expect(report.allow.ingested).toBe(1);
    expect(w.assemblies.length).toBe(1);
    const params = w.assemblies[0] as {
      steps: {
        import: { url: string; headers: Array<string> };
        store_original: { path: string; use: string };
      };
    };
    expect(params.steps.import.url).toBe(
      "https://www.googleapis.com/drive/v3/files/ALLOW1?alt=media",
    );
    expect(params.steps.import.headers).toEqual([
      "Authorization: Bearer test-token",
    ]);
    const captureId = "drive-allow-ALLOW1-md5allow";
    expect(params.steps.store_original.path).toBe(
      `capture/${captureId}/legacy.wav`,
    );
    expect(params.steps.store_original.use).toBe("import");
    const job = JSON.parse(
      w.texts.get("ingest/drive-allow-transloadit/ALLOW1-md5allow.json") ??
        "{}",
    ) as { phase: string; captureId: string };
    expect(job.phase).toBe("import");
    expect(job.captureId).toBe(captureId);
  });
});
