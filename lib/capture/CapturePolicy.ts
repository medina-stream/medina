import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { dirname, join } from "node:path"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"

/**
 * Capture policy: the server-owned document that tells the recorder app
 * what to do. The app is provisioned with a single capability URL
 * (`GET /api/capture-policy/:token`); the token in the URL authenticates
 * the fetch, and the policy carries everything else -- including the
 * bucket upload credentials. Rotating credentials or revoking the token
 * happens here; the app picks it up on its next refresh. No APK update,
 * no manual re-entry on the device.
 *
 * The app treats the policy as advisory data, never as code: it validates
 * the shape, ignores unknown fields, keeps the last-known-good document
 * when a fetch fails, and never stops capturing just because the server
 * is unreachable. A revoked/unknown token is the one terminal state.
 */

export class CapturePolicyAudio extends Schema.Class<CapturePolicyAudio>("CapturePolicyAudio")({
  enabled: Schema.Boolean,
  codec: Schema.Literal("aac"),
  channels: Schema.Number,
  sampleRateHz: Schema.Number,
  bitrateBps: Schema.Number,
  segmentSeconds: Schema.Number
}) {}

export class CapturePolicyGps extends Schema.Class<CapturePolicyGps>("CapturePolicyGps")({
  enabled: Schema.Boolean,
  intervalSeconds: Schema.Number,
  minUpdateDistanceMeters: Schema.Number,
  minAccuracyMeters: Schema.Number
}) {}

export class CapturePolicyUpload extends Schema.Class<CapturePolicyUpload>("CapturePolicyUpload")({
  endpoint: Schema.String,
  bucket: Schema.String,
  region: Schema.String,
  prefix: Schema.String,
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  unmeteredOnly: Schema.Boolean
}) {}

/**
 * The newest published recorder APK (see lib/capture/CaptureApk.ts for
 * the stamp contract). The app compares `stamp` against the stamp baked
 * into its own build; when the policy's is newer it offers the download
 * at `url`, verifying `sha256` and `sizeBytes` before handing the file
 * to the system installer. Optional: policies written before APK
 * distribution existed simply have no update to offer.
 */
export class CapturePolicyApk extends Schema.Class<CapturePolicyApk>("CapturePolicyApk")({
  stamp: Schema.String,
  url: Schema.String,
  sha256: Schema.String,
  sizeBytes: Schema.Number,
  publishedAt: Schema.String,
  notes: Schema.optional(Schema.String)
}) {}

export class CapturePolicy extends Schema.Class<CapturePolicy>("CapturePolicy")({
  version: Schema.Number,
  updatedAt: Schema.String,
  audio: CapturePolicyAudio,
  gps: CapturePolicyGps,
  upload: CapturePolicyUpload,
  apk: Schema.optional(Schema.NullOr(CapturePolicyApk))
}) {}

/** The document served when none has been written yet: matches the
 * recorder app's historical hardcoded behavior, with empty credentials. */
export const defaultPolicy = (): CapturePolicy =>
  new CapturePolicy({
    version: 1,
    updatedAt: new Date().toISOString(),
    audio: new CapturePolicyAudio({
      enabled: true,
      codec: "aac",
      channels: 1,
      sampleRateHz: 16000,
      bitrateBps: 32000,
      segmentSeconds: 900
    }),
    gps: new CapturePolicyGps({
      enabled: true,
      intervalSeconds: 60,
      minUpdateDistanceMeters: 50,
      minAccuracyMeters: 100
    }),
    upload: new CapturePolicyUpload({
      endpoint: "",
      bucket: "",
      region: "us-east-1",
      prefix: "",
      accessKeyId: "",
      secretAccessKey: "",
      unmeteredOnly: true
    })
  })

/** Decode an unknown value into a policy, or null when it doesn't validate. */
export const decodePolicy = (input: unknown): CapturePolicy | null => {
  try {
    return Schema.decodeUnknownSync(CapturePolicy)(input)
  } catch {
    return null
  }
}

/** How often `lastUsedAt` may be persisted for a token. */
export const LAST_USED_FLUSH_MS = 60 * 60_000
/** Revoked tokens are kept this long for audit, then pruned on write. */
const REVOKED_RETENTION_MS = 30 * 24 * 60 * 60_000

export class CapturePolicyError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "CapturePolicyError"
    if (cause !== undefined) this.cause = cause
  }
}

interface PolicyToken {
  readonly id: string
  readonly label: string
  readonly hash: string
  readonly createdAt: string
  readonly revokedAt: string | null
  readonly lastUsedAt: string | null
}

interface TokenState {
  readonly version: 1
  readonly tokens: readonly PolicyToken[]
}

