/**
 * The artifact store: bucket-first persistence for Medina's data dir.
 *
 * Medina modules exchange relative artifact keys (see ArtifactKey.ts).
 * This service is the one boundary that stores bytes under those keys.
 * The interface has no filesystem semantics at all — no directories, no
 * rename, no paths — so implementations can be a local directory (dev,
 * tests, and the migration source), an in-memory map (tests), or an S3
 * bucket indexed by the medina-index Durable Object (production).
 *
 * Listings and latest-pointers are index operations, never bucket scans:
 * the bucket implementation reads them from the index client, and every
 * write registers itself, so the index is complete by construction for
 * anything written through the store. S3 listing survives only as
 * `listDirect` on the raw object API, a bootstrap/reconciliation path for
 * the migration tool — the store contract never calls it.
 *
 * `Files.ts` is the compatibility seam: its path-based helpers consult
 * this service (via `keyForPath`) when one is in context, so existing
 * resource code keeps calling `Files.readJson(dataPath(key), …)` and the
 * store selection is a layer-provision decision only. Code with no store
 * in context gets plain filesystem behavior, unchanged.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3"
import { open } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { artifactPath, key as artifactKey } from "./ArtifactKey.ts"
import { sha256 } from "./Hash.ts"

export type { ArtifactKey } from "./ArtifactKey.ts"
export { artifactPath, key } from "./ArtifactKey.ts"

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))

export interface ArtifactHead {
  readonly size: number | null
  /** Store-reported etag, when it reports one (S3 etag; md5 hex in memory). */
  readonly etag: string | null
}

export interface ArtifactStoreApi {
  /** The local root artifact paths are translated against. Lexical only:
   * for the bucket store this string is never touched on disk; it is the
   * DATA_DIR the deployment's `dataPath()` strings are built from. */
  readonly root: string
  /** Host path for a key under `root`. Lexical for the bucket store. */
  readonly path: (value: string) => string
  /** The artifact key a host path names, or null when the path is not
   * under `root`. Pure string work; the Files.ts seam depends on it. */
  readonly keyForPath: (path: string) => string | null
  readonly putBytes: (key: string, bytes: Uint8Array, contentType?: string) => Effect.Effect<void, Error>
  readonly putText: (key: string, text: string) => Effect.Effect<void, Error>
  /** Store a file from disk without loading it into memory: capture blobs
   * can be hundreds of MB. Mirrors the putFile on lib/Bucket.ts's API. */
  readonly putFile: (key: string, path: string, contentType?: string) => Effect.Effect<void, Error>
  readonly getBytes: (key: string) => Effect.Effect<Option.Option<Uint8Array>, Error>
  readonly getText: (key: string) => Effect.Effect<Option.Option<string>, Error>
  readonly head: (key: string) => Effect.Effect<Option.Option<ArtifactHead>, Error>
  readonly exists: (key: string) => Effect.Effect<boolean, Error>
  /** Full keys under `prefix`, sorted. Prefixes are directory-like: a key
   * matches when it equals the prefix or starts with `prefix + "/"`; the
   * empty prefix lists everything. */
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<string>, Error>
  /** Idempotent: deleting an absent key succeeds. */
  readonly delete: (key: string) => Effect.Effect<void, Error>
  /** Latest-pointer groups: small named pointers at "the current key for
   * X", for consumers that need a stable name over generations of
   * content/basis-keyed artifacts. */
  readonly getLatest: (group: string) => Effect.Effect<Option.Option<string>, Error>
  readonly setLatest: (group: string, key: string) => Effect.Effect<void, Error>
  readonly readJson: <S extends Schema.Codec<any, any>>(
    schema: S,
    key: string
  ) => Effect.Effect<Option.Option<S["Type"]>, Error>
  readonly writeJson: (key: string, value: unknown) => Effect.Effect<void, Error>
}

export class ArtifactStore extends Context.Service<ArtifactStore, ArtifactStoreApi>()("medina/ArtifactStore") {}

/** Directory-boundary prefix match, shared by every list implementation. */
export const keyMatchesPrefix = (key: string, prefix: string): boolean =>
  prefix === "" || key === prefix || key.startsWith(`${prefix}/`)

