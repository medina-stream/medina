import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createStreamMiddleware, getMedinaContext, isStreamHostAllowed } from "./stream-middleware";
import type { Stream } from "#lib/stream";

const originalEnv = { ...process.env };
const defaultUser = { username: "default", profile_pic_url: "/default-profile.jpg", credentials: [], tokens: [{ token: "secret" }] };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    buckets: { default: { bucketName: "test-bucket", endpoint: "https://storage.example", region: "auto" } },
    host: "test.stream.example",
    name: "Test stream",
    users: [defaultUser],
    ...overrides,
  };
}

describe("isStreamHostAllowed", () => {
  const streams = [makeStream({ host: "stream.example" }), makeStream({ host: "sco.stream.example" })];

  test("allows only configured hosts", () => {
    expect(isStreamHostAllowed("stream.example", streams)).toBe(true);
    expect(isStreamHostAllowed("sco.stream.example", streams)).toBe(true);
    expect(isStreamHostAllowed("www.stream.example", streams)).toBe(false);
    expect(isStreamHostAllowed(null, streams)).toBe(false);
  });

  test("allows configured host aliases", () => {
    const streams = [makeStream({ host: "primary.example", hostAliases: ["alias.example"] })];
    expect(isStreamHostAllowed("alias.example", streams)).toBe(true);
  });

  test("rejects when no streams are configured", () => {
    expect(isStreamHostAllowed("stream.example", [])).toBe(false);
  });
});

describe("createStreamMiddleware", () => {
  test("sets current stream and allows status through", async () => {
    const streams = [makeStream({ host: "stream.example" })];
    const app = new Hono();
    app.use("*", createStreamMiddleware(streams));
    app.get("/status.json", (c) => c.json({ host: getMedinaContext(c).site.host }));

    const res = await app.request("https://stream.example/status.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: "stream.example" });
  });

  test("rejects unknown hosts", async () => {
    const app = new Hono();
    app.use("*", createStreamMiddleware([makeStream({ host: "stream.example" })]));
    app.get("/status.json", (c) => c.json({ ok: true }));

    const res = await app.request("https://unknown.stream.example/status.json");
    expect(res.status).toBe(404);
  });

  test("routes sco.stream.example to sco stream", async () => {
    const streams = [makeStream({ host: "stream.example", name: "Primary" }), makeStream({ host: "sco.stream.example", name: "Sco" })];
    const app = new Hono();
    app.use("*", createStreamMiddleware(streams));
    app.get("/status.json", (c) => c.json({ host: getMedinaContext(c).site.host, name: getMedinaContext(c).site.name }));

    const res = await app.request("https://sco.stream.example/status.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: "sco.stream.example", name: "Sco" });
  });

  test("allows public docs without stream authorization", async () => {
    const app = new Hono();
    app.use("*", createStreamMiddleware([makeStream({ host: "sco.stream.example" })]));
    app.get("/api.md", (c) => c.text("public api docs"));
    app.get("/skill.md", (c) => c.text("public skill"));

    expect((await app.request("https://sco.stream.example/api.md")).status).toBe(200);
    expect((await app.request("https://sco.stream.example/skill.md")).status).toBe(200);
  });

  test("returns 401 for a missing token on a protected stream", async () => {
    const app = new Hono();
    app.use("*", createStreamMiddleware([makeStream({ host: "sco.stream.example" })]));
    app.get("/protected.json", (c) => c.json({ ok: true }));

    const res = await app.request("https://sco.stream.example/protected.json");
    expect(res.status).toBe(401);
  });

  test("returns 200 with a valid token", async () => {
    const app = new Hono();
    app.use("*", createStreamMiddleware([makeStream({ host: "sco.stream.example" })]));
    app.get("/protected.json", (c) => c.json({ ok: true }));

    const res = await app.request("https://sco.stream.example/protected.json", { headers: { Authorization: "Bearer secret" } });
    expect(res.status).toBe(200);
  });

  test("returns 403 for a wrong token", async () => {
    const app = new Hono();
    app.use("*", createStreamMiddleware([makeStream({ host: "sco.stream.example" })]));
    app.get("/protected.json", (c) => c.json({ ok: true }));

    const res = await app.request("https://sco.stream.example/protected.json", { headers: { Authorization: "Bearer wrong" } });
    expect(res.status).toBe(403);
  });

  test("Medina context is unavailable outside middleware context", () => {
    expect(() => getMedinaContext({ get: () => undefined })).toThrow("No Medina request context");
  });
});
