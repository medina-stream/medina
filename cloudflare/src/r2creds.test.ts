/**
 * Tests for src/r2creds.ts: the SigV4 presign is pinned against
 * AWS's published query-string-auth test vector; the temporary
 * credential mint is pinned against Cloudflare's documented
 * local-signing algorithm, verified with an independent HMAC
 * implementation (node:crypto) rather than the module's own.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import * as Effect from "effect/Effect";
import {
  mintTempCredentials,
  parseS3Credentials,
  presignGetUrl,
} from "./r2creds.ts";

describe("presignGetUrl", () => {
  // AWS's documented example ("Authenticating Requests: Using
  // Query Parameters (AWS Signature Version 4)"): GET test.txt in
  // examplebucket, 20130524T000000Z, 86400 s expiry.
  test("matches the AWS SigV4 presign test vector", async () => {
    const url = await Effect.runPromise(
      presignGetUrl({
        endpoint: "https://examplebucket.s3.amazonaws.com",
        bucket: "",
        key: "test.txt",
        credentials: {
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
        ttlSeconds: 86400,
        now: new Date("2013-05-24T00:00:00Z"),
        region: "us-east-1",
      }),
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/test.txt");
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe(
      "AWS4-HMAC-SHA256",
    );
    expect(parsed.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
    expect(parsed.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  test("path-style R2 URL with a session token", async () => {
    const url = await Effect.runPromise(
      presignGetUrl({
        endpoint: "https://acct123.r2.cloudflarestorage.com",
        bucket: "sco-lifelog",
        key: "capture/abc/file name.m4a",
        credentials: {
          accessKeyId: "parentkeyid",
          secretAccessKey: "tempsecret",
          sessionToken: "tok123",
        },
        ttlSeconds: 7200,
        now: new Date("2026-11-03T00:00:00Z"),
      }),
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(
      "/sco-lifelog/capture/abc/file%20name.m4a",
    );
    expect(parsed.searchParams.get("X-Amz-Security-Token")).toBe("tok123");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("7200");
    expect(parsed.searchParams.get("X-Amz-Credential")).toBe(
      "parentkeyid/20261103/auto/s3/aws4_request",
    );
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

describe("mintTempCredentials", () => {
  const parent = {
    accessKeyId: "0f0a691c08bbeb9a016037c9fbaee314",
    secretAccessKey: "parent-secret",
  };
  const now = new Date("2026-11-03T12:00:00Z");

  test("produces the documented credential triple", async () => {
    const creds = await Effect.runPromise(
      mintTempCredentials({
        endpoint: "https://acct123.r2.cloudflarestorage.com",
        accountId: "acct123",
        parent,
        bucket: "sco-lifelog",
        permission: "object-read-write",
        ttlSeconds: 43200,
        prefixes: ["media/media-v1/cap1/"],
        now,
      }),
    );
    expect(creds.accessKeyId).toBe(parent.accessKeyId);
    // Session token is base64("jwt/" + jwt).
    const decoded = Buffer.from(creds.sessionToken, "base64").toString(
      "utf8",
    );
    expect(decoded.startsWith("jwt/")).toBe(true);
    const jwt = decoded.slice("jwt/".length);
    const [header, payload, signature] = jwt.split(".") as [
      string,
      string,
      string,
    ];
    // The temporary secret is the SHA-256 hex of the signed JWT.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(jwt),
    );
    const digestHex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(creds.secretAccessKey).toBe(digestHex);
    // Header and claims match the documented shape.
    const headerJson = JSON.parse(
      Buffer.from(header, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(headerJson).toEqual({ alg: "HS256", typ: "JWT" });
    const payloadJson = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(payloadJson["bucket"]).toBe("sco-lifelog");
    expect(payloadJson["scope"]).toBe("object-read-write");
    expect(payloadJson["paths"]).toEqual({
      prefixPaths: ["media/media-v1/cap1/"],
      objectPaths: [],
    });
    expect(payloadJson["sub"]).toBe("acct123");
    expect(payloadJson["iss"]).toBe(parent.accessKeyId);
    expect(payloadJson["aud"]).toBe("acct123.r2.cloudflarestorage.com");
    expect(payloadJson["iat"]).toBe(Math.floor(now.getTime() / 1000));
    expect(payloadJson["exp"]).toBe(
      Math.floor(now.getTime() / 1000) + 43200,
    );
    // The signature verifies under an independent HMAC-SHA256.
    const expected = createHmac("sha256", parent.secretAccessKey)
      .update(`${header}.${payload}`)
      .digest();
    expect(Buffer.from(signature, "base64url").equals(expected)).toBe(
      true,
    );
  });

  test("object restrictions land in objectPaths", async () => {
    const creds = await Effect.runPromise(
      mintTempCredentials({
        endpoint: "https://acct123.r2.cloudflarestorage.com",
        accountId: "acct123",
        parent,
        bucket: "sco-lifelog",
        permission: "object-read-only",
        ttlSeconds: 7200,
        objects: ["capture/abc/blob.m4a"],
        now,
      }),
    );
    const jwt = Buffer.from(creds.sessionToken, "base64")
      .toString("utf8")
      .slice(4);
    const payloadJson = JSON.parse(
      Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(payloadJson["scope"]).toBe("object-read-only");
    expect(payloadJson["paths"]).toEqual({
      prefixPaths: [],
      objectPaths: ["capture/abc/blob.m4a"],
    });
  });
});

describe("parseS3Credentials", () => {
  test("accepts the binding JSON, rejects anything else", () => {
    const value = parseS3Credentials(
      JSON.stringify({
        endpoint: "https://acct123.r2.cloudflarestorage.com",
        bucketName: "sco-lifelog",
        region: "auto",
        accessKeyId: "tokid",
        secretAccessKey: "secret",
      }),
    );
    expect(value?.bucketName).toBe("sco-lifelog");
    expect(parseS3Credentials(undefined)).toBeNull();
    expect(parseS3Credentials("")).toBeNull();
    expect(parseS3Credentials("not json")).toBeNull();
    expect(parseS3Credentials(JSON.stringify({ a: 1 }))).toBeNull();
    expect(parseS3Credentials({ endpoint: "x" })).toBeNull();
  });
});