const keyForPathIn = (root: string) => (path: string): string | null => {
  const absRoot = resolve(root)
  const abs = resolve(path)
  if (abs === absRoot) return ""
  return abs.startsWith(absRoot + sep) ? abs.slice(absRoot.length + 1).split(sep).join("/") : null
}

const jsonOps = (api: Pick<ArtifactStoreApi, "getText" | "putText">): Pick<ArtifactStoreApi, "readJson" | "writeJson"> => ({
  readJson: (schema, key) =>
    Effect.gen(function*() {
      const text = yield* api.getText(key)
      if (Option.isNone(text)) return Option.none()
      return Option.some(yield* Schema.decodeUnknownEffect(schema)(JSON.parse(text.value)))
    }).pipe(Effect.mapError(asError)),
  // Same 2-space formatting as Files.writeJson, so bytes on disk do not
  // change when a deployment flips stores.
  writeJson: (key, value) => api.putText(key, JSON.stringify(value, null, 2))
})

const contentTypeFor = (key: string, fallback: string): string => {
  if (key.endsWith(".json")) return "application/json"
  if (key.endsWith(".m4a")) return "audio/mp4"
  if (key.endsWith(".ogg")) return "audio/ogg"
  if (key.endsWith(".sqlite")) return "application/vnd.sqlite3"
  if (key.endsWith(".ndjson")) return "application/x-ndjson"
  if (key.endsWith(".md") || key.endsWith(".txt")) return "text/plain"
  return fallback
}

// --- local store ---------------------------------------------------------------

/**
 * The filesystem implementation: a plain directory tree under `root`,
 * with the same atomic-write discipline as Files.writeJson (tmp + rename,
 * so readers never see partial files). This is the dev/test store and the
 * source side of the bucket migration.
 */
export const makeLocal = (
  root: string
): Effect.Effect<ArtifactStoreApi, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = (value: string) => artifactPath(root, value)
    const fail = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(asError))

    const writeAtomic = (file: string, write: (tmp: string) => Effect.Effect<void, Error>) =>
      Effect.gen(function*() {
        const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
        yield* fail(fs.makeDirectory(dirname(file), { recursive: true }))
        yield* write(tmp).pipe(
          Effect.onError(() => fs.remove(tmp, { force: true }).pipe(Effect.ignore))
        )
        yield* fail(fs.rename(tmp, file))
      })

    const putText = (value: string, text: string) =>
      writeAtomic(path(value), (tmp) => fail(fs.writeFileString(tmp, text)))
    const putBytes = (value: string, bytes: Uint8Array) =>
      writeAtomic(path(value), (tmp) => fail(fs.writeFile(tmp, bytes)))

    const api: ArtifactStoreApi = {
      root,
      path,
      keyForPath: keyForPathIn(root),
      putBytes: (value, bytes) => putBytes(value, bytes),
      putText,
      // Copied, never loaded: capture blobs can be hundreds of MB and
      // ingest streams them to disk precisely to keep them out of memory.
      putFile: (value, source) =>
        writeAtomic(path(value), (tmp) => fail(fs.copyFile(source, tmp))),
      getBytes: (value) =>
        Effect.gen(function*() {
          const file = path(value)
          if (!(yield* fail(fs.exists(file)))) return Option.none()
          return Option.some(yield* fail(fs.readFile(file)))
        }),
      getText: (value) =>
        Effect.gen(function*() {
          const file = path(value)
          if (!(yield* fail(fs.exists(file)))) return Option.none()
          return Option.some(yield* fail(fs.readFileString(file)))
        }),
      head: (value) =>
        Effect.gen(function*() {
          const file = path(value)
          if (!(yield* fail(fs.exists(file)))) return Option.none()
          const info = yield* fail(fs.stat(file))
          return Option.some({ size: Number(info.size), etag: null })
        }),
      exists: (value) => fail(fs.exists(path(value))),
      list: (prefix) =>
        Effect.gen(function*() {
          const dir = path(prefix === "" ? "." : prefix)
          if (!(yield* fail(fs.exists(dir)))) return []
          const entries = yield* fail(fs.readDirectory(dir, { recursive: true }))
          const directories = new Set<string>()
          for (const entry of entries) {
            const parent = dirname(entry)
            if (parent !== ".") directories.add(parent)
          }
          return entries
            .filter((entry) => !directories.has(entry) && !/\.tmp-[^/]*$/.test(entry))
            .map((entry) => (prefix === "" ? entry : `${prefix}/${entry}`))
            .sort()
        }),
      delete: (value) => fail(fs.remove(path(value), { force: true })),
      getLatest: (group) =>
        Effect.gen(function*() {
          const file = path(`latest/${artifactKey(group)}.json`)
          if (!(yield* fail(fs.exists(file)))) return Option.none()
          const parsed = JSON.parse(yield* fail(fs.readFileString(file))) as { key?: unknown }
          return typeof parsed.key === "string" ? Option.some(parsed.key) : Option.none()
        }),
      setLatest: (group, value) =>
        putText(
          `latest/${artifactKey(group)}.json`,
          JSON.stringify({ key: value, updatedAt: new Date().toISOString() }, null, 2)
        ),
      readJson: () => Effect.fail(new Error("unreachable")),
      writeJson: () => Effect.fail(new Error("unreachable"))
    }
    return { ...api, ...jsonOps(api) }
  })

