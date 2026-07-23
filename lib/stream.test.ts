import { describe, expect, test } from "bun:test";
import { authorizeStreamRequest, normalizeStreamHost, streamFromRequest, type Stream } from "./stream";
import { tailscaleUserLoginHeader } from "./authz";
import { createMemoryBucket } from "./bucket.test";

const defaultUser = { username: "default", profile_pic_url: "/default-profile.jpg", credentials: [], tokens: [{ token: "secret" }] };

function makeStream(host: string, overrides: Partial<Stream> = {}): Stream {
  return {
    buckets: { default: { bucketName: "test-bucket", endpoint: "https://storage.example", region: "auto" } },
    host,
    users: [defaultUser],
    ...overrides,
  };
}

function request(url: string, headers?: HeadersInit) {
  return new Request(url, { headers });
}

describe("normalizeStreamHost", () => {
  test("normalizes the host", () => {
    expect(normalizeStreamHost("Example.COM")).toBe("example.com");
    expect(normalizeStreamHost("  STREAM.example  ")).toBe("stream.example");
    expect(normalizeStreamHost(null)).toBeNull();
    expect(normalizeStreamHost("")).toBeNull();
  });
});

describe("streamFromRequest", () => {
  const streams = [makeStream("example.com"), makeStream("sco.stream.example")];

  test("matches request host to stream", () => {
    expect(streamFromRequest(request("https://example.com/"), streams)?.host).toBe("example.com");
    expect(streamFromRequest(request("https://sco.stream.example/"), streams)?.host).toBe("sco.stream.example");
  });

  test("returns null for unknown hosts", () => {
    expect(streamFromRequest(request("https://unknown.com/"), streams)).toBeNull();
  });

  test("uses Host header when present", () => {
    const req = request("http://localhost:3002/", { host: "example.com" });
    expect(streamFromRequest(req, streams)?.host).toBe("example.com");
  });

  test("returns null for empty streams array", () => {
    expect(streamFromRequest(request("https://example.com/"), [])).toBeNull();
  });

  test("matches configured host aliases", () => {
    const streams = [makeStream("primary.example", { hostAliases: ["alias.example"] })];
    expect(streamFromRequest(request("https://alias.example/"), streams)?.host).toBe("primary.example");
  });

  test("requires the request host to match even for a single stream", () => {
    const single = [makeStream("myhost.com")];
    expect(streamFromRequest(request("https://myhost.com/"), single)?.host).toBe("myhost.com");
    expect(streamFromRequest(request("https://anyhost.com/"), single)).toBeNull();
  });
});

describe("authorizeStreamRequest", () => {
  test("rejects missing/wrong tokens and accepts bearer or basic auth", () => {
    const stream = makeStream("example.com");
    expect(authorizeStreamRequest(stream, request("https://example.com/"))).toMatchObject({ allowed: false, status: 401 });
    expect(authorizeStreamRequest(stream, request("https://example.com/", { Authorization: "Bearer wrong" }))).toMatchObject({ allowed: false, status: 403 });
    expect(authorizeStreamRequest(stream, request("https://example.com/", { Authorization: "Bearer secret" }))).toMatchObject({ allowed: true });
    expect(authorizeStreamRequest(stream, request("https://example.com/", { Authorization: `Basic ${btoa(":secret")}` }))).toMatchObject({ allowed: true });
  });

  test("accepts user tokens", () => {
    const stream = makeStream("example.com", { users: [{ ...defaultUser, tokens: [{ token: "tok" }] }] });
    expect(authorizeStreamRequest(stream, request("https://example.com/", { Authorization: "Bearer tok" }))).toMatchObject({ allowed: true });
  });

  test("accepts matching Tailscale stream user credentials", () => {
    const stream = makeStream("example.com", {
      users: [{ ...defaultUser, credentials: [{ type: "tailscale", value: "alice@example.com" }] }],
    });
    expect(authorizeStreamRequest(stream, request("https://example.com/", { [tailscaleUserLoginHeader]: "Alice@Example.com" }))).toMatchObject({ allowed: true, reason: "tailscale" });
  });

  test("rejects unmatched Tailscale identities", () => {
    const stream = makeStream("example.com");
    expect(authorizeStreamRequest(stream, request("https://example.com/", { [tailscaleUserLoginHeader]: "alice@example.com" }))).toMatchObject({ allowed: false, reason: "tailscale-login-forbidden", status: 403 });
  });
});

import {
  defaultStreamPreferences,
  ensureStreamPreferences,
  readStreamPreferences,
  streamPreferencesKey,
} from "./stream";

function createBucket() {
  return createMemoryBucket();
}

describe("stream preferences", () => {
  test("returns defaults without mutating a missing bucket key", async () => {
    const bucket = createBucket();

    expect(await readStreamPreferences(bucket)).toEqual(defaultStreamPreferences);
    expect(await bucket.exists(streamPreferencesKey)).toBe(false);
  });

  test("creates the default medina.conf", async () => {
    const bucket = createBucket();

    expect(await ensureStreamPreferences(bucket)).toEqual({ name: "My Stream" });
    expect(await bucket.readJson<{ name: string }>(streamPreferencesKey)).toEqual({ name: "My Stream" });
  });

  test("loads the name and preserves additional preferences", async () => {
    const bucket = createBucket();
    await bucket.write(streamPreferencesKey, JSON.stringify({
      name: "Field Notes",
      timezone: "America/Los_Angeles",
    }));

    expect(await ensureStreamPreferences(bucket)).toEqual({
      name: "Field Notes",
      timezone: "America/Los_Angeles",
    });
  });

  test("rejects invalid configuration", async () => {
    const bucket = createBucket();
    await bucket.write(streamPreferencesKey, JSON.stringify({ name: " " }));

    expect(ensureStreamPreferences(bucket)).rejects.toThrow(
      "medina.conf must contain a non-empty string name.",
    );
  });
});
