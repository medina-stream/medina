import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createArtifactResolver } from "../lib/artifact-bun";
import { createMemoryBucket } from "../lib/bucket.test";
import { getIngestRequestKey, type IngestRequestInfo } from "../lib/ingest";
import { getMaterializationReceiptKey, runResource } from "../lib/resource";
import { encodeWorkKeySegment } from "../lib/work-queue";
import { getTriageResultKey, readTriageResult, triageDefinition } from "./triage";

async function writeRequestInfo(bucket: ReturnType<typeof createMemoryBucket>, info: IngestRequestInfo) {
  await bucket.write(getIngestRequestKey(info.ingestKey), `${JSON.stringify(info, null, 2)}\n`, {
    type: "application/json; charset=utf-8",
  });
}

describe("triageDefinition", () => {
  test("writes triage/<encoded>.json and a normal resource receipt", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/audio-test", new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
      type: "application/octet-stream",
    });

    const run = await runResource(triageDefinition, {
      bucket,
      inputKey: "in/audio-test",
      now: new Date("2026-07-17T10:00:00.000Z"),
    });
    const triageKey = `triage/${encodeWorkKeySegment("in/audio-test")}.json`;

    expect(run.outputs).toEqual([triageKey]);
    expect(await bucket.readJson(triageKey)).toMatchObject({
      content: {
        kind: "audio",
      },
      disposition: "dispatch",
      ingestKey: "in/audio-test",
      version: 1,
    });
    expect(await bucket.readJson(getMaterializationReceiptKey(triageKey))).toMatchObject({
      definition: {
        name: "triage",
        version: "2",
      },
      materializedAt: "2026-07-17T10:00:00.000Z",
      resourceKey: triageKey,
    });
  });

  test("persists resolver-provided artifact integrity", async () => {
    const bucket = createMemoryBucket();
    const cacheDir = await mkdtemp(join(tmpdir(), "medina-triage-artifact-test-"));
    try {
      const artifacts = createArtifactResolver({ bucket, cacheDir, workerId: "test" });
      await artifacts.publish({
        contentType: "audio/mpeg",
        key: "in/artifact-audio",
        source: { kind: "stream", stream: new Blob([new Uint8Array([0x49, 0x44, 0x33])]).stream() },
      });
      await runResource(triageDefinition, { artifacts, bucket, inputKey: "in/artifact-audio" });

      expect(await readTriageResult(bucket, "in/artifact-audio")).toMatchObject({
        artifact: { integrity: { algorithm: "sha256", digest: expect.any(String) } },
      });
    } finally {
      await rm(cacheDir, { force: true, recursive: true });
    }
  });

  test("uses request info as authoritative metadata and request time", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/request-backed", "not used for gps parsing", {
      metadata: {
        "created-at": "2026-07-01T00:00:00.000Z",
        "original-filename": "ignored.txt",
      },
    });
    await writeRequestInfo(bucket, {
      ingestKey: "in/request-backed",
      metadata: {
        "created-at": "2026-07-16T11:12:13.000Z",
        "original-filename": "voice-note.m4a",
      },
      requestedAt: "2026-07-16T11:15:00.000Z",
      type: "audio/mpeg",
    });

    await runResource(triageDefinition, {
      bucket,
      inputKey: "in/request-backed",
      now: new Date("2026-07-17T10:05:00.000Z"),
    });

    expect(await readTriageResult(bucket, "in/request-backed")).toMatchObject({
      artifact: {
        contentType: "audio/mpeg",
        createdAt: "2026-07-16T11:15:00.000Z",
        key: "in/request-backed",
      },
      content: {
        contentType: "audio/mpeg",
        eventTime: "2026-07-16T11:12:13.000Z",
        kind: "audio",
      },
      disposition: "dispatch",
    });
  });

  test("dispatches GPS points and keeps parsed event info", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/gps-point", "lat=37.1&lon=-122.2&time=2026-06-25T12%3A34%3A56Z&s=1.5", {
      type: "application/octet-stream",
    });

    await runResource(triageDefinition, {
      bucket,
      inputKey: "in/gps-point",
      now: new Date("2026-07-17T10:10:00.000Z"),
    });

    expect(await readTriageResult(bucket, "in/gps-point")).toMatchObject({
      content: {
        eventTime: "2026-06-25T12:34:56.000Z",
        facts: {
          latitude: 37.1,
          longitude: -122.2,
          speed: 1.5,
        },
        kind: "location-point",
      },
      disposition: "dispatch",
      labels: expect.arrayContaining(["gps"]),
      policy: {
        reasons: ["gps-hour-dispatch"],
      },
    });
  });

  test("sniffs large octet-stream prefixes without reading the whole object", async () => {
    const bucket = createMemoryBucket();
    const body = new Uint8Array(128 * 1024);
    body.set([0x49, 0x44, 0x33, 0x04]);
    await bucket.write("in/large-audio", body, { type: "application/octet-stream" });

    await runResource(triageDefinition, {
      bucket,
      inputKey: "in/large-audio",
      now: new Date("2026-07-17T10:12:00.000Z"),
    });

    expect(await readTriageResult(bucket, "in/large-audio")).toMatchObject({
      content: { kind: "audio" },
      disposition: "dispatch",
    });
  });

  test("retains unknown payloads without deleting them", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/unknown", new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
      type: "application/octet-stream",
    });

    await runResource(triageDefinition, {
      bucket,
      inputKey: "in/unknown",
      now: new Date("2026-07-17T10:15:00.000Z"),
    });

    expect(await readTriageResult(bucket, "in/unknown")).toMatchObject({
      content: {
        kind: "unknown",
      },
      disposition: "retain",
    });
    expect(await bucket.exists("in/unknown")).toBe(true);
  });

  test("re-triages when request info arrives later because it is a dependency", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/later-request", new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
      type: "application/octet-stream",
    });

    const first = await runResource(triageDefinition, {
      bucket,
      inputKey: "in/later-request",
      now: new Date("2026-07-17T10:20:00.000Z"),
    });
    await writeRequestInfo(bucket, {
      ingestKey: "in/later-request",
      metadata: {
        "created-at": "2026-07-17T09:59:00.000Z",
        "original-filename": "later.mp3",
      },
      requestedAt: "2026-07-17T10:19:00.000Z",
      type: "audio/mpeg",
    });
    const second = await runResource(triageDefinition, {
      bucket,
      inputKey: "in/later-request",
      now: new Date("2026-07-17T10:21:00.000Z"),
    });

    expect(first.materialized).toBe(true);
    expect(second.materialized).toBe(true);
    expect(await readTriageResult(bucket, getTriageResultKey("in/later-request"))).toMatchObject({
      content: {
        contentType: "audio/mpeg",
        eventTime: "2026-07-17T09:59:00.000Z",
        kind: "audio",
      },
      disposition: "dispatch",
    });
  });
});