const emptyTokenState = (): TokenState => ({ version: 1, tokens: [] })
const now = () => new Date().toISOString()
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const identifier = () => randomBytes(18).toString("base64url")
const tokenValue = () => `cpol_${randomBytes(32).toString("base64url")}`

const sameDigest = (left: string, right: string) => {
  const a = Buffer.from(left, "hex")
  const b = Buffer.from(right, "hex")
  return a.length === b.length && timingSafeEqual(a, b)
}

const pruneTokens = (state: TokenState, at = Date.now()): TokenState => ({
  version: 1,
  tokens: state.tokens.filter((token) =>
    token.revokedAt === null || Date.parse(token.revokedAt) > at - REVOKED_RETENTION_MS
  )
})

type Fs = FileSystem.FileSystem
const asPolicyError = (file: string) => (cause: unknown): CapturePolicyError =>
  cause instanceof CapturePolicyError ? cause : new CapturePolicyError(`capture policy store ${file} is unreadable or corrupt`, cause)

/**
 * The minimal object-store surface the policy store needs when the
 * policy document lives in the artifact bucket (sco-lifelog) instead of
 * on local disk. `lib/ArtifactStore.ts`'s `ObjectStoreApi` satisfies
 * this shape; tests pass an in-memory store.
 */
export interface PolicyObjectStore {
  readonly get: (key: string) => Effect.Effect<Option.Option<Uint8Array>, Error>
  readonly put: (key: string, bytes: Uint8Array, contentType?: string) => Effect.Effect<string | null, Error>
  readonly head: (key: string) => Effect.Effect<{ readonly size: number | null; readonly etag: string | null } | null, Error>
}

/** Bucket key of the canonical policy document. */
export const POLICY_OBJECT_KEY = "capture-policy/policy.json"
/**
 * Bucket key of the mirrored token registry (hashes only, exactly what
 * the on-disk registry holds). The public edge (the medina-index
 * Worker) verifies capability tokens against this mirror, because the
 * policy fetch must not depend on reaching this host. This store stays
 * the authority: the mirror is rewritten on every registry write.
 */
export const TOKENS_OBJECT_KEY = "capture-policy/tokens.json"

const asBucketError = (key: string) => (cause: unknown): CapturePolicyError =>
  cause instanceof CapturePolicyError ? cause : new CapturePolicyError(`capture policy bucket object ${key} is unreadable or corrupt`, cause)

/**
 * Durable store for the policy document and its capability tokens. Tokens
 * are opaque; only their SHA-256 digest is persisted, so a copied state
 * file cannot be used as a credential. Files are written 0600 inside a
 * 0700 directory: the policy embeds bucket upload credentials.
 *
 * The policy document's canonical home is the artifact bucket
 * (sco-lifelog) when `policyObjects` is provided: the document is an
 * object there, readable by the public edge that serves it to devices,
 * and this server reads through it (etag-cached, revalidated by a HEAD
 * on every read, so writes from the publish script take effect without
 * a restart). The on-disk document then serves as the seed: the first
 * bucket read copies it up, so the live policy survives the move. The
 * token registry stays on disk (it is server-internal state, written
 * far more often) and is mirrored to the bucket on every write purely
 * so the edge can verify tokens. Without `policyObjects` everything is
 * on disk, as before.
 *
 * All operations are Effects over `FileSystem`: no synchronous filesystem
 * work on the request path. Documents are cached in memory and reloaded
 * only when the file's mtime (or the object's etag) changes, writes are
 * serialized per store, long-revoked tokens are pruned on write, and
 * `lastUsedAt` is persisted at most hourly. Corrupt state fails with
 * `CapturePolicyError`.
 */
export class CapturePolicyStore {
  readonly #policyFile: string
  readonly #tokenFile: string
  readonly #lastUsedFlushMs: number
  readonly #policyObjects: PolicyObjectStore | null
  readonly #gate = Semaphore.makeUnsafe(1)
  #policyCache: { readonly value: CapturePolicy; readonly mtimeMs: number | null } | null = null
  #bucketCache: { readonly value: CapturePolicy; readonly etag: string | null } | null = null
  #tokenCache: { readonly state: TokenState; readonly mtimeMs: number | null } | null = null

  constructor(options: {
    readonly directory: string
    readonly lastUsedFlushMs?: number
    readonly policyObjects?: PolicyObjectStore | null
  }) {
    this.#policyFile = join(options.directory, "policy.json")
    this.#tokenFile = join(options.directory, "tokens.json")
    this.#lastUsedFlushMs = options.lastUsedFlushMs ?? LAST_USED_FLUSH_MS
    this.#policyObjects = options.policyObjects ?? null
  }