export const layerLocal = (root: string): Layer.Layer<ArtifactStore, never, FileSystem.FileSystem> =>
  Layer.effect(ArtifactStore)(makeLocal(root))

/** Back-compat name: the store layer over a local root. */
export const layer = layerLocal

// --- in-memory store -------------------------------------------------------------

const md5Hex = (bytes: Uint8Array) => {
  const hasher = new Bun.CryptoHasher("md5")
  hasher.update(bytes)
  return hasher.digest("hex")
}

export interface MemoryStore {
  readonly api: ArtifactStoreApi
  readonly objects: Map<string, Uint8Array>
  readonly latest: Map<string, string>
}

/**
 * The in-memory implementation, for tests: the same contract over Maps.
 * `pathRoot` is the lexical root `keyForPath`/`path` translate against
 * (tests pass the temp DATA_DIR so Files.ts seam calls route here).
 */
export const makeMemory = (pathRoot = "data/artifacts"): MemoryStore => {
  const objects = new Map<string, Uint8Array>()
  const latest = new Map<string, string>()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const api: ArtifactStoreApi = {
    root: pathRoot,
    path: (value) => artifactPath(pathRoot, value),
    keyForPath: keyForPathIn(pathRoot),
    putBytes: (value, bytes) => Effect.sync(() => { objects.set(artifactKey(value), bytes.slice()) }),
    putText: (value, text) => Effect.sync(() => { objects.set(artifactKey(value), encoder.encode(text)) }),
    putFile: (value, source) =>
      Effect.tryPromise({
        try: async () => { objects.set(artifactKey(value), new Uint8Array(await Bun.file(source).arrayBuffer())) },
        catch: asError
      }),
    getBytes: (value) =>
      Effect.sync(() => {
        const bytes = objects.get(artifactKey(value))
        return bytes === undefined ? Option.none() : Option.some(bytes.slice())
      }),
    getText: (value) =>
      Effect.sync(() => {
        const bytes = objects.get(artifactKey(value))
        return bytes === undefined ? Option.none() : Option.some(decoder.decode(bytes))
      }),
    head: (value) =>
      Effect.sync(() => {
        const bytes = objects.get(artifactKey(value))
        return bytes === undefined
          ? Option.none()
          : Option.some({ size: bytes.length, etag: md5Hex(bytes) })
      }),
    exists: (value) => Effect.sync(() => objects.has(artifactKey(value))),
    list: (prefix) =>
      Effect.sync(() => [...objects.keys()].filter((k) => keyMatchesPrefix(k, prefix)).sort()),
    delete: (value) => Effect.sync(() => { objects.delete(artifactKey(value)) }),
    getLatest: (group) =>
      Effect.sync(() => {
        const value = latest.get(group)
        return value === undefined ? Option.none() : Option.some(value)
      }),
    setLatest: (group, value) => Effect.sync(() => { latest.set(group, value) }),
    readJson: () => Effect.fail(new Error("unreachable")),
    writeJson: () => Effect.fail(new Error("unreachable"))
  }
  return { api: { ...api, ...jsonOps(api) }, objects, latest }
}

