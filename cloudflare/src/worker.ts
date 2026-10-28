/**
 * Medina's Cloudflare proof Worker (migration milestone 1 — see
 * docs/cloudflare-migration.md §4).
 *
 * Serves the two public device routes from the canonical artifact
 * bucket (sco-lifelog, bound as ARTIFACTS), plus a health check:
 *
 *   GET /health                      -> { ok: true }
 *   GET /api/capture-policy/<token>  -> the canonical capture policy,
 *        gated by the per-device capability token, verified against
 *        the hash registry the Medina server mirrors into the bucket
 *        (capture-policy/tokens.json). Unknown or revoked -> 404,
 *        the same contract as the Medina server and the medina-index
 *        Worker: the app treats it as terminal.
 *   GET /bucket-capture/<stamp>.apk -> a published recorder APK,
 *        streamed from bucket-capture/<stamp>.apk. APKs carry no
 *        credentials, so they are served to anyone, by exact stamp.
 *
 * This Worker is additive: it is deployed on its own Alchemy
 * stage-scoped name, reads the bucket only, and nothing live points
 * at it yet. The route semantics deliberately mirror
 * workers/medina-index/src/index.ts — the point of the milestone is
 * proving the Alchemy deployment path against the proven contract.
 *
 * The handler is an Effect program (the repo's HTTP precedent is
 * Effect HttpRouter on the server; the full router port arrives with
 * the read-cutover phase of the migration — for two routes and a
 * health check, the program below is the whole router).
 */
import * as Effect from "effect/Effect";

// Minimal structural types for the Workers runtime surface this file
// uses, so the file stands alone without @cloudflare/workers-types —
// the same approach as workers/medina-index/src/index.ts.

/** The slice of the R2 bucket binding this worker uses: reads only. */
interface R2ObjectLike {
  readonly body: ReadableStream;
  readonly size: number;
  readonly httpEtag: string;
}

interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
}

interface Env {
  readonly ARTIFACTS: R2BucketLike;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fail = (status: number, message: string): Response =>
  json({ error: message }, status);

/** SHA-256 hex of a string — the same digest the Medina server stores
 * per capability token in the registry. */
const sha256Hex = (value: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });

const APK_CONTENT_TYPE = "application/vnd.android.package-archive";
const POLICY_OBJECT_KEY = "capture-policy/policy.json";
const TOKENS_OBJECT_KEY = "capture-policy/tokens.json";

/** A published recorder APK, by exact stamp only. */
const serveApk = (
  env: Env,
  name: string,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const match = /^(0\d{12})\.apk$/.exec(name);
    if (match === null) return fail(404, "not found");
    const object = yield* Effect.promise(() =>
      env.ARTIFACTS.get(`bucket-capture/${match[1]}.apk`),
    );
    if (object === null) return fail(404, "not found");
    return new Response(object.body, {
      headers: {
        "content-type": APK_CONTENT_TYPE,
        "content-length": String(object.size),
        "cache-control": "public, max-age=31536000, immutable",
        etag: object.httpEtag,
      },
    });
  });

interface TokenRegistryEntry {
  readonly hash?: unknown;
  readonly revokedAt?: unknown;
}

/**
 * The capture policy, gated by its capability token. The document and
 * the token registry (hashes only) live in the bucket, written by the
 * Medina server, so a phone on any network can fetch its policy
 * without reaching the server host.
 */
const servePolicy = (
  env: Env,
  token: string,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (!token.startsWith("cpol_") || token.includes("/")) {
      return fail(404, "not found");
    }
    const registryObject = yield* Effect.promise(() =>
      env.ARTIFACTS.get(TOKENS_OBJECT_KEY),
    );
    if (registryObject === null) return fail(404, "not found");
    const tokens = yield* Effect.tryPromise({
      try: async () => {
        const parsed = (await new Response(registryObject.body).json()) as {
          tokens?: unknown;
        };
        if (!Array.isArray(parsed.tokens)) {
          throw new Error("registry has no tokens array");
        }
        return parsed.tokens as Array<TokenRegistryEntry>;
      },
      catch: () => "unreadable registry" as const,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (tokens === null) return fail(404, "not found");
    const hash = yield* sha256Hex(token);
    const known = tokens.some(
      (entry) => entry.revokedAt === null && entry.hash === hash,
    );
    if (!known) return fail(404, "not found");
    const policyObject = yield* Effect.promise(() =>
      env.ARTIFACTS.get(POLICY_OBJECT_KEY),
    );
    if (policyObject === null) return fail(500, "policy unavailable");
    return new Response(policyObject.body, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });

const handle = (request: Request, env: Env): Effect.Effect<Response> => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Effect.succeed(json({ ok: true }));
  }
  if (request.method === "GET" && url.pathname.startsWith("/bucket-capture/")) {
    return serveApk(env, url.pathname.slice("/bucket-capture/".length));
  }
  if (
    request.method === "GET" &&
    url.pathname.startsWith("/api/capture-policy/")
  ) {
    return servePolicy(
      env,
      decodeURIComponent(url.pathname.slice("/api/capture-policy/".length)),
    );
  }
  return Effect.succeed(fail(404, "not found"));
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return Effect.runPromise(handle(request, env));
  },
};