  #mtime(fs: Fs, file: string): Effect.Effect<number | null, CapturePolicyError, never> {
    const self = this
    return Effect.map(
      Effect.option(fs.stat(file).pipe(Effect.mapError(asPolicyError(file)))),
      (info) => Option.isSome(info)
        ? Option.match(info.value.mtime, { onNone: () => null, onSome: (date: Date) => date.getTime() })
        : null
    )
  }

  #writeJson(file: string, value: unknown): Effect.Effect<void, CapturePolicyError, Fs> {
    const self = this
    return Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.${identifier()}.tmp`
      yield* fs.writeFileString(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
      yield* fs.rename(temporary, file)
    }).pipe(Effect.mapError(asPolicyError(file)))
  }

  readPolicy(): Effect.Effect<CapturePolicy, CapturePolicyError, Fs> {
    return this.#policyObjects === null ? this.#readPolicyFile() : this.#readPolicyBucket(this.#policyObjects)
  }

  #readPolicyFile(): Effect.Effect<CapturePolicy, CapturePolicyError, Fs> {
    const self = this
    const file = self.#policyFile
    return Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      if (!(yield* fs.exists(file))) {
        const value = defaultPolicy()
        self.#policyCache = { value, mtimeMs: null }
        return value
      }
      const mtimeMs = yield* self.#mtime(fs, file)
      if (self.#policyCache !== null && self.#policyCache.mtimeMs !== null && self.#policyCache.mtimeMs === mtimeMs) {
        return self.#policyCache.value
      }
      const text = yield* fs.readFileString(file)
      let policy: CapturePolicy | null
      try {
        policy = decodePolicy(JSON.parse(text))
      } catch (cause) {
        return yield* Effect.fail(new CapturePolicyError(`stored capture policy ${file} is corrupt`, cause))
      }
      if (!policy) return yield* Effect.fail(new CapturePolicyError(`stored capture policy ${file} failed validation`))
      self.#policyCache = { value: policy, mtimeMs }
      return policy
    }).pipe(Effect.mapError(asPolicyError(file)))
  }

  /**
   * The bucket read path: a HEAD revalidates the cached document on
   * every read, so a policy written by another process (the publish
   * script) is picked up on the next fetch. When the object is absent
   * the on-disk document seeds it — a one-time migration that keeps the
   * live policy (and its credentials) continuous across the move.
   */
  #readPolicyBucket(objects: PolicyObjectStore): Effect.Effect<CapturePolicy, CapturePolicyError, Fs> {
    const self = this
    const key = POLICY_OBJECT_KEY
    return Effect.gen(function*() {
      const head = yield* objects.head(key).pipe(Effect.mapError(asBucketError(key)))
      if (head !== null) {
        if (self.#bucketCache !== null && self.#bucketCache.etag !== null && self.#bucketCache.etag === head.etag) {
          return self.#bucketCache.value
        }
        const found = yield* objects.get(key).pipe(Effect.mapError(asBucketError(key)))
        if (Option.isNone(found)) {
          return yield* Effect.fail(new CapturePolicyError(`capture policy bucket object ${key} vanished between head and get`))
        }
        let policy: CapturePolicy | null
        try {
          policy = decodePolicy(JSON.parse(new TextDecoder().decode(found.value)))
        } catch (cause) {
          return yield* Effect.fail(new CapturePolicyError(`stored capture policy ${key} is corrupt`, cause))
        }
        if (!policy) return yield* Effect.fail(new CapturePolicyError(`stored capture policy ${key} failed validation`))
        self.#bucketCache = { value: policy, etag: head.etag }
        return policy
      }
      // No object yet: seed from the on-disk document (or the default),
      // best-effort — a failed seed write is retried on the next read.
      const seeded = yield* self.#readPolicyFile()
      const etag = yield* objects.put(
        key,
        new TextEncoder().encode(JSON.stringify(seeded, null, 2) + "\n"),
        "application/json"
      ).pipe(Effect.catchCause(() => Effect.succeed(null)))
      self.#bucketCache = { value: seeded, etag }
      return seeded
    })
  }

  writePolicy(policy: CapturePolicy): Effect.Effect<void, CapturePolicyError, Fs> {
    const self = this
    const objects = self.#policyObjects
    return self.#gate.withPermit(Effect.gen(function*() {
      if (objects !== null) {
        const etag = yield* objects.put(
          POLICY_OBJECT_KEY,
          new TextEncoder().encode(JSON.stringify(policy, null, 2) + "\n"),
          "application/json"
        ).pipe(Effect.mapError(asBucketError(POLICY_OBJECT_KEY)))
        self.#bucketCache = { value: policy, etag }
        // Keep the on-disk copy fresh as the seed/fallback; its failure
        // must not fail a write the bucket already accepted.
        yield* self.#writeJson(self.#policyFile, policy).pipe(Effect.ignore)
        const fs = yield* FileSystem.FileSystem
        self.#policyCache = { value: policy, mtimeMs: yield* self.#mtime(fs, self.#policyFile) }
        return
      }
      yield* self.#writeJson(self.#policyFile, policy)
      const fs = yield* FileSystem.FileSystem
      self.#policyCache = { value: policy, mtimeMs: yield* self.#mtime(fs, self.#policyFile) }
    }))
  }

  #readTokens(): Effect.Effect<TokenState, CapturePolicyError, Fs> {
    const self = this
    const file = self.#tokenFile
    return Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      if (!(yield* fs.exists(file))) {
        self.#tokenCache = { state: emptyTokenState(), mtimeMs: null }
        return emptyTokenState()
      }
      const mtimeMs = yield* self.#mtime(fs, file)
      if (self.#tokenCache !== null && self.#tokenCache.mtimeMs !== null && self.#tokenCache.mtimeMs === mtimeMs) {
        return self.#tokenCache.state
      }
      const text = yield* fs.readFileString(file)
      let parsed: TokenState
      try {
        parsed = JSON.parse(text) as TokenState
        if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) throw new Error("unsupported policy token registry")
      } catch (cause) {
        return yield* Effect.fail(new CapturePolicyError(`policy token registry ${file} is corrupt`, cause))
      }
      self.#tokenCache = { state: parsed, mtimeMs }
      return parsed
    }).pipe(Effect.mapError(asPolicyError(file)))
  }

  #writeTokens(state: TokenState): Effect.Effect<void, CapturePolicyError, Fs> {
    const self = this
    return Effect.gen(function*() {
      const pruned = pruneTokens(state)
      yield* self.#writeJson(self.#tokenFile, pruned)
      const fs = yield* FileSystem.FileSystem
      self.#tokenCache = { state: pruned, mtimeMs: yield* self.#mtime(fs, self.#tokenFile) }
      // Mirror for the public edge's token verification. Best-effort:
      // the on-disk registry is authoritative, and a bucket hiccup must
      // not block issuing or revoking a device token.
      const objects = self.#policyObjects
      if (objects !== null) {
        yield* objects.put(
          TOKENS_OBJECT_KEY,
          new TextEncoder().encode(JSON.stringify(pruned, null, 2) + "\n"),
          "application/json"
        ).pipe(Effect.ignore)
      }
    })
  }

  issueToken(label: string): Effect.Effect<{ readonly id: string; readonly token: string }, CapturePolicyError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.gen(function*() {
      const clean = label.trim().replace(/\s+/g, " ").slice(0, 120) || "unnamed device"
      const token = tokenValue()
      const entry: PolicyToken = {
        id: identifier(),
        label: clean,
        hash: digest(token),
        createdAt: now(),
        revokedAt: null,
        lastUsedAt: null
      }
      const state = yield* self.#readTokens()
      yield* self.#writeTokens({ ...state, tokens: [...state.tokens, entry] })
      return { id: entry.id, token }
    }))
  }

  listTokens(): Effect.Effect<ReadonlyArray<Omit<PolicyToken, "hash">>, CapturePolicyError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.map(self.#readTokens(), (state) =>
      state.tokens.map(({ hash: _hash, ...token }) => token)
    ))
  }

  revokeToken(id: string): Effect.Effect<boolean, CapturePolicyError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.gen(function*() {
      const state = yield* self.#readTokens()
      const entry = state.tokens.find((token) => token.id === id)
      if (!entry || entry.revokedAt !== null) return false
      const revoked: PolicyToken = { ...entry, revokedAt: now() }
      yield* self.#writeTokens({
        ...state,
        tokens: state.tokens.map((token) => (token.id === id ? revoked : token))
      })
      return true
    }))
  }

  /** True for a known, unrevoked token. Touches lastUsedAt on success, at most hourly. */
  verifyToken(token: string): Effect.Effect<boolean, CapturePolicyError, Fs> {
    const self = this
    if (!token.startsWith("cpol_")) return Effect.succeed(false)
    return self.#gate.withPermit(Effect.gen(function*() {
      const hash = digest(token)
      const state = yield* self.#readTokens()
      const entry = state.tokens.find((candidate) => candidate.revokedAt === null && sameDigest(candidate.hash, hash))
      if (!entry) return false
      const lastUsedMs = entry.lastUsedAt === null ? null : Date.parse(entry.lastUsedAt)
      if (lastUsedMs === null || Date.now() - lastUsedMs >= self.#lastUsedFlushMs) {
        const touched: PolicyToken = { ...entry, lastUsedAt: now() }
        yield* self.#writeTokens({
          ...state,
          tokens: state.tokens.map((candidate) => (candidate.id === entry.id ? touched : candidate))
        })
      }
      return true
    }))
  }
}
