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
 * Milestone 2 adds the shadow ingest (docs/cloudflare-migration.md
 * §3 phase 1): a Cron Trigger (every minute) lists the capture source
 * bucket (sco-lifelog-in, bound as CAPTURE_IN), classifies objects
 * exactly as the medina-dev capture sources do, and records what it
 * *would* ingest in the ShadowDiscovery Durable Object (SQLite) —
 * per object: source, size, etag, bucket lastModified, and the
 * firstSeenAt timestamp of the shadow's first sighting. Discover-only
 * means discover-only: the cron handler never downloads an object,
 * never writes to any bucket, and submits nothing to any provider;
 * the Durable Object's own storage is the only write. `GET
 * /shadow/status` (same device-token gate as the policy route)
 * reports the shadow's notebook for parity checks against
 * medina-dev's ingest receipts.
 *
 * Milestone 4 step 2 adds the capture loop (src/capture.ts): the
 * same Cron Trigger also plans the trailing window of the three
 * capture sources (capture-bucket, device-events, local-transcripts)
 * and diffs each item's plan — receipt, artifact keys, index
 * registrations, and the coalesced latest-location reduction —
 * against what the live pipeline produced. `POST /capture/run` and
 * `GET /capture/status` (same device-token gate) expose it for
 * parity checks. The loop's mode is the CAPTURE_LOOP_MODE deploy
 * variable: as a shadow (the step-2 build) it performed nothing and
 * medina-dev remained the sole live pipeline; the step-2 cutover
 * flipped it to "live", where each tick first performs the window's
 * unreceipted items and then runs the same diff over the result, so
 * the notebook keeps verifying the pipeline that now runs here.
 *
 * Milestone 4 steps 3–4 add two more passes to the same Cron
 * Trigger. The star detector (src/stars.ts) re-reads the day-index
 * snapshot's current and previous UTC days, plans the voice-star
 * filings and the retention sweep exactly as medina-dev's detector
 * does, and diffs the plan against the authored star records;
 * STAR_DETECTOR_MODE flips it from shadow to performing. The
 * archive sweep (src/archive.ts) reconciles a bounded slice of
 * captures per tick against their archive receipts — receipt-less
 * captures first when live, a rotating slice of the census when
 * shadowing; ARCHIVE_SWEEP_MODE is its flip. `POST /stars/run`,
 * `GET /stars/status`, `POST /archive/run`, and
 * `GET /archive/status` (same device-token gate) expose both for
 * parity checks.
 *
 * The handler is an Effect program (the repo's HTTP precedent is
 * Effect HttpRouter on the server; the full router port arrives with
 * the read-cutover phase of the migration — for two routes and a
 * health check, the program below is the whole router).
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  capturePlatformLayer,
  runCaptureLivePass,
  runCaptureShadowPass,
  type CaptureEnv,
  type SecretsStoreSecretLike,
} from "./capture.ts";
import { artifactCatalogLayer } from "./catalog.ts";
import {
  runStarsLivePass,
  runStarsShadowPass,
  starsPlatformLayer,
  type StarsEnv,
} from "./stars.ts";
import {
  archivePlatformLayer,
  runArchivePass,
  type ArchiveEnv,
} from "./archive.ts";
import {
  handleJournal,
  refreshReadModelSnapshot,
} from "./journal.ts";

export { CaptureShadow } from "./capture.ts";
export { StarsShadow } from "./stars.ts";
export { ArchiveShadow } from "./archive.ts";

// Minimal structural types for the Workers runtime surface this file
// uses, so the file stands alone without @cloudflare/workers-types —
// the same approach as workers/medina-index/src/index.ts.

/** The slice of the R2 bucket binding this worker uses. */
interface R2ObjectLike {
  readonly body: ReadableStream;
  readonly size: number;
  readonly httpEtag: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2ListedObjectLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
}

interface R2ListPageLike {
  readonly objects: ReadonlyArray<R2ListedObjectLike>;
  readonly delimitedPrefixes?: ReadonlyArray<string>;
  readonly truncated: boolean;
  readonly cursor?: string;
}

interface R2ObjectHeadLike {
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly customMetadata: Record<string, string>;
}

interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  head(key: string): Promise<R2ObjectHeadLike | null>;
  put(
    key: string,
    value: string | Uint8Array,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly delimiter?: string;
  }): Promise<R2ListPageLike>;
}

/** The slice of a Durable Object namespace binding this worker uses. */
interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

interface Env {
  readonly ARTIFACTS: R2BucketLike;
  readonly CAPTURE_IN: R2BucketLike;
  readonly ShadowDiscovery: DurableObjectNamespaceLike;
  readonly CaptureShadow: DurableObjectNamespaceLike;
  readonly StarsShadow: DurableObjectNamespaceLike;
  readonly ArchiveShadow: DurableObjectNamespaceLike;
  /** Secrets Store binding (declared in alchemy.run.ts): the
   * medina-index Bearer token, read via .get() at call time. */
  readonly INDEX_API_TOKEN: SecretsStoreSecretLike;
  /** Plain deploy variable (declared in alchemy.run.ts): "live" makes
   * the capture loop perform; anything else keeps it a shadow. */
  readonly CAPTURE_LOOP_MODE?: string;
  /** Step 3: "live" makes the star detector perform; else shadow. */
  readonly STAR_DETECTOR_MODE?: string;
  /** Step 4: "live" makes the archive sweep perform; else shadow. */
  readonly ARCHIVE_SWEEP_MODE?: string;
}

const captureEnv = (env: Env): CaptureEnv => ({
  sourceBucket: env.CAPTURE_IN,
  artifacts: env.ARTIFACTS,
  indexToken: env.INDEX_API_TOKEN,
  notebook: env.CaptureShadow,
  loopMode: env.CAPTURE_LOOP_MODE === "live" ? "live" : "shadow",
});

const starsEnv = (env: Env): StarsEnv => ({
  artifacts: env.ARTIFACTS,
  notebook: env.StarsShadow,
});

const archiveEnv = (env: Env): ArchiveEnv => ({
  artifacts: env.ARTIFACTS,
  notebook: env.ArchiveShadow,
});

const starsMode = (env: Env): "live" | "shadow" =>
  env.STAR_DETECTOR_MODE === "live" ? "live" : "shadow";

const archiveMode = (env: Env): "live" | "shadow" =>
  env.ARCHIVE_SWEEP_MODE === "live" ? "live" : "shadow";

/**
 * The full stage platform: the capture loop's services and the
 * artifact catalog as the base, with the step-3/4 stages' own
 * services built on top of it. One composition for the cron and
 * the manual endpoints, so both run the passes identically.
 */
const stagePlatform = (env: Env) => {
  const base = Layer.mergeAll(
    capturePlatformLayer(captureEnv(env)),
    artifactCatalogLayer(env.ARTIFACTS),
  );
  return Layer.mergeAll(
    base,
    starsPlatformLayer(starsEnv(env)).pipe(Layer.provide(base)),
    archivePlatformLayer(archiveEnv(env)).pipe(Layer.provide(base)),
  );
};

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
 * Verify a per-device capability token against the hash registry the
 * Medina server mirrors into the bucket (hashes only, `revokedAt`
 * included). False for malformed, unknown, or revoked tokens — and
 * for any registry read failure, so every gated route fails closed.
 */
const isValidToken = (
  env: Env,
  token: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!token.startsWith("cpol_") || token.includes("/")) return false;
    const registryObject = yield* Effect.promise(() =>
      env.ARTIFACTS.get(TOKENS_OBJECT_KEY),
    );
    if (registryObject === null) return false;
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
    if (tokens === null) return false;
    const hash = yield* sha256Hex(token);
    return tokens.some(
      (entry) => entry.revokedAt === null && entry.hash === hash,
    );
  });

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
    if (!(yield* isValidToken(env, token))) {
      return fail(404, "not found");
    }
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

// ---------------------------------------------------------------------------
// Shadow ingest (milestone 2): discover-only mirror of the medina-dev
// capture loop's discovery. The server classifies one shared listing
// (prefix "", the SOURCE_BUCKET_PREFIX default) three ways
// (lib/capture/CaptureBucket.ts, DeviceEvents.ts, LocalTranscripts.ts):
//
//   capture-bucket:    keys not under probe/, extension .m4a
//   device-events:     keys containing /events/ and ending .json
//   local-transcripts: keys containing /transcript/ and ending .json
//
// and lists the whole prefix, keeping the newest by lastModified
// (lib/Bucket.ts pages every continuation token). The shadow does the
// same listing against the R2 binding, classifies the same way, and
// hands the classified set to the ShadowDiscovery Durable Object,
// which records first sightings. Nothing here downloads an object or
// writes to a bucket.
// ---------------------------------------------------------------------------

type ShadowSourceName =
  | "capture-bucket"
  | "device-events"
  | "local-transcripts";

const classifyShadowKey = (key: string): ShadowSourceName | null => {
  // The server's capture-bucket mapping drops probe objects outright.
  if (key.startsWith("probe/")) return null;
  if (key.toLowerCase().endsWith(".m4a")) return "capture-bucket";
  if (key.includes("/events/") && key.endsWith(".json")) {
    return "device-events";
  }
  if (key.includes("/transcript/") && key.endsWith(".json")) {
    return "local-transcripts";
  }
  return null;
};

interface ShadowItem {
  readonly source: ShadowSourceName;
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly lastModified: string;
}

const SHADOW_DO_NAME = "shadow-v1";
const SHADOW_MAX_PAGES = 50;

const shadowStub = (env: Env): DurableObjectStubLike =>
  env.ShadowDiscovery.get(env.ShadowDiscovery.idFromName(SHADOW_DO_NAME));

/** Page the whole capture prefix, newest-first, like the server. */
const listCapturePrefix = (
  env: Env,
): Effect.Effect<ReadonlyArray<R2ListedObjectLike>> =>
  Effect.promise(async () => {
    const all: Array<R2ListedObjectLike> = [];
    let cursor: string | undefined;
    for (let page = 0; page < SHADOW_MAX_PAGES; page++) {
      const result = await env.CAPTURE_IN.list({
        prefix: "",
        limit: 1000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      all.push(...result.objects);
      if (!result.truncated || result.cursor === undefined) break;
      cursor = result.cursor;
    }
    return all.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
  });

/** One shadow pass: list, classify, record sightings in the DO. */
const runShadowDiscovery = (
  env: Env,
  ranAt: string,
): Effect.Effect<{ listed: number; classified: number }> =>
  Effect.gen(function* () {
    const listed = yield* listCapturePrefix(env);
    const items: Array<ShadowItem> = [];
    for (const object of listed) {
      const source = classifyShadowKey(object.key);
      if (source === null) continue;
      items.push({
        source,
        key: object.key,
        size: object.size,
        etag: object.etag,
        lastModified: object.uploaded.toISOString(),
      });
    }
    const response = yield* Effect.promise(() =>
      shadowStub(env).fetch(
        new Request("http://shadow-discovery/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ranAt, items }),
        }),
      ),
    );
    if (!response.ok) {
      yield* Effect.logError(
        `shadow discovery run rejected by the Durable Object: ${response.status}`,
      );
    }
    return { listed: listed.length, classified: items.length };
  });

/**
 * Manual trigger for one shadow pass (same device-token gate) —
 * parity tooling: it runs exactly what the Cron Trigger runs, but
 * synchronously and with the outcome in the response, so a checker
 * never has to wait on the cron's phase to compare notebooks.
 */
const serveShadowRun = (
  env: Env,
  request: Request,
  url: URL,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const bearer = request.headers.get("authorization");
    const token =
      bearer !== null && bearer.startsWith("Bearer ")
        ? bearer.slice("Bearer ".length)
        : (url.searchParams.get("token") ?? "");
    if (!(yield* isValidToken(env, token))) {
      return fail(404, "not found");
    }
    const outcome = yield* runShadowDiscovery(
      env,
      new Date().toISOString(),
    ).pipe(
      Effect.map((stats) => ({ ok: true as const, ...stats })),
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false as const,
          error: String(cause).slice(0, 500),
        }),
      ),
    );
    return json(outcome, outcome.ok ? 200 : 500);
  });

/**
 * The shadow's notebook, behind the same device-token gate as the
 * policy route (token as `Authorization: Bearer` or `?token=`).
 */
const serveShadowStatus = (
  env: Env,
  request: Request,
  url: URL,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const bearer = request.headers.get("authorization");
    const token =
      bearer !== null && bearer.startsWith("Bearer ")
        ? bearer.slice("Bearer ".length)
        : (url.searchParams.get("token") ?? "");
    if (!(yield* isValidToken(env, token))) {
      return fail(404, "not found");
    }
    const response = yield* Effect.promise(() =>
      shadowStub(env).fetch(new Request("http://shadow-discovery/status")),
    );
    if (!response.ok) return fail(500, "shadow status unavailable");
    return new Response(response.body, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });

/**
 * Manual trigger for one read-model snapshot refresh (same
 * device-token gate) — ops tooling: it runs exactly what the Cron
 * Trigger runs for the journal, synchronously, with the outcome in
 * the response. `?force=1` rebuilds even when the inputs
 * fingerprint is unchanged.
 */
const serveJournalRefresh = (
  env: Env,
  request: Request,
  url: URL,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const bearer = request.headers.get("authorization");
    const token =
      bearer !== null && bearer.startsWith("Bearer ")
        ? bearer.slice("Bearer ".length)
        : (url.searchParams.get("token") ?? "");
    if (!(yield* isValidToken(env, token))) {
      return fail(404, "not found");
    }
    const outcome = yield* refreshReadModelSnapshot(
      env.ARTIFACTS,
      url.searchParams.get("force") === "1",
    ).pipe(
      Effect.map((stats) => ({ ok: true as const, ...stats })),
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false as const,
          error: String(cause).slice(0, 500),
        }),
      ),
    );
    return json(outcome, outcome.ok ? 200 : 500);
  });

/**
 * Manual trigger for one capture-loop pass (§4.3 step 2), same
 * device-token gate — parity tooling: it runs exactly what the Cron
 * Trigger runs (in live mode: perform, then diff), synchronously,
 * with the report in the response, so a checker can work any window
 * on demand. Window: `?from=<ISO>&to=<ISO>` or `?hours=N` (default 1)
 * ending now; `?staleMinutes=N` (default 15) is how old an
 * unreceipted item must be before it counts as missing rather than
 * pending.
 */
const serveCaptureRun = (
  env: Env,
  request: Request,
  url: URL,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const bearer = request.headers.get("authorization");
    const token =
      bearer !== null && bearer.startsWith("Bearer ")
        ? bearer.slice("Bearer ".length)
        : (url.searchParams.get("token") ?? "");
    if (!(yield* isValidToken(env, token))) {
      return fail(404, "not found");
    }
    const now = new Date();
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const hours = Number(url.searchParams.get("hours") ?? "1");
    const windowTo =
      toParam !== null && !Number.isNaN(Date.parse(toParam))
        ? new Date(toParam)
        : now;
    const windowFrom =
      fromParam !== null && !Number.isNaN(Date.parse(fromParam))
        ? new Date(fromParam)
        : new Date(
            windowTo.getTime() -
              (Number.isFinite(hours) && hours > 0 ? hours : 1) * 3_600_000,
          );
    const staleMinutes = Number(
      url.searchParams.get("staleMinutes") ?? "15",
    );
    const staleAfterMs =
      (Number.isFinite(staleMinutes) && staleMinutes > 0
        ? staleMinutes
        : 15) * 60_000;
    const platform = capturePlatformLayer(captureEnv(env));
    // In live mode a manual run performs first — over the requested
    // window, with the per-source cap lifted so a checker can drain
    // a backlog on demand — and then diffs, exactly the cron's two
    // halves. In shadow mode it only diffs, as it always has.
    const live =
      captureEnv(env).loopMode === "live"
        ? yield* runCaptureLivePass({
            windowFrom,
            windowTo,
            perSourceLimit: 1000,
          }).pipe(
            Effect.provide(platform),
            Effect.map((summary) => ({ ok: true as const, summary })),
            Effect.catch((cause) =>
              Effect.succeed({
                ok: false as const,
                error: String(cause).slice(0, 500),
              }),
            ),
          )
        : null;
    const outcome = yield* runCaptureShadowPass({
      mode: "manual",
      windowFrom,
      windowTo,
      staleAfterMs,
      ...(live !== null && live.ok
        ? { performed: live.summary.performed }
        : {}),
    }).pipe(
      Effect.provide(platform),
      Effect.map((report) => ({ ok: true as const, report })),
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false as const,
          error: String(cause).slice(0, 500),
        }),
      ),
    );
    return json(
      live === null ? outcome : { ...outcome, live },
      outcome.ok ? 200 : 500,
    );
  });

/** The capture shadow's notebook (last report), same gate. */
const serveCaptureStatus = (
  env: Env,
  request: Request,
  url: URL,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const bearer = request.headers.get("authorization");
    const token =
      bearer !== null && bearer.startsWith("Bearer ")
        ? bearer.slice("Bearer ".length)
        : (url.searchParams.get("token") ?? "");
    if (!(yield* isValidToken(env, token))) {
      return fail(404, "not found");
    }
    const stub = env.CaptureShadow.get(
      env.CaptureShadow.idFromName("capture-shadow-v1"),
    );
    const response = yield* Effect.promise(() =>
      stub.fetch(new Request("http://capture-shadow/status")),
    );
    if (!response.ok) return fail(500, "capture status unavailable");
    return new Response(response.body, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });

/** The device-token gate value from a request (Bearer or ?token=). */
const gateToken = (request: Request, url: URL): string => {
  const bearer = request.headers.get("authorization");
  return bearer !== null && bearer.startsWith("Bearer ")
    ? bearer.slice("Bearer ".length)
    : (url.searchParams.get("token") ?? "");
};

/**
 * Manual trigger for one star-detector pass (§4.3 step 3), same
 * device-token gate — parity tooling: it runs exactly what the Cron
 * Trigger runs (in live mode: perform, then diff), synchronously,
 * with the report in the response. `?staleMinutes=N` (default 15)
 * is how old a divergence must be before it counts as a mismatch
 * rather than pending.
 */
const serveStarsRun = (
  env: Env,
  request: Request,
  url: URL,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (!(yield* isValidToken(env, gateToken(request, url)))) {
      return fail(404, "not found");
    }
    const now = new Date();
    const staleMinutes = Number(url.searchParams.get("staleMinutes") ?? "15");
    const staleAfterMs =
      (Number.isFinite(staleMinutes) && staleMinutes > 0
        ? staleMinutes
        : 15) * 60_000;
    const platform = stagePlatform(env);
    const live =
      starsMode(env) === "live"
        ? yield* runStarsLivePass({ now }).pipe(
            Effect.provide(platform),
            Effect.map((summary) => ({ ok: true as const, summary })),
            Effect.catch((cause) =>
              Effect.succeed({
                ok: false as const,
                error: String(cause).slice(0, 500),
              }),
            ),
          )
        : null;
    const outcome = yield* runStarsShadowPass({
      mode: "manual",
      now,
      staleAfterMs,
      ...(live !== null && live.ok
        ? {
            performed: {
              filed: live.summary.filed,
              swept: live.summary.swept,
            },
          }
        : {}),
    }).pipe(
      Effect.provide(platform),
      Effect.map((report) => ({ ok: true as const, report })),
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false as const,
          error: String(cause).slice(0, 500),
        }),
      ),
    );
    return json(
      live === null ? outcome : { ...outcome, live },
      outcome.ok ? 200 : 500,
    );
  });

/** The star detector's notebook (last report), same gate. */
const serveStarsStatus = (
  env: Env,
  request: Request,
  url: URL,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (!(yield* isValidToken(env, gateToken(request, url)))) {
      return fail(404, "not found");
    }
    const stub = env.StarsShadow.get(
      env.StarsShadow.idFromName("stars-shadow-v1"),
    );
    const response = yield* Effect.promise(() =>
      stub.fetch(new Request("http://stars-shadow/status")),
    );
    if (!response.ok) return fail(500, "stars status unavailable");
    return new Response(response.body, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });

/**
 * Manual trigger for one archive-sweep pass (§4.3 step 4), same
 * device-token gate — parity tooling: in shadow mode it diffs the
 * census slice named by `?offset=`/`?limit=` (defaults 0/500);
 * in live mode it performs one pass (frontier first, then the
 * round-robin slice) with `?limit=` as the work bound.
 * `?staleMinutes=N` (default 60) is the pending grace for young
 * captures.
 */
const serveArchiveRun = (
  env: Env,
  request: Request,
  url: URL,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (!(yield* isValidToken(env, gateToken(request, url)))) {
      return fail(404, "not found");
    }
    const now = new Date();
    const limitRaw = Number(url.searchParams.get("limit") ?? "500");
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.floor(limitRaw)
        : 500;
    const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
    const offset =
      Number.isFinite(offsetRaw) && offsetRaw >= 0
        ? Math.floor(offsetRaw)
        : 0;
    const staleMinutes = Number(url.searchParams.get("staleMinutes") ?? "60");
    const staleAfterMs =
      (Number.isFinite(staleMinutes) && staleMinutes > 0
        ? staleMinutes
        : 60) * 60_000;
    const outcome = yield* runArchivePass({
      mode: "manual",
      now,
      limit,
      offset,
      staleAfterMs,
      perform: archiveMode(env) === "live",
    }).pipe(
      Effect.provide(stagePlatform(env)),
      Effect.map((report) => ({ ok: true as const, report })),
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false as const,
          error: String(cause).slice(0, 500),
        }),
      ),
    );
    return json(outcome, outcome.ok ? 200 : 500);
  });

/** The archive sweep's notebook (last report), same gate. */
const serveArchiveStatus = (
  env: Env,
  request: Request,
  url: URL,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (!(yield* isValidToken(env, gateToken(request, url)))) {
      return fail(404, "not found");
    }
    const stub = env.ArchiveShadow.get(
      env.ArchiveShadow.idFromName("archive-shadow-v1"),
    );
    const response = yield* Effect.promise(() =>
      stub.fetch(new Request("http://archive-shadow/status")),
    );
    if (!response.ok) return fail(500, "archive status unavailable");
    return new Response(response.body, {
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
  if (request.method === "GET" && url.pathname === "/shadow/status") {
    return serveShadowStatus(env, request, url);
  }
  if (request.method === "POST" && url.pathname === "/shadow/run") {
    return serveShadowRun(env, request, url);
  }
  if (request.method === "GET" && url.pathname === "/capture/status") {
    return serveCaptureStatus(env, request, url);
  }
  if (request.method === "POST" && url.pathname === "/capture/run") {
    return serveCaptureRun(env, request, url);
  }
  if (request.method === "GET" && url.pathname === "/stars/status") {
    return serveStarsStatus(env, request, url);
  }
  if (request.method === "POST" && url.pathname === "/stars/run") {
    return serveStarsRun(env, request, url);
  }
  if (request.method === "GET" && url.pathname === "/archive/status") {
    return serveArchiveStatus(env, request, url);
  }
  if (request.method === "POST" && url.pathname === "/archive/run") {
    return serveArchiveRun(env, request, url);
  }
  if (request.method === "POST" && url.pathname === "/journal/refresh") {
    return serveJournalRefresh(env, request, url);
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
  // Journal serving (migration milestone 4, §4.3 step 1): the read
  // surface over the same bucket, gated by the same token registry.
  // handleJournal returns null for paths outside the journal family.
  return Effect.flatMap(
    handleJournal(request, env.ARTIFACTS, (token) =>
      isValidToken(env, token),
    ),
    (response) => Effect.succeed(response ?? fail(404, "not found")),
  );
};

interface ScheduledControllerLike {
  readonly cron: string;
  readonly scheduledTime: number;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return Effect.runPromise(handle(request, env));
  },

  /**
   * Cron Trigger (every minute, declared on the Worker in
   * alchemy.run.ts): one shadow discovery pass. Failures are logged
   * and swallowed — a shadow must never disturb anything, and the
   * next minute's pass self-heals.
   */
  scheduled(
    controller: ScheduledControllerLike,
    env: Env,
    ctx: ExecutionContextLike,
  ): void {
    const ranAt = new Date(controller.scheduledTime).toISOString();
    ctx.waitUntil(
      Effect.runPromise(
        runShadowDiscovery(env, ranAt).pipe(
          Effect.catch((cause) =>
            Effect.logError("shadow discovery pass failed", cause),
          ),
        ),
      ),
    );
    // Journal read-model snapshot (§4.3): keep the persisted
    // snapshot the journal routes serve from current with the
    // corpus, so a journal request never pays the corpus gather
    // (the ~30–95 s scan that put the SPA into its error state).
    // The refresh rebuilds only when the inputs fingerprint moved.
    // Same failure posture as the shadow: log and swallow, the
    // next minute's pass self-heals.
    ctx.waitUntil(
      Effect.runPromise(
        refreshReadModelSnapshot(env.ARTIFACTS).pipe(
          Effect.catch((cause) =>
            Effect.logError("read-model snapshot refresh failed", cause),
          ),
        ),
      ),
    );
    // The capture loop (§4.3 step 2). In live mode (the step-2
    // cutover) each tick first PERFORMS the trailing 24 hours'
    // unreceipted items — receipt, artifacts, index registrations,
    // the coalesced latest-location write — at the server's per-pass
    // pacing, and then DIFFS the trailing 75 minutes against reality
    // into the notebook, exactly as the shadow always did: the diff
    // is now the flipped pipeline's own verification, and medina-dev
    // registering again would show up in it as foreign receipts. In
    // shadow mode only the diff runs. A failed live half never blocks
    // the diff, and either half's failure is logged and swallowed —
    // the next minute's pass self-heals.
    const windowTo = new Date(controller.scheduledTime);
    const windowFrom = new Date(
      controller.scheduledTime - 75 * 60 * 1000,
    );
    const platform = capturePlatformLayer(captureEnv(env));
    ctx.waitUntil(
      Effect.runPromise(
        Effect.gen(function* () {
          let performed:
            | Readonly<Record<string, number>>
            | undefined;
          if (captureEnv(env).loopMode === "live") {
            const summary = yield* runCaptureLivePass({
              windowFrom: new Date(
                controller.scheduledTime - 24 * 60 * 60 * 1000,
              ),
              windowTo,
              perSourceLimit: 25,
            }).pipe(
              Effect.catch((cause) =>
                Effect.logError("capture live pass failed", cause).pipe(
                  Effect.as(null),
                ),
              ),
            );
            if (summary !== null) {
              performed = summary.performed;
              yield* Effect.logInfo(
                `capture live pass: performed ` +
                  Object.entries(summary.performed)
                    .map(([name, n]) => `${name} ${n}`)
                    .join(", ") +
                  ` (${summary.alreadyReceipted} already receipted, ${summary.errors.length} errors)`,
              );
              for (const error of summary.errors) {
                yield* Effect.logError(
                  `capture live item failed: ${error.source} ${error.key}: ${error.detail}`,
                );
              }
            }
          }
          const report = yield* runCaptureShadowPass({
            mode: "cron",
            windowFrom,
            windowTo,
            staleAfterMs: 15 * 60 * 1000,
            ...(performed === undefined
              ? {}
              : {
                  performed: performed as Readonly<
                    Record<
                      "capture-bucket" | "device-events" | "local-transcripts",
                      number
                    >
                  >,
                }),
          });
          yield* Effect.logInfo(
            `capture shadow pass: checked ${report.checked}/${report.inWindow} in window, ` +
              Object.entries(report.sources)
                .map(
                  ([name, c]) =>
                    `${name} matched ${c.matched}/${c.classified} (pending ${c.pending}, mismatched ${c.mismatched})`,
                )
                .join("; "),
          );
        }).pipe(
          Effect.provide(platform),
          Effect.catch((cause) =>
            Effect.logError("capture loop pass failed", cause),
          ),
        ),
      ),
    );
    // The star detector (§4.3 step 3): rides the same Cron Trigger
    // — the server's 90-second cadence becomes the cron's minute,
    // which the plan accepts. In live mode each tick first performs
    // the plan (filings, then the retention sweep) and then diffs
    // the result into the notebook; in shadow mode only the diff
    // runs. Failures are logged and swallowed, as with every pass
    // here — the next tick self-heals.
    const starsNow = new Date(controller.scheduledTime);
    ctx.waitUntil(
      Effect.runPromise(
        Effect.gen(function* () {
          let performed: { filed: number; swept: number } | undefined;
          if (starsMode(env) === "live") {
            const summary = yield* runStarsLivePass({
              now: starsNow,
            }).pipe(
              Effect.catch((cause) =>
                Effect.logError("star detector live pass failed", cause).pipe(
                  Effect.as(null),
                ),
              ),
            );
            if (summary !== null) {
              performed = { filed: summary.filed, swept: summary.swept };
              yield* Effect.logInfo(
                `star detector live pass: filed ${summary.filed}, swept ${summary.swept}, born-expired ${summary.bornExpired}` +
                  (summary.failure !== null
                    ? `, stopped early: ${summary.failure}`
                    : ""),
              );
            }
          }
          const report = yield* runStarsShadowPass({
            mode: "cron",
            now: starsNow,
            staleAfterMs: 15 * 60 * 1000,
            ...(performed === undefined ? {} : { performed }),
          });
          yield* Effect.logInfo(
            `star detector shadow pass: ${report.commands} commands, filings matched ${report.filingsMatched}/${report.filings} ` +
              `(pending ${report.filingsPending}, mismatched ${report.filingsMismatched}), server-only ${report.serverOnly}, ` +
              `sweeps planned ${report.sweepPlanned} (pending ${report.sweepPending}, missed ${report.sweepMismatched}), ` +
              `index built ${report.indexBuiltAt ?? "none"}`,
          );
        }).pipe(
          Effect.provide(stagePlatform(env)),
          Effect.catch((cause) =>
            Effect.logError("star detector pass failed", cause),
          ),
        ),
      ),
    );
    // The archive sweep (§4.3 step 4): a bounded slice per tick.
    // Live mode performs (receipt-less captures first, then the
    // round-robin re-verification slice); shadow mode diffs the
    // rotating slice, so full-census coverage accumulates in the
    // notebook. Same failure posture: log and swallow.
    const archiveNow = new Date(controller.scheduledTime);
    ctx.waitUntil(
      Effect.runPromise(
        runArchivePass({
          mode: "cron",
          now: archiveNow,
          limit: 200,
          staleAfterMs: 60 * 60 * 1000,
          perform: archiveMode(env) === "live",
        }).pipe(
          Effect.tap((report) =>
            Effect.logInfo(
              `archive sweep pass (${archiveMode(env)}): checked ${report.checked}/${report.totalCaptures} captures, ` +
                `matched ${report.matched}, ghosts ${report.ghosts}, pending ${report.pending}, mismatched ${report.mismatched}, ` +
                `would-upload ${report.wouldUpload}, performed ${report.performedReceipts} receipts / ${report.performedCopies} copies, ` +
                `errors ${report.errors.length}`,
            ),
          ),
          Effect.provide(stagePlatform(env)),
          Effect.catch((cause) =>
            Effect.logError("archive sweep pass failed", cause),
          ),
        ),
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// ShadowDiscovery: the shadow's notebook. One instance ("shadow-v1")
// holds every classified object's first sighting plus run bookkeeping,
// in its own SQLite storage — the only state the shadow writes.
// ---------------------------------------------------------------------------

interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>;
  readonly rowsWritten: number;
}

interface SqlStorageLike {
  exec(
    query: string,
    ...bindings: Array<unknown>
  ): SqlCursorLike;
}

interface DurableObjectStateLike {
  readonly storage: { readonly sql: SqlStorageLike };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

interface ShadowRunPayload {
  readonly ranAt?: unknown;
  readonly items?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export class ShadowDiscovery {
  private readonly sql: SqlStorageLike;

  constructor(state: DurableObjectStateLike) {
    this.sql = state.storage.sql;
    // Schema setup is part of construction: no request is served
    // until the tables exist.
    void state.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS seen (
           key TEXT PRIMARY KEY,
           source TEXT NOT NULL,
           size INTEGER,
           etag TEXT,
           last_modified TEXT,
           first_seen_at TEXT NOT NULL
         )`,
      );
      this.sql.exec(
        `CREATE INDEX IF NOT EXISTS seen_first_seen
           ON seen (first_seen_at DESC)`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (
           k TEXT PRIMARY KEY,
           v TEXT NOT NULL
         )`,
      );
    });
  }

  private getMeta(key: string): string | null {
    const rows = this.sql
      .exec(`SELECT v FROM meta WHERE k = ?`, key)
      .toArray();
    return rows.length === 0 ? null : asString(rows[0]["v"]);
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES (?, ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      key,
      value,
    );
  }

  /** Record one pass's classified sightings; first sightings stick. */
  private recordRun(payload: ShadowRunPayload): Response {
    const ranAt = asString(payload.ranAt) ?? new Date().toISOString();
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    // Bookkeeping first: a batch interrupted mid-way (CPU limit,
    // isolate eviction) must still leave a trace that the pass ran —
    // otherwise a dying pass is indistinguishable from a cron that
    // never fired.
    const runCount = Number(this.getMeta("run_count") ?? "0") + 1;
    if (this.getMeta("started_at") === null) {
      this.setMeta("started_at", ranAt);
    }
    this.setMeta("run_count", String(runCount));
    this.setMeta("last_run_at", ranAt);
    this.setMeta("last_run_items", String(rawItems.length));
    // New sightings = the seen-count delta across the batch. (The SQL
    // cursor's rowsWritten counts index entries too, so it overstates
    // inserts into an indexed table.)
    const countBefore = this.seenCount();
    for (const raw of rawItems) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const key = asString(item["key"]);
      const source = asString(item["source"]);
      if (key === null || source === null) continue;
      this.sql.exec(
        `INSERT INTO seen (key, source, size, etag, last_modified, first_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO NOTHING`,
        key,
        source,
        asNumber(item["size"]),
        asString(item["etag"]),
        asString(item["lastModified"]),
        ranAt,
      );
    }
    const total = this.seenCount();
    const inserted = total - countBefore;
    this.setMeta("last_run_new", String(inserted));
    return json({ ok: true, inserted, total });
  }

  private seenCount(): number {
    const rows = this.sql.exec(`SELECT COUNT(*) AS n FROM seen`).toArray();
    return asNumber(rows[0]?.["n"]);
  }

  private status(): Response {
    const counts: Record<string, number> = {};
    for (const row of this.sql
      .exec(`SELECT source, COUNT(*) AS n FROM seen GROUP BY source`)
      .toArray()) {
      const source = asString(row["source"]);
      if (source !== null) counts[source] = asNumber(row["n"]);
    }
    const recent = this.sql
      .exec(
        `SELECT key, source, size, last_modified, first_seen_at
           FROM seen
           ORDER BY first_seen_at DESC, key DESC
           LIMIT 20`,
      )
      .toArray()
      .map((row) => ({
        key: asString(row["key"]),
        source: asString(row["source"]),
        size: asNumber(row["size"]),
        lastModified: asString(row["last_modified"]),
        firstSeenAt: asString(row["first_seen_at"]),
      }));
    const totalRows = this.sql
      .exec(`SELECT COUNT(*) AS n FROM seen`)
      .toArray();
    return json({
      startedAt: this.getMeta("started_at"),
      lastRunAt: this.getMeta("last_run_at"),
      runCount: Number(this.getMeta("run_count") ?? "0"),
      lastRunNew: Number(this.getMeta("last_run_new") ?? "0"),
      lastRunItems: Number(this.getMeta("last_run_items") ?? "0"),
      totalSeen: asNumber(totalRows[0]?.["n"]),
      counts,
      recent,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/run") {
      const payload = (await request
        .json()
        .catch(() => ({}))) as ShadowRunPayload;
      return this.recordRun(payload);
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return this.status();
    }
    return fail(404, "not found");
  }
}
