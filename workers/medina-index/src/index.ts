/**
 * medina-index: the Durable Object index for Medina's artifact bucket.
 *
 * Bucket-first persistence (lib/ArtifactStore.ts) keeps artifact bytes in
 * an S3 bucket, but listings and latest-pointers are index questions, not
 * bucket scans. This worker is that index: one Durable Object with SQLite
 * storage holding a row per artifact key (size, content hash, update
 * time) and a row per latest-pointer group. The Medina server is the
 * only client; it writes through the ArtifactStore, which registers
 * every put and unregisters every delete, so the index is complete by
 * construction for anything the store wrote. Objects that land in the
 * bucket any other way are invisible to listings until something
 * registers them (the migration tool does, for the whole tree).
 *
 * Auth: every endpoint except /health requires
 * `Authorization: Bearer <INDEX_API_TOKEN>` (a Worker secret) — except
 * the two public device routes, which authenticate differently:
 * `/bucket-capture/<stamp>.apk` serves public artifacts (APKs carry no
 * credentials), and `/api/capture-policy/<token>` is gated by the
 * per-device capability token in its path, verified against the token
 * registry the Medina server mirrors into the bucket. Both exist so a
 * phone on any network can fetch its policy and its updates without
 * reaching the Medina host (no tailnet DNS, no exe.dev login gate).
 */

// Minimal structural types for the Workers runtime surface this file
// uses, so the file stands alone without @cloudflare/workers-types.
interface SqlStorage {
  exec(query: string, ...params: Array<unknown>): { toArray(): Array<Record<string, unknown>> }
}

interface DurableObjectStorage {
  readonly sql: SqlStorage
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}

/** The slice of the R2 bucket binding this worker uses: reads only. */
interface R2ObjectLike {
  readonly body: ReadableStream
  readonly size: number
  readonly httpEtag: string
}

interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>
}

