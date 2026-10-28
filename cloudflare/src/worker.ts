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

interface R2ListedObjectLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
}

interface R2ListPageLike {
  readonly objects: ReadonlyArray<R2ListedObjectLike>;
  readonly truncated: boolean;
  readonly cursor?: string;
}

interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  list(options: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
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