export const layerMemory = (pathRoot?: string): Layer.Layer<ArtifactStore> =>
  Layer.succeed(ArtifactStore)(makeMemory(pathRoot).api)

// --- the index client ------------------------------------------------------------

export interface IndexRegisterEntry {
  readonly key: string
  readonly size: number | null
  readonly hash?: string | null
}

/**
 * The client half of the medina-index Durable Object (workers/medina-index):
 * the registry of what keys exist, and the latest-pointer groups. The bucket
 * store lists and resolves latest pointers through this client — never
 * through S3 listing.
 */
export interface IndexClientApi {
  /** Idempotent upsert: re-registering a key replaces its entry. */
  readonly register: (entry: IndexRegisterEntry) => Effect.Effect<void, Error>
  /** Idempotent: unregistering an absent key succeeds. */
  readonly unregister: (key: string) => Effect.Effect<void, Error>
  /** Full keys under `prefix` (same directory-boundary semantics as the
   * store's list), sorted. */
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<string>, Error>
  readonly getLatest: (group: string) => Effect.Effect<Option.Option<string>, Error>
  readonly setLatest: (group: string, key: string) => Effect.Effect<void, Error>
}

export type IndexTransport = (url: string, init: RequestInit) => Promise<Response>

export const makeIndexClient = (options: {
  readonly baseUrl: string
  readonly token: string
  readonly transport?: IndexTransport
}): IndexClientApi => {
  const base = options.baseUrl.replace(/\/+$/, "")
  const transport = options.transport ?? ((url, init) => fetch(url, init))
  const send = (method: string, path: string, body?: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const response = await transport(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${options.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        })
        const text = await response.text()
        if (!response.ok) {
          throw new Error(`medina index ${method} ${path} failed: HTTP ${response.status} ${text.slice(0, 200)}`)
        }
        return (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>
      },
      catch: asError
    })
  return {
    register: (entry) =>
      send("POST", "/register", {
        key: entry.key,
        size: entry.size,
        ...(entry.hash === undefined || entry.hash === null ? {} : { hash: entry.hash })
      }).pipe(Effect.asVoid),
    unregister: (key) => send("POST", "/unregister", { key }).pipe(Effect.asVoid),
    list: (prefix) =>
      Effect.map(
        send("GET", `/list?prefix=${encodeURIComponent(prefix)}`),
        (body) => (Array.isArray(body.keys) ? (body.keys as Array<string>) : [])
      ),
    getLatest: (group) =>
      Effect.map(send("GET", `/latest?group=${encodeURIComponent(group)}`), (body) =>
        typeof body.key === "string" ? Option.some(body.key) : Option.none()
      ),
    setLatest: (group, key) => send("PUT", "/latest", { group, key }).pipe(Effect.asVoid)
  }
}

/** The index client over Maps, for tests: the same contract the Worker
 * implements, without HTTP. */
export const makeMemoryIndexClient = (): IndexClientApi & {
  readonly entries: Map<string, IndexRegisterEntry & { readonly updatedAt: string }>
} => {
  const entries = new Map<string, IndexRegisterEntry & { updatedAt: string }>()
  const latest = new Map<string, string>()
  return {
    entries,
    register: (entry) =>
      Effect.sync(() => {
        entries.set(entry.key, {
          key: entry.key,
          size: entry.size,
          hash: entry.hash ?? null,
          updatedAt: new Date().toISOString()
        })
      }),
    unregister: (key) => Effect.sync(() => { entries.delete(key) }),
    list: (prefix) =>
      Effect.sync(() => [...entries.keys()].filter((k) => keyMatchesPrefix(k, prefix)).sort()),
    getLatest: (group) =>
      Effect.sync(() => {
        const value = latest.get(group)
        return value === undefined ? Option.none() : Option.some(value)
      }),
    setLatest: (group, key) => Effect.sync(() => { latest.set(group, key) })
  }
}

