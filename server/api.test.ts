import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { artifactRefKey } from "../lib/artifact";
import { createMemoryBucket } from "../lib/bucket.test";
import type { Bucket } from "../lib/bucket";
import { createMaterializationReceipt } from "../lib/resource";
import { createGpsHour, getGpsHourKey } from "../resources/gps-hour";
import { triageWorkItemKey } from "../resources/triage-work";
import * as streamBucket from "./stream-bucket";
import type { Stream } from "#lib/stream";

const originalEnv = { ...process.env };
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "medina-api-db-"));
process.env.S3_BUCKET = "test-import-bucket";
process.env.S3_ENDPOINT = "https://storage.example";
process.env.S3_REGION = "auto";
process.env.MEDINA_ROOT = "http://localhost";
process.env.MEDINA_TOKEN = "secret";
const testDataDir = process.env.DATA_DIR;
const testEnv = {
  ...originalEnv,
  DATA_DIR: testDataDir,
  MEDINA_ROOT: "http://localhost",
  MEDINA_TOKEN: "secret",
  S3_BUCKET: "test-bucket",
  S3_ENDPOINT: "https://storage.example",
  S3_REGION: "auto",
};
const { default: app, streams: appStreams } = await import("./api");
appStreams[0]!.name = "Test stream";

const testUser = { username: "default", profile_pic_url: "/default-profile.jpg", credentials: [], tokens: [{ token: "secret" }] };

function useSingleLocalStream(bucket: Bucket) {
  return spyOn(streamBucket, "getBucketForStream").mockReturnValue(bucket);
}

function makeSummary(scope: "all" | "ingest" = "ingest") {
  return {
    chunks: { deleted: 0, fresh: 0, materialized: 0, total: 0, wouldDelete: 0, wouldMaterialize: 0 },
    durationMs: 0,
    finishedAt: "2026-05-15T00:00:00.000Z",
    ingests: { fresh: 0, materialized: 0, total: 0, wouldMaterialize: 0 },
    intervals: { fresh: 0, ids: [], materialized: 0, materializedIds: [], total: 0, wouldMaterialize: 0 },
    recordings: { fresh: 0, materialized: 0, skipped: [], total: 0, wouldMaterialize: 0 },
    scope,
    shard: { count: 1, index: 0 },
    startedAt: "2026-05-15T00:00:00.000Z",
  };
}

