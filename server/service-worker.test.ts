import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createStreamMiddleware } from "./stream-middleware";
import { createServiceWorkerRegistrationScript, createServiceWorkerResponse } from "./service-worker";
import type { Stream } from "#lib/stream";

const defaultUser = { username: "default", profile_pic_url: "/default-profile.jpg", credentials: [], tokens: [{ token: "secret" }] };
const streams: Stream[] = [{ buckets: { default: { bucketName: "test-bucket", endpoint: "https://storage.example", region: "auto" } }, host: "localhost", name: "Test", users: [defaultUser] }];

describe("service worker", () => {
  test("serves a minimal fetch-handling service worker", async () => {
    const response = createServiceWorkerResponse();
    const script = await response.text();

    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("service-worker-allowed")).toBe("/");
    expect(script).toContain('self.addEventListener("fetch"');
    expect(script).toContain("/manifest.json");
    expect(script).toContain("/icon-maskable-512.png");
  });

  test("registration script points at /sw.js", () => {
    expect(createServiceWorkerRegistrationScript()).toContain('navigator.serviceWorker.register("/sw.js")');
  });

  test("stream middleware allows sw.js without auth", async () => {
    const app = new Hono();
    app.use("*", createStreamMiddleware(streams));
    app.get("/sw.js", () => createServiceWorkerResponse());

    const response = await app.request("http://localhost/sw.js");
    expect(response.status).toBe(200);
  });
});