// --- the raw object API (S3-shaped) ----------------------------------------------

/**
 * Raw object operations, the S3-shaped half of the bucket store — kept
 * separate from ArtifactStoreApi so tests can fake exactly this surface.
 * `listDirect` is the only S3 listing in the system, and it exists for
 * bootstrap/reconciliation (the migration tool comparing bucket reality
 * against the index), never for serving reads.
 */
export interface ObjectStoreApi {
  /** Resolves to the stored object's etag when the store reports one. */
  readonly put: (key: string, bytes: Uint8Array, contentType?: string) => Effect.Effect<string | null, Error>
  /** Streamed from disk: capture blobs can be hundreds of MB. */
  readonly putFile: (key: string, path: string, contentType?: string) => Effect.Effect<string | null, Error>
  readonly get: (key: string) => Effect.Effect<Option.Option<Uint8Array>, Error>
  /** The object's head, or null when absent. */
  readonly head: (key: string) => Effect.Effect<ArtifactHead | null, Error>
  readonly delete: (key: string) => Effect.Effect<void, Error>
  readonly listDirect: (prefix: string, limit: number) => Effect.Effect<ReadonlyArray<ArtifactHead & { readonly key: string }>, Error>
}

const isNotFound = (cause: unknown): boolean => {
  const status = (cause as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
  const name = (cause as { name?: string }).name
  return status === 404 || name === "NotFound" || name === "NoSuchKey"
}

export const makeS3ObjectStore = (client: S3Client, bucket: string): ObjectStoreApi => ({
  put: (key, bytes, contentType) =>
    Effect.tryPromise({
      try: async () => {
        const response = await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ...(contentType === undefined ? {} : { ContentType: contentType })
        }))
        return response.ETag?.replace(/^"|"$/g, "") ?? null
      },
      catch: asError
    }),

  putFile: (key, path, contentType) =>
    Effect.tryPromise({
      try: async () => {
        // Same approach as lib/Bucket.ts: positional reads into sized
        // buffers (the SDK's node-stream body handling stalls under Bun),
        // one plain put when small, multipart in fixed parts when large.
        const PART = 8 * 1024 * 1024
        const size = (await Bun.file(path).stat()).size
        if (size <= PART) {
          const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
          const response = await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentLength: bytes.length,
            ...(contentType === undefined ? {} : { ContentType: contentType })
          }))
          return response.ETag?.replace(/^"|"$/g, "") ?? null
        }
        const created = await client.send(new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ...(contentType === undefined ? {} : { ContentType: contentType })
        }))
        try {
          const handle = await open(path, "r")
          const parts: Array<{ ETag: string; PartNumber: number }> = []
          try {
            let offset = 0
            while (offset < size) {
              const length = Math.min(PART, size - offset)
              const buffer = Buffer.alloc(length)
              await handle.read(buffer, 0, length, offset)
              const part = await client.send(new UploadPartCommand({
                Bucket: bucket,
                Key: key,
                UploadId: created.UploadId,
                PartNumber: parts.length + 1,
                Body: buffer,
                ContentLength: length
              }))
              if (part.ETag === undefined) throw new Error(`part ${parts.length + 1} returned no etag`)
              parts.push({ ETag: part.ETag, PartNumber: parts.length + 1 })
              offset += length
            }
          } finally {
            await handle.close()
          }
          const completed = await client.send(new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: created.UploadId,
            MultipartUpload: { Parts: parts }
          }))
          return completed.ETag?.replace(/^"|"$/g, "") ?? null
        } catch (cause) {
          await client.send(new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: created.UploadId
          })).catch(() => undefined)
          throw cause
        }
      },
      catch: asError
    }),

  get: (key) =>
    Effect.tryPromise({
      try: async () => {
        try {
          const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
          const body = response.Body
          if (body === undefined) return Option.none<Uint8Array>()
          if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
            return Option.some(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray())
          }
          const chunks: Array<Uint8Array> = []
          for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk)
          return Option.some(Buffer.concat(chunks))
        } catch (cause) {
          if (isNotFound(cause)) return Option.none<Uint8Array>()
          throw cause
        }
      },
      catch: asError
    }),

  head: (key) =>
    Effect.tryPromise({
      try: async () => {
        try {
          const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
          return {
            size: response.ContentLength ?? null,
            etag: response.ETag?.replace(/^"|"$/g, "") ?? null
          }
        } catch (cause) {
          if (isNotFound(cause)) return null
          throw cause
        }
      },
      catch: asError
    }),

  delete: (key) =>
    Effect.tryPromise({
      try: async () => { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })) },
      catch: asError
    }),

  listDirect: (prefix, limit) =>
    Effect.tryPromise({
      try: async () => {
        if (limit <= 0) return []
        const objects: Array<ArtifactHead & { key: string }> = []
        let continuationToken: string | undefined
        do {
          const response = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 1000,
            ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken })
          }))
          objects.push(...(response.Contents ?? []).flatMap((object) => object.Key === undefined ? [] : [{
            key: object.Key,
            size: object.Size ?? null,
            etag: object.ETag?.replace(/^"|"$/g, "") ?? null
          }]))
          continuationToken = response.NextContinuationToken
        } while (continuationToken !== undefined && objects.length < limit)
        return objects.slice(0, limit)
      },
      catch: asError
    })
})

