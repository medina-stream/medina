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
 * `Authorization: Bearer <INDEX_API_TOKEN>` (a Worker secret).
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

interface Env {
  readonly INDEX: DurableObjectNamespace
  readonly INDEX_API_TOKEN: string
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const fail = (status: number, message: string): Response => json({ error: message }, status)

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