describe("interval and recording asset routes", () => {
  let bucketRoot = "";
  let bucket: Bucket;
  let bucketSpy: ReturnType<typeof useSingleLocalStream>;

  beforeEach(() => {
    process.env = { ...testEnv };
    bucketRoot = mkdtempSync(join(tmpdir(), "medina-api-"));
    bucket = createMemoryBucket();
    bucketSpy = useSingleLocalStream(bucket);
  });

  afterEach(() => {
    bucketSpy.mockRestore();
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
    rmSync(bucketRoot, { force: true, recursive: true });
  });

  test("serves a materialized interval object from the bucket root path", async () => {
    await bucket.write("intervals/020260515.json", `${JSON.stringify({
      coverageSeconds: 60,
      durationSeconds: 86400,
      endTime: "2026-05-16T00:00:00.000Z",
      id: "020260515",
      key: "intervals/020260515.json",
      length: "P1D",
      recordings: [],
      startTime: "2026-05-15T00:00:00.000Z",
    }, null, 2)}\n`, { type: "application/json; charset=utf-8" });

    const response = await app.request("http://localhost/020260515.json", { headers: { Authorization: "Bearer secret" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ id: "020260515", length: "P1D" });
  });

  test("materializes a missing day interval on first request using the selected bucket", async () => {
    const response = await app.request("http://localhost/020260515.json", { headers: { Authorization: "Bearer secret" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      coverageSeconds: 0,
      durationSeconds: 86400,
      id: "020260515",
      length: "P1D",
    });
    expect(await bucket.exists("intervals/020260515.json")).toBe(true);
  });

  test("serves an empty markdown summary for a missing future interval", async () => {
    const response = await app.request("http://localhost/020990101.md", { headers: { Authorization: "Bearer secret" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    const text = await response.text();
    expect(text).toContain("# Interval 020990101");
    expect(text).toContain("No data.");
    expect(await bucket.exists("intervals/020990101.json")).toBe(true);
  });

  test("serves gps json for a day resource", async () => {
    process.env.MEDINA_GPS_SUMMARY_MODE = "off";
    await bucket.write(getGpsHourKey("02026072215"), `${JSON.stringify(createGpsHour("02026072215", [
      { ingestKey: "in/gps-1", latitude: 37.8, longitude: -122.44, speed: 0, time: "2026-07-22T15:00:00.000Z", timeZone: "America/Los_Angeles" },
      { ingestKey: "in/gps-2", latitude: 37.8001, longitude: -122.4401, speed: 0, time: "2026-07-22T15:20:00.000Z", timeZone: "America/Los_Angeles" },
    ]), null, 2)}\n`, {
      type: "application/json; charset=utf-8",
    });

    const response = await app.request("http://localhost/020260722/gps.json", { headers: { Authorization: "Bearer secret" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.json()).toMatchObject({
      dayId: "020260722",
      dominantTimeZone: "America/Los_Angeles",
      rawCount: 2,
    });
  });

  test("serves day transcripts directly from their materialized object", async () => {
    await bucket.write("transcripts/020260515.json", `${JSON.stringify([
      {
        chunkId: "0202605150950",
        chunkKey: "chunks/0202605150950/recording-1.ogg",
        createdAt: "2026-05-15T10:00:00.000Z",
        endTime: "2026-05-15T10:00:00.000Z",
        model: "test-model",
        provider: "deepgram",
        recordingId: "recording-1",
        response: {},
        startTime: "2026-05-15T09:50:00.000Z",
        text: "direct day transcript",
        transcriptKey: "chunks/0202605150950/recording-1/transcript.json",
      },
    ], null, 2)}\n`, { type: "application/json; charset=utf-8" });

    const response = await app.request("http://localhost/transcripts/020260515.json", { headers: { Authorization: "Bearer secret" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject([{ text: "direct day transcript" }]);
    expect(response.headers.get("cache-control")).toContain("max-age=86400");
  });

  test("open days are served without long caching", async () => {
    const dayId = `0${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
    const response = await app.request(`http://localhost/transcripts/${dayId}.json`, { headers: { Authorization: "Bearer secret" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  test("materializes missing day transcript objects on demand", async () => {
    await bucket.write("chunks/0202605161010/recording-2/transcript.json", JSON.stringify({
      chunkId: "0202605161010",
      chunkKey: "chunks/0202605161010/recording-2.ogg",
      endTime: "2026-05-16T10:20:00.000Z",
      startTime: "2026-05-16T10:10:00.000Z",
      text: "materialized on demand",
      transcriptKey: "chunks/0202605161010/recording-2/transcript.json",
    }), { type: "application/json" });

    const response = await app.request("http://localhost/transcripts/020260516.json", { headers: { Authorization: "Bearer secret" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ text: "materialized on demand" }]);
    expect(await bucket.exists("transcripts/020260516.json")).toBe(true);
  });

  test("serves legacy manifest-scoped recording chunk paths", async () => {
    await bucket.write("recordings/recording-1/manifest/chunk-004.ogg", "audio-data", { type: "audio/ogg" });

    const response = await app.request("http://localhost/recordings/recording-1/manifest/chunk-004.ogg", { headers: { Authorization: "Bearer secret" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/ogg");
    expect(await response.text()).toBe("audio-data");
  });

  test("serves chunk audio by chunk id", async () => {
    await bucket.write("chunks/0202605151200/recording-1.ogg", "chunk-audio", { type: "audio/ogg" });

    const response = await app.request("http://localhost/chunks/0202605151200/recording-1.ogg", { headers: { Authorization: "Bearer secret" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/ogg");
    expect(await response.text()).toBe("chunk-audio");
  });

  test("serves web app manifest for a configured stream", async () => {
    const response = await app.request("http://localhost/manifest.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.json()).toMatchObject({
      id: "/",
      name: "Test stream",
      short_name: "Test stream",
      orientation: "portrait-primary",
      start_url: "http://localhost/app",
      icons: [
        { src: "/icon.svg", type: "image/svg+xml", purpose: "any" },
        { src: "/icon-monochrome.svg", type: "image/svg+xml", purpose: "monochrome" },
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    });
  });

  test("serves app icons from the mounted image resource without auth", async () => {
    const svgResponse = await app.request("http://localhost/icon.svg");
    expect(svgResponse.status).toBe(200);
    expect(svgResponse.headers.get("content-type")).toContain("image/svg+xml");
    expect(await svgResponse.text()).toContain("aria-label=\"Medina\"");
    expect(await bucket.exists("app-icon/icon.svg")).toBe(true);

    const pngResponse = await app.request("http://localhost/icon-192.png");
    expect(pngResponse.status).toBe(200);
    expect(pngResponse.headers.get("content-type")).toContain("image/png");
    expect(await bucket.exists("app-icon/icon-192.png")).toBe(true);

    const maskableResponse = await app.request("http://localhost/icon-maskable-512.png");
    expect(maskableResponse.status).toBe(200);
    expect(await bucket.exists("app-icon/icon-maskable-512.png")).toBe(true);

    const touchResponse = await app.request("http://localhost/apple-touch-icon.png");
    expect(touchResponse.status).toBe(200);
    expect(await bucket.exists("app-icon/apple-touch-icon.png")).toBe(true);
  });

  test("does not expose undeclared image resource paths without auth", async () => {
    const response = await app.request("http://localhost/icon-secret.png");
    expect(response.status).toBe(401);
  });

  test("serves podcast feed xml", async () => {
    const manifest = {
      analysisKey: "02026/05/15/ingests/in/test.json",
      chunkDurationSeconds: 1800,
      chunkFormats: {
        ogg: {
          chunks: [
            { contentType: "audio/ogg", durationSeconds: 600, format: "ogg", key: "chunks/0202605151200/recording-1.ogg", ordinal: 0 },
            { contentType: "audio/ogg", durationSeconds: 600, format: "ogg", key: "chunks/0202605151210/recording-1.ogg", ordinal: 1 },
          ],
          format: "ogg",
        },
      },
      estimatedStart: "2026-05-15T12:00:00.000Z",
      ingestKey: "in/test",
      metadata: {},
      probe: { durationSeconds: 1200 },
      recordedAt: "2026-05-15T12:00:00.000Z",
      recordingId: "recording-1",
      startTimeEstimate: {
        confidence: 1,
        estimatedAt: "2026-05-15T12:00:00.000Z",
        explanation: "test",
        precision: "second",
        source: "metadata:recording-started-at",
        upperBound: "2026-05-15T12:00:00.000Z",
      },
      type: "audio/m4a",
    };

    await bucket.write("medina.conf", `${JSON.stringify({ name: "Field Notes" }, null, 2)}\n`, {
      type: "application/json; charset=utf-8",
    });
    await bucket.write("recordings/recording-1/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, {
      type: "application/json; charset=utf-8",
    });
    await bucket.write("chunks/0202605151200/recording-1.ogg", "first-chunk", { type: "audio/ogg" });
    await bucket.write("chunks/0202605151210/recording-1.ogg", "last-chunk", { type: "audio/ogg" });
    await bucket.write("podcast/episodes/recording-1.ogg", "episode-audio", { type: "audio/ogg" });
    await bucket.write(
      "resource-receipts/podcast/episodes/recording-1.ogg.receipt.json",
      `${JSON.stringify(createMaterializationReceipt({
        definition: { name: "podcast-episodes", version: "1" },
        dependencies: [],
        resourceKey: "podcast/episodes/recording-1.ogg",
      }), null, 2)}\n`,
      { type: "application/json; charset=utf-8" },
    );

    const response = await app.request("http://localhost/podcast.xml", { headers: { Authorization: "Bearer secret" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/rss+xml");
    const text = await response.text();
    expect(text).toContain("<rss");
    expect(text).toContain("<title>Field Notes podcast</title>");
    expect(text).toContain("podcast/episodes/recording-1.ogg");
    expect(text).toContain("May 15, 2026");
  });
});

describe("event ingestion routes", () => {
  let bucketRoot = "";
  let bucket: Bucket;
  let bucketSpy: ReturnType<typeof useSingleLocalStream>;

  beforeEach(() => {
    process.env = { ...testEnv };
    bucketRoot = mkdtempSync(join(tmpdir(), "medina-events-api-"));
    bucket = createMemoryBucket();
    bucketSpy = useSingleLocalStream(bucket);
  });

  afterEach(() => {
    bucketSpy.mockRestore();
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
    rmSync(bucketRoot, { force: true, recursive: true });
  });

  test("creates triage work for ingest-uploaded events with ingest keys", async () => {
    const ensureWork = spyOn(await import("../resources/triage-work"), "ensureTriageWork").mockResolvedValue(null);

    const response = await app.request("http://localhost/events", {
      body: JSON.stringify({ type: "ingest-uploaded", ingestId: "test-key" }),
      headers: { "content-type": "application/json", Authorization: "Bearer secret" },
      method: "POST",
    });
    await Bun.sleep(0);

    expect(response.status).toBe(200);
    expect(ensureWork).toHaveBeenCalledWith(expect.objectContaining({ ingestKey: "in/test-key" }));
    ensureWork.mockRestore();
  });

  test("does not create triage work for ingest-uploaded events without ingest keys", async () => {
    const ensureWork = spyOn(await import("../resources/triage-work"), "ensureTriageWork").mockResolvedValue(null);

    const response = await app.request("http://localhost/events", {
      body: JSON.stringify({ type: "ingest-uploaded", filename: "missing-key.wav" }),
      headers: { "content-type": "application/json", Authorization: "Bearer secret" },
      method: "POST",
    });
    await Bun.sleep(0);

    expect(response.status).toBe(200);
    expect(ensureWork).not.toHaveBeenCalled();
    ensureWork.mockRestore();
  });

  test("events history endpoint returns persisted events", async () => {
    const type = `history-test-${crypto.randomUUID()}`;
    const post = await app.request("http://localhost/events", {
      body: JSON.stringify({ type, marker: "persisted" }),
      headers: { "content-type": "application/json", Authorization: "Bearer secret" },
      method: "POST",
    });
    expect(post.status).toBe(200);

    const response = await app.request("http://localhost/events.json?limit=20", { headers: { Authorization: "Bearer secret" } });
    expect(response.status).toBe(200);
    const events = await response.json() as Array<{ data?: Record<string, unknown> }>;
    expect(events.some((event) => event.data?.type === type && event.data?.marker === "persisted")).toBe(true);
  });

  test("POST /events stores ingest-uploaded event and creates triage work", async () => {
    const ensureWork = spyOn(await import("../resources/triage-work"), "ensureTriageWork").mockResolvedValue(null);
    const ingestId = `success-${crypto.randomUUID()}`;

    const response = await app.request("http://localhost/events", {
      body: JSON.stringify({ type: "ingest-uploaded", ingestId }),
      headers: { "content-type": "application/json", Authorization: "Bearer secret" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const posted = await response.json() as { eventId: string };

    expect(ensureWork).toHaveBeenCalledWith(expect.objectContaining({ ingestKey: `in/${ingestId}` }));

    const history = await app.request("http://localhost/events.json?limit=50", { headers: { Authorization: "Bearer secret" } });
    const events = await history.json() as Array<{ data?: Record<string, unknown> }>;

    expect(events.some((event) => event.data?.type === "ingest-uploaded")).toBe(true);
    ensureWork.mockRestore();
  });
});

describe("ingest form routes", () => {
  let bucketRoot = "";
  let bucket: Bucket;
  let bucketSpy: ReturnType<typeof useSingleLocalStream>;

  beforeEach(() => {
    process.env = { ...testEnv };
    bucketRoot = mkdtempSync(join(tmpdir(), "medina-ingest-api-"));
    bucket = createMemoryBucket();
    bucketSpy = useSingleLocalStream(bucket);
  });

  afterEach(() => {
    bucketSpy.mockRestore();
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
    rmSync(bucketRoot, { force: true, recursive: true });
  });

  test("returns upload headers needed to preserve ingest metadata", async () => {
    const response = await app.request("http://localhost/in", {
      body: JSON.stringify({
        metadata: {
          "created-at": "2026-05-15T14:00:00.000Z",
          "original-filename": "clip.m4a",
          "sdk-version": "medina-sdk/test",
        },
        type: "audio/m4a",
      }),
      headers: { "content-type": "application/json", Authorization: "Bearer secret" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: expect.stringContaining("/in/"),
      headers: {
        "Content-Type": "audio/m4a",
        "x-amz-meta-created-at": "2026-05-15T14:00:00.000Z",
        "x-amz-meta-original-filename": "clip.m4a",
        "x-amz-meta-sdk-version": "medina-sdk/test",
        "x-medina-ingest-key": expect.stringContaining("in/"),
      },
      method: "PUT",
    });
  });

  test("stores arbitrary POST bodies to /in without Medina metadata", async () => {
    const response = await app.request("http://localhost/in", {
      body: "lat=37.1&lon=-122.2&time=2026-06-25T12%3A34%3A56Z&s=1.5",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Authorization: "Bearer secret",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const stored = await response.json() as { key: string; metadata: Record<string, string> };
    expect(stored.key).toStartWith("in/");
    expect(stored.metadata).toEqual({});
    expect(await bucket.readText(stored.key)).toBe("lat=37.1&lon=-122.2&time=2026-06-25T12%3A34%3A56Z&s=1.5");
    expect((await bucket.list({ prefix: "gps-logs/" })).contents).toHaveLength(0);
    expect(await bucket.exists(artifactRefKey(stored.key))).toBe(true);
    expect(await bucket.exists(triageWorkItemKey(stored.key))).toBe(true);
  });

  test("stores arbitrary JSON POST bodies to /in when they are not destination requests", async () => {
    const response = await app.request("http://localhost/in", {
      body: JSON.stringify({ lat: 37.1, lon: -122.2, time: "2026-06-25T12:34:56Z" }),
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer secret",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const stored = await response.json() as { key: string; metadata: Record<string, string> };
    expect(stored.key).toStartWith("in/");
    expect(await bucket.readJson(stored.key)).toEqual({ lat: 37.1, lon: -122.2, time: "2026-06-25T12:34:56Z" });
  });

  test("stores metadata on PUT /in/:ingestId uploads", async () => {
    const response = await app.request("http://localhost/in/test-key", {
      body: "hello world",
      headers: {
        "content-type": "audio/mpeg",
        Authorization: "Bearer secret",
        "x-amz-meta-created-at": "2026-05-15T14:00:00.000Z",
        "x-amz-meta-original-filename": "clip.mp3",
        "x-amz-meta-sdk-version": "medina-sdk/test",
      },
      method: "PUT",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ingestId: "test-key",
      key: "in/test-key",
      metadata: {
        "created-at": "2026-05-15T14:00:00.000Z",
        "original-filename": "clip.mp3",
        "sdk-version": "medina-sdk/test",
      },
    });
    expect(await bucket.exists("in/test-key")).toBe(true);
    expect(await bucket.exists("ingest-requests/in/test-key.json")).toBe(true);
  });
});

describe("stream-aware status and auth", () => {
  test("reports the request-selected stream bucket identity", async () => {
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
    const apiModuleUrl = new URL(`./api.ts?status-test=${Date.now()}`, import.meta.url).href;
    const module = await import(apiModuleUrl);
    module.streams.splice(0, module.streams.length, {
      buckets: { default: { bucketName: "medina-local-demo", endpoint: "https://local.storage.dev", region: "auto" } },
      host: "localhost",
      users: [testUser],
    });

    const status = await module.default.request("https://localhost/status.json");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      bucket_id: "s3://medina-local-demo@local.storage.dev/auto",
      hostname: "localhost",
    });
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
  });

  test("reports a status user from Tailscale identity headers", async () => {
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
    const apiModuleUrl = new URL(`./api.ts?status-user-test=${Date.now()}-${Math.random()}`, import.meta.url).href;
    const module = await import(apiModuleUrl);
    module.streams.splice(0, module.streams.length, {
      buckets: { default: { bucketName: "users", endpoint: "https://storage.example", region: "auto" } },
      host: "localhost",
      users: [testUser],
    });

    const response = await module.default.request("https://localhost/status.json", {
      headers: {
        "Tailscale-User-Login": "ScottRaymond@Example.com",
        "Tailscale-User-Name": "Scott Raymond",
        "Tailscale-User-Profile-Pic": "https://example.com/scott.jpg",
      },
    });

    expect(response.status).toBe(200);
    const status = await response.json() as { current_user: Record<string, unknown> };
    expect(status).toMatchObject({
      current_user: {
        auth_method: "tailscale",
        credentials: [{ type: "tailscale", value: "ScottRaymond@Example.com" }],
        profile_pic_url: "https://example.com/scott.jpg",
        username: "Scott Raymond",
      },
    });
    expect(status.current_user).not.toHaveProperty("tokens");
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
  });

  test("reports the default user when the token is sent with Basic auth", async () => {
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
    const apiModuleUrl = new URL(`./api.ts?status-basic-user-test=${Date.now()}-${Math.random()}`, import.meta.url).href;
    const module = await import(apiModuleUrl);
    module.streams.splice(0, module.streams.length, {
      buckets: { default: { url: "https://storage.example/users/auto" } },
      host: "localhost",
      users: [testUser],
    });

    const response = await module.default.request("https://localhost/status.json", {
      headers: {
        Authorization: `Basic ${btoa("default:secret")}`,
      },
    });

    expect(response.status).toBe(200);
    const status = await response.json() as { current_user: Record<string, unknown> };
    expect(status).toMatchObject({
      current_user: {
        auth_method: "token",
        username: "default",
      },
    });
    expect(status.current_user).not.toHaveProperty("tokens");
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
  });

  test("unknown hosts are rejected", async () => {
    const apiModuleUrl = new URL(`./api.ts?multi-auth-test=${Date.now()}`, import.meta.url).href;
    const module = await import(apiModuleUrl);
    const streamA: Stream = { buckets: { default: { bucketName: "a", endpoint: "https://storage.example", region: "auto" } }, users: [testUser], host: "a.example" };
    const streamB: Stream = { buckets: { default: { bucketName: "b", endpoint: "https://storage.example", region: "auto" } }, users: [testUser], host: "b.example" };
    module.streams.splice(0, module.streams.length, streamA, streamB);
    

    const unknown = await module.default.request("https://unknown.example/status.json");
    const protectedMissing = await module.default.request("https://b.example/recordings.json");
    const protectedOk = await module.default.request("https://b.example/status.json", { headers: { Authorization: "Bearer secret" } });

    expect(unknown.status).toBe(404);
    expect(protectedMissing.status).toBe(401);
    expect(protectedOk.status).toBe(200);
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
  });

  test("serves api docs without token on protected streams", async () => {
    const apiModuleUrl = new URL(`./api.ts?api-docs-test=${Date.now()}`, import.meta.url).href;
    const module = await import(apiModuleUrl);
    module.streams.splice(0, module.streams.length, {
      buckets: { default: { bucketName: "docs", endpoint: "https://storage.example", region: "auto" } },
      host: "docs.example",
      users: [testUser],
    });
    const docs = await module.default.request("https://docs.example/api.md");
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/markdown");
    const text = await docs.text();
    expect(text).toContain("# Medina HTTP API");
    expect(text).toContain("GET /recordings.json");
    expect(text).toContain("GET /speakers.json");
    expect(text).toContain("Software-defined resources");

    const protectedMissing = await module.default.request("https://docs.example/recordings.json");
    expect(protectedMissing.status).toBe(401);
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
  });


  test("serves canonical agent guide and redirects guessed paths", async () => {
    const apiModuleUrl = new URL(`./api.ts?agent-docs-test=${Date.now()}`, import.meta.url).href;
    const module = await import(apiModuleUrl);
    module.streams.splice(0, module.streams.length, {
      buckets: { default: { bucketName: "agent-docs", endpoint: "https://storage.example", region: "auto" } },
      host: "agents.example",
      users: [testUser],
    });
    const guide = await module.default.request("https://agents.example/agents.md");
    expect(guide.status).toBe(200);
    const text = await guide.text();
    expect(text).toContain("Recommended integration strategies");
    expect(text).toContain("MEDINA_TOKEN");
    expect(text).toContain("curl -fsSL");

    for (const path of ["/agent", "/agent.md", "/skill", "/skill.md", "/SKILL.md"]) {
      const response = await module.default.request(`https://agents.example${path}`, { redirect: "manual" });
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("/agents.md");
    }

    for (const path of ["/api", "/API", "/API.md", "/docs"]) {
      const response = await module.default.request(`https://agents.example${path}`, { redirect: "manual" });
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("/api.md");
    }
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
  });


  test("home.json is not an API endpoint", async () => {
    const apiModuleUrl = new URL(`./api.ts?home-json-test=${Date.now()}`, import.meta.url).href;
    const module = await import(apiModuleUrl);
    module.streams.splice(0, module.streams.length, {
      buckets: { default: { bucketName: "home-json", endpoint: "https://storage.example", region: "auto" } },
      host: "home.example",
      users: [testUser],
    });
    const response = await module.default.request("https://home.example/home.json");
    expect(response.status).toBe(404);
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
  });

});

describe("source routes", () => {
  let bucket: Bucket;
  let bucketSpy: ReturnType<typeof useSingleLocalStream>;

  beforeEach(() => {
    process.env = { ...testEnv, GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "secret-google" };
    appStreams.splice(0, appStreams.length, {
      buckets: { default: { bucketName: "test-bucket", endpoint: "https://storage.example", region: "auto" } },
      host: "localhost",
      users: [testUser],
    });
    bucket = createMemoryBucket();
    bucketSpy = useSingleLocalStream(bucket);
  });

  afterEach(() => {
    bucketSpy.mockRestore();
    process.env = { ...originalEnv, DATA_DIR: testDataDir };
  });

  test("GET /sources.json returns an empty list when no sources exist", async () => {
    const response = await app.request("http://localhost/sources.json", { headers: { Authorization: "Bearer secret" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sources: [] });
  });

  test("GET /sources.json requires authentication", async () => {
    const response = await app.request("http://localhost/sources.json");
    expect(response.status).toBe(401);
  });

  test("POST /sources is not a public source configuration API", async () => {
    const response = await app.request("http://localhost/sources", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify({ type: "filesystem", path: "/tmp/audio" }),
    });
    expect(response.status).toBe(404);
  });

  test("DELETE /sources/:id removes the source", async () => {
    const { createSource } = await import("../lib/source");
    await createSource(bucket, { id: "src-x", type: "filesystem", enabled: true, extensions: [".m4a"], path: "/tmp/x" });
    const response = await app.request("http://localhost/sources/src-x", {
      method: "DELETE",
      headers: { Authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    expect(await bucket.exists("sources/src-x.json")).toBe(false);
  });

  test("PUT /sources/:id leaves instance-managed filesystem sources read-only", async () => {
    const { createSource } = await import("../lib/source");
    await createSource(bucket, { id: "src-x", type: "filesystem", enabled: true, extensions: [".m4a"], path: "/tmp/x" });
    const response = await app.request("http://localhost/sources/src-x", {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify({ path: "/tmp/y" }),
    });
    expect(response.status).toBe(403);
    expect((await bucket.readJson<{ path: string }>("sources/src-x.json")).path).toBe("/tmp/x");
  });

  test("POST /sources/:id/sync returns 404 for unknown source and 502 when listing fails", async () => {
    const missing = await app.request("http://localhost/sources/nope/sync", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    });
    expect(missing.status).toBe(404);

    const { createSource } = await import("../lib/source");
    await createSource(bucket, { id: "gd-sync", type: "google-drive", enabled: true, extensions: [], refreshToken: "bad-token", folderId: "f" });
    const response = await app.request("http://localhost/sources/gd-sync/sync", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    });
    expect(response.status).toBe(502);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("sync_failed");
    const status = await bucket.readJson<{ lastSyncError: string | null }>("sources/gd-sync/status.json");
    expect(status.lastSyncError).toBeTruthy();
  });

  test("GET /connect/google without params starts a fresh connection", async () => {
    const response = await app.request("http://localhost/connect/google", {
      headers: { Authorization: "Bearer secret" },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect((response.headers.get("location") ?? "").startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
  });

  test("GET /connect/google with sourceId requires an existing google-drive source", async () => {
    const missing = await app.request("http://localhost/connect/google?sourceId=nope", {
      headers: { Authorization: "Bearer secret" },
      redirect: "manual",
    });
    expect(missing.status).toBe(404);

    const { createSource } = await import("../lib/source");
    await createSource(bucket, { id: "gd-1", type: "google-drive", enabled: true, extensions: [], refreshToken: "r", folderId: "f" });
    const response = await app.request("http://localhost/connect/google?sourceId=gd-1", {
      headers: { Authorization: "Bearer secret" },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect((response.headers.get("location") ?? "").startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
  });

  test("GET /sources/:id.json returns a single public source config", async () => {
    const { createSource } = await import("../lib/source");
    await createSource(bucket, { id: "gd-2", type: "google-drive", enabled: true, extensions: [".m4a"], refreshToken: "r", folderId: "f", account: "a@b.c" });
    const response = await app.request("http://localhost/sources/gd-2.json", { headers: { Authorization: "Bearer secret" } });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.id).toBe("gd-2");
    expect(body.refreshToken).toBeUndefined();

    const missing = await app.request("http://localhost/sources/nope.json", { headers: { Authorization: "Bearer secret" } });
    expect(missing.status).toBe(404);
  });

  test("GET /connect/google redirects to Google with state", async () => {
    const response = await app.request("http://localhost/connect/google?folderId=folder-1", {
      headers: { Authorization: "Bearer secret" },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    expect(location).toContain("client_id=client-1");
    expect(location).toContain("state=");
  });

  test("GET /sources.json migrates a legacy gdrive connection into a source", async () => {
    await bucket.write("connections/google-drive.json", JSON.stringify({
      provider: "google-drive",
      refreshToken: "r",
      scope: "https://www.googleapis.com/auth/drive.readonly",
      account: "me@example.com",
      folderId: "folder-1",
      extensions: [".m4a"],
      connectedAt: "2026-01-01T00:00:00.000Z",
      lastSyncAt: null,
      lastSyncSummary: null,
    }), { type: "application/json" });
    const response = await app.request("http://localhost/sources.json", { headers: { Authorization: "Bearer secret" } });
    expect(response.status).toBe(200);
    const body = await response.json() as { sources: Array<{ type: string; folderId: string }> };
    expect(body.sources.length).toBe(1);
    expect(body.sources[0]!.type).toBe("google-drive");
    expect(body.sources[0]!.folderId).toBe("folder-1");
    expect(await bucket.exists("connections/google-drive.json")).toBe(false);
  });
});