/** The raw object API over a Map, for tests. */
export const makeMemoryObjectStore = (
  store: Map<string, { bytes: Uint8Array; contentType?: string }> = new Map()
): ObjectStoreApi => ({
  put: (key, bytes, contentType) =>
    Effect.sync(() => {
      store.set(key, { bytes: bytes.slice(), ...(contentType === undefined ? {} : { contentType }) })
      return md5Hex(bytes)
    }),
  putFile: (key, path, contentType) =>
    Effect.tryPromise({
      try: async () => {
        const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
        store.set(key, { bytes, ...(contentType === undefined ? {} : { contentType }) })
        return md5Hex(bytes)
      },
      catch: asError
    }),
  get: (key) =>
    Effect.sync(() => {
      const entry = store.get(key)
      return entry === undefined ? Option.none() : Option.some(entry.bytes.slice())
    }),
  head: (key) =>
    Effect.sync(() => {
      const entry = store.get(key)
      return entry === undefined ? null : { size: entry.bytes.length, etag: md5Hex(entry.bytes) }
    }),
  delete: (key) => Effect.sync(() => { store.delete(key) }),
  listDirect: (prefix, limit) =>
    Effect.sync(() =>
      [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, Math.max(0, limit))
        .map(([k, value]) => ({ key: k, size: value.bytes.length, etag: md5Hex(value.bytes) }))
    )
})

// --- the bucket store --------------------------------------------------------------

/**
 * The production store: bytes in an S3 bucket, existence/latest in the
 * medina-index Durable Object. Writes register themselves after the object
 * lands; if registration fails the write fails — the index is the listing
 * source of truth, so a write the index cannot see must not pretend to
 * have succeeded. Reads of bytes go straight to the bucket (the index is
 * never on the content path).
 */