interface Env {
  readonly INDEX: DurableObjectNamespace
  readonly INDEX_API_TOKEN: string
  readonly BUCKET: R2BucketLike
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const fail = (status: number, message: string): Response => json({ error: message }, status)

/** SHA-256 hex of a string — the same digest the Medina server stores
 * per capability token in the registry. */
const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

const APK_CONTENT_TYPE = "application/vnd.android.package-archive"
const POLICY_OBJECT_KEY = "capture-policy/policy.json"
const TOKENS_OBJECT_KEY = "capture-policy/tokens.json"

/**
 * Public: a published recorder APK (`/bucket-capture/<stamp>.apk`).
 * APKs carry no credentials — the policy URL is entered per-device —
 * so they are served to anyone, by exact stamp only.
 */
const serveApk = async (env: Env, name: string): Promise<Response> => {
  const match = /^(0\d{12})\.apk$/.exec(name)
  if (match === null) return fail(404, "not found")
  const object = await env.BUCKET.get(`bucket-capture/${match[1]}.apk`)
  if (object === null) return fail(404, "not found")
  return new Response(object.body, {
    headers: {
      "content-type": APK_CONTENT_TYPE,
      "content-length": String(object.size),
      "cache-control": "public, max-age=31536000, immutable",
      etag: object.httpEtag
    }
  })
}

interface TokenRegistryEntry {
  readonly hash?: unknown
  readonly revokedAt?: unknown
}

/**
 * Public: the capture policy, gated by its capability token
 * (`/api/capture-policy/<token>` — the same shape as the Medina
 * server's route). The document and the token registry (hashes only)
 * live in the bucket, written by the Medina server, so a phone on any
 * network can fetch its policy without reaching the server host —
 * no tailnet DNS, no exe.dev login gate. Unknown or revoked tokens
 * get the same 404 the server gives; the app treats it as terminal.
 */
const servePolicy = async (env: Env, token: string): Promise<Response> => {
  if (!token.startsWith("cpol_") || token.includes("/")) return fail(404, "not found")
  const registryObject = await env.BUCKET.get(TOKENS_OBJECT_KEY)
  if (registryObject === null) return fail(404, "not found")
  let tokens: Array<TokenRegistryEntry>
  try {
    const parsed = (await new Response(registryObject.body).json()) as { tokens?: unknown }
    if (!Array.isArray(parsed.tokens)) return fail(404, "not found")
    tokens = parsed.tokens as Array<TokenRegistryEntry>
  } catch {
    return fail(404, "not found")
  }
  const hash = await sha256Hex(token)
  const known = tokens.some((entry) => entry.revokedAt === null && entry.hash === hash)
  if (!known) return fail(404, "not found")
  const policyObject = await env.BUCKET.get(POLICY_OBJECT_KEY)
  if (policyObject === null) return fail(500, "policy unavailable")
  return new Response(policyObject.body, {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  })
}

/** Artifact keys only: relative, no traversal — the same rule as
 * lib/ArtifactKey.ts on the server side. */
const validKey = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 &&
  !value.startsWith("/") && !value.split("/").includes("..")

const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const parsed = (await request.json()) as unknown
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export class MedinaIndex {
  private readonly sql: SqlStorage

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS objects (
         key TEXT PRIMARY KEY,
         size INTEGER,
         hash TEXT,
         updated_at TEXT NOT NULL
       )`
    )
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS latest (
         grp TEXT PRIMARY KEY,
         key TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`
    )
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (`${request.method} ${url.pathname}`) {
      case "POST /register": {
        const body = await readBody(request)
        if (body === null || !validKey(body.key)) return fail(400, "register requires a valid key")
        const size = typeof body.size === "number" ? body.size : null
        const hash = typeof body.hash === "string" ? body.hash : null
        const updatedAt = typeof body.updatedAt === "string" ? body.updatedAt : new Date().toISOString()
        this.sql.exec(
          `INSERT INTO objects (key, size, hash, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET size = excluded.size, hash = excluded.hash, updated_at = excluded.updated_at`,
          body.key, size, hash, updatedAt
        )
        return json({ ok: true })
      }
      case "POST /unregister": {
        const body = await readBody(request)
        if (body === null || !validKey(body.key)) return fail(400, "unregister requires a valid key")
        this.sql.exec(`DELETE FROM objects WHERE key = ?`, body.key)
        return json({ ok: true })
      }
      case "GET /list": {
        const prefix = url.searchParams.get("prefix") ?? ""
        // Directory-boundary semantics, matching the store contract: a
        // key matches when it equals the prefix or lives beneath it.
        const rows = this.sql.exec(
          `SELECT key FROM objects
           WHERE ? = '' OR key = ? OR substr(key, 1, length(?) + 1) = ? || '/'
           ORDER BY key ASC`,
          prefix, prefix, prefix, prefix
        ).toArray()
        return json({ keys: rows.map((row) => row.key) })
      }
      case "GET /latest": {
        const group = url.searchParams.get("group")
        if (group === null || group === "") return fail(400, "latest requires a group")
        const rows = this.sql.exec(`SELECT key FROM latest WHERE grp = ?`, group).toArray()
        return json({ key: rows.length > 0 ? rows[0]!.key : null })
      }
      case "PUT /latest": {
        const body = await readBody(request)
        if (body === null || typeof body.group !== "string" || body.group === "" || !validKey(body.key)) {
          return fail(400, "latest requires a group and a valid key")
        }
        this.sql.exec(
          `INSERT INTO latest (grp, key, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(grp) DO UPDATE SET key = excluded.key, updated_at = excluded.updated_at`,
          body.group, body.key, new Date().toISOString()
        )
        return json({ ok: true })
      }
      default:
        return fail(404, "not found")
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") return json({ ok: true })
    // Public device routes, ahead of the index token gate: APK
    // downloads (public artifacts) and the capability-gated policy
    // fetch. Both read the artifact bucket; neither touches the index.
    if (request.method === "GET" && url.pathname.startsWith("/bucket-capture/")) {
      return serveApk(env, url.pathname.slice("/bucket-capture/".length))
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/capture-policy/")) {
      return servePolicy(env, decodeURIComponent(url.pathname.slice("/api/capture-policy/".length)))
    }
    const authorization = request.headers.get("authorization") ?? ""
    if (env.INDEX_API_TOKEN === "" || authorization !== `Bearer ${env.INDEX_API_TOKEN}`) {
      return fail(401, "unauthorized")
    }
    // One global index instance: the registry is a singleton, and the
    // DO's serialized execution is what makes concurrent writers safe.
    const stub = env.INDEX.get(env.INDEX.idFromName("global"))
    return stub.fetch(request)
  }
}
