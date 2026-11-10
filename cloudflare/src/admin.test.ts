/**
 * Tests for the token-administration port (src/admin.ts): the
 * registry round trip over a fake bucket — mint (server-shaped
 * token + id), list, revoke — and the registry JSON's compatibility
 * with the shape the server writes (hash = SHA-256 hex of the
 * token, verified against a token the test mints and digests
 * itself).
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { issueToken, listTokens, revokeToken } from "./admin.ts";

const makeFakeBucket = () => {
  const objects = new Map<string, string>();
  const bucket = {
    get: async (key: string) => {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        body: new ReadableStream({
          start: (controller: {
            enqueue: (chunk: Uint8Array) => void;
            close: () => void;
          }) => {
            controller.enqueue(new TextEncoder().encode(value));
            controller.close();
          },
        }),
        size: value.length,
        httpEtag: '"fake"',
        arrayBuffer: async () =>
          new TextEncoder().encode(value).buffer as ArrayBuffer,
      };
    },
    put: async (key: string, value: string | Uint8Array) => {
      objects.set(
        key,
        typeof value === "string"
          ? value
          : new TextDecoder().decode(value),
      );
    },
  };
  return { bucket, objects };
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

describe("capture-policy token administration", () => {
  test("mint → list → revoke round trip, registry in the server's shape", async () => {
    const { bucket, objects } = makeFakeBucket();
    const issued = await Effect.runPromise(
      issueToken(bucket, "  Pixel   10a "),
    );
    // The server's mint shape: cpol_ + base64url(32 bytes) = 43
    // chars after the prefix; id = base64url(18 bytes) = 24 chars.
    expect(issued.token).toMatch(/^cpol_[A-Za-z0-9_-]{43}$/);
    expect(issued.id).toMatch(/^[A-Za-z0-9_-]{24}$/);

    const registry = JSON.parse(
      objects.get("capture-policy/tokens.json")!,
    ) as {
      version: number;
      tokens: Array<{
        id: string;
        label: string;
        hash: string;
        createdAt: string;
        revokedAt: string | null;
        lastUsedAt: string | null;
      }>;
    };
    expect(registry.version).toBe(1);
    expect(registry.tokens.length).toBe(1);
    // Label cleaning is the server's: trimmed, whitespace
    // collapsed.
    expect(registry.tokens[0]!.label).toBe("Pixel 10a");
    expect(registry.tokens[0]!.hash).toBe(await sha256Hex(issued.token));
    expect(registry.tokens[0]!.revokedAt).toBeNull();

    const listed = await Effect.runPromise(listTokens(bucket));
    expect(listed.length).toBe(1);
    expect(listed[0]!.active).toBe(true);

    const revoked = await Effect.runPromise(
      revokeToken(bucket, issued.id),
    );
    expect(revoked).toBe(true);
    const listedAfter = await Effect.runPromise(listTokens(bucket));
    expect(listedAfter[0]!.active).toBe(false);
    expect(listedAfter[0]!.revokedAt).not.toBeNull();

    const missing = await Effect.runPromise(
      revokeToken(bucket, "no-such-id"),
    );
    expect(missing).toBe(false);
  });

  test("an empty label becomes the server's default", async () => {
    const { bucket } = makeFakeBucket();
    await Effect.runPromise(issueToken(bucket, "   "));
    const listed = await Effect.runPromise(listTokens(bucket));
    expect(listed[0]!.label).toBe("unnamed device");
  });
});