export const makeBucket = (options: {
  readonly objects: ObjectStoreApi
  readonly index: IndexClientApi
  /** Lexical root for path translation (the deployment's DATA_DIR). */
  readonly pathRoot: string
}): ArtifactStoreApi => {
  const { index, objects, pathRoot } = options
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const register = (value: string, size: number, hash?: string) =>
    index.register({ key: value, size, ...(hash === undefined ? {} : { hash }) })

  const api: ArtifactStoreApi = {
    root: pathRoot,
    path: (value) => artifactPath(pathRoot, value),
    keyForPath: keyForPathIn(pathRoot),
    putBytes: (value, bytes, contentType) =>
      Effect.gen(function*() {
        const checked = artifactKey(value)
        yield* objects.put(checked, bytes, contentType ?? contentTypeFor(checked, "application/octet-stream"))
        yield* register(checked, bytes.length, sha256(bytes))
      }),
    putText: (value, text) =>
      Effect.gen(function*() {
        const checked = artifactKey(value)
        const bytes = encoder.encode(text)
        yield* objects.put(checked, bytes, contentTypeFor(checked, "text/plain"))
        yield* register(checked, bytes.length, sha256(bytes))
      }),
    putFile: (value, source, contentType) =>
      Effect.gen(function*() {
        const checked = artifactKey(value)
        yield* objects.putFile(checked, source, contentType ?? contentTypeFor(checked, "application/octet-stream"))
        const head = yield* objects.head(checked)
        yield* register(checked, head?.size ?? 0)
      }),
    getBytes: (value) => objects.get(artifactKey(value)),
    getText: (value) =>
      Effect.map(objects.get(artifactKey(value)), (bytes) =>
        Option.map(bytes, (b) => decoder.decode(b))
      ),
    head: (value) =>
      Effect.map(objects.head(artifactKey(value)), (head) =>
        head === null ? Option.none() : Option.some(head)
      ),
    exists: (value) =>
      Effect.map(objects.head(artifactKey(value)), (head) => head !== null),
    list: (prefix) => index.list(prefix),
    delete: (value) =>
      Effect.gen(function*() {
        const checked = artifactKey(value)
        yield* objects.delete(checked)
        yield* index.unregister(checked)
      }),
    getLatest: (group) => index.getLatest(group),
    setLatest: (group, value) => index.setLatest(group, artifactKey(value)),
    readJson: () => Effect.fail(new Error("unreachable")),
    writeJson: () => Effect.fail(new Error("unreachable"))
  }
  return { ...api, ...jsonOps(api) }
}

// --- configuration -----------------------------------------------------------------

const BUCKET_NOT_CONFIGURED = "artifact bucket is not configured: set ARTIFACT_STORE=bucket with "
  + "ARTIFACT_BUCKET_NAME and ARTIFACT_BUCKET_ENDPOINT (plus ARTIFACT_BUCKET_ACCESS_KEY_ID/"
  + "ARTIFACT_BUCKET_SECRET_ACCESS_KEY unless the endpoint signs at the network edge), "
  + "and MEDINA_INDEX_URL + INDEX_API_TOKEN for the index worker"

const unconfigured = (pathRoot: string): ArtifactStoreApi => {
  const fail = <A>(): Effect.Effect<A, Error> => Effect.fail(new Error(BUCKET_NOT_CONFIGURED))
  return {
    root: pathRoot,
    path: (value) => artifactPath(pathRoot, value),
    keyForPath: keyForPathIn(pathRoot),
    putBytes: () => fail(),
    putText: () => fail(),
    putFile: () => fail(),
    getBytes: () => fail(),
    getText: () => fail(),
    head: () => fail(),
    exists: () => fail(),
    list: () => fail(),
    delete: () => fail(),
    getLatest: () => fail(),
    setLatest: () => fail(),
    readJson: () => fail(),
    writeJson: () => fail()
  }
}

const failingIndex = (): IndexClientApi => {
  const fail = <A>(): Effect.Effect<A, Error> => Effect.fail(new Error(BUCKET_NOT_CONFIGURED))
  return {
    register: () => fail(),
    unregister: () => fail(),
    list: () => fail(),
    getLatest: () => fail(),
    setLatest: () => fail()
  }
}

interface ArtifactBucketConnection {
  readonly bucket: string | null
  readonly endpoint: string | null
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly region: string
  readonly forcePathStyle: boolean
}

/** ARTIFACT_BUCKET_* env, following lib/Bucket.ts's per-prefix convention. */
const readArtifactBucketConnection: Effect.Effect<ArtifactBucketConnection, Config.ConfigError> =
  Effect.gen(function*() {
    const optional = (name: string) =>
      Effect.map(
        Config.option(Config.String(`ARTIFACT_BUCKET_${name}`)),
        (value) => Option.getOrNull(value)?.trim() || null
      )
    return {
      bucket: yield* optional("NAME"),
      endpoint: yield* optional("ENDPOINT"),
      // Keyless is a real configuration (an edge-signing endpoint injects
      // credentials at the network boundary); placeholders stand in, as in
      // lib/Bucket.ts.
      accessKeyId: (yield* optional("ACCESS_KEY_ID")) ?? "edge-injected",
      secretAccessKey: (yield* optional("SECRET_ACCESS_KEY")) ?? "edge-injected",
      region: (yield* optional("REGION")) ?? "auto",
      forcePathStyle: yield* Config.Boolean("ARTIFACT_BUCKET_FORCE_PATH_STYLE").pipe(Config.withDefault(true))
    }
  })

const optionalConfig = (name: string) =>
  Effect.map(Config.option(Config.String(name)), (value) => Option.getOrNull(value)?.trim() || null)

/**
 * The bucket store and its index client, from env. When the bucket side is
 * incompletely configured the returned store still builds — every
 * operation fails with setup instructions, the same doctrine as
 * lib/Bucket.ts — so a misconfigured deployment is visible, not crashed.
 */
export const bucketFromConfig: Effect.Effect<
  { readonly store: ArtifactStoreApi; readonly index: IndexClientApi },
  Config.ConfigError
> = Effect.gen(function*() {
  const connection = yield* readArtifactBucketConnection
  const indexUrl = yield* optionalConfig("MEDINA_INDEX_URL")
  const indexToken = yield* optionalConfig("INDEX_API_TOKEN")
  const pathRoot = yield* Config.String("DATA_DIR").pipe(Config.withDefault("data/artifacts"))
  if (!connection.bucket || connection.bucket === "disabled" || !indexUrl || !indexToken) {
    return { store: unconfigured(pathRoot), index: failingIndex() }
  }
  const client = new S3Client({
    ...(connection.endpoint === null ? {} : { endpoint: connection.endpoint }),
    region: connection.region,
    forcePathStyle: connection.forcePathStyle,
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey
    }
  })
  const index = makeIndexClient({ baseUrl: indexUrl, token: indexToken })
  return { store: makeBucket({ objects: makeS3ObjectStore(client, connection.bucket), index, pathRoot }), index }
})

/**
 * The raw object store over the ARTIFACT_BUCKET_* env, built
 * synchronously from `process.env` — the twin of `bucketFromConfig`
 * minus the index, for callers that need objects only and construct at
 * module scope where Config effects are not available (the capture
 * policy store: its policy document and APK distribution live in this
 * bucket). Returns null when the bucket is unconfigured or explicitly
 * "disabled"; callers fall back to local behavior.
 */
export const objectStoreFromEnv = (): ObjectStoreApi | null => {
  const read = (name: string) => process.env[`ARTIFACT_BUCKET_${name}`]?.trim() || null
  const bucket = read("NAME")
  if (!bucket || bucket === "disabled") return null
  const endpoint = read("ENDPOINT")
  const client = new S3Client({
    ...(endpoint === null ? {} : { endpoint }),
    region: read("REGION") ?? "auto",
    forcePathStyle: read("FORCE_PATH_STYLE") !== "false",
    credentials: {
      // Keyless is a real configuration (edge-signing endpoint), as in
      // readArtifactBucketConnection: placeholders stand in.
      accessKeyId: read("ACCESS_KEY_ID") ?? "edge-injected",
      secretAccessKey: read("SECRET_ACCESS_KEY") ?? "edge-injected"
    }
  })
  return makeS3ObjectStore(client, bucket)
}

/**
 * The store layer for the running app, selected by ARTIFACT_STORE:
 * `bucket` for the bucket+index pair, anything else (including unset) for
 * the local store over DATA_DIR. Production flips by config only.
 */
export const layerFromConfig: Layer.Layer<ArtifactStore, Config.ConfigError, FileSystem.FileSystem> =
  Layer.unwrap(Effect.gen(function*() {
    const mode = yield* Config.String("ARTIFACT_STORE").pipe(Config.withDefault("local"))
    if (mode === "bucket") {
      const { store } = yield* bucketFromConfig
      return Layer.succeed(ArtifactStore)(store)
    }
    const root = yield* Config.String("DATA_DIR").pipe(Config.withDefault("data/artifacts"))
    return layerLocal(root)
  }))
