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

export class CapturePolicy extends Schema.Class<CapturePolicy>("CapturePolicy")({
  version: Schema.Number,
  updatedAt: Schema.String,
  audio: CapturePolicyAudio,
  gps: CapturePolicyGps,
  upload: CapturePolicyUpload
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
 * Durable store for the policy document and its capability tokens. Tokens
 * are opaque; only their SHA-256 digest is persisted, so a copied state
 * file cannot be used as a credential. Files are written 0600 inside a
 * 0700 directory: the policy embeds bucket upload credentials.
 *
 * All operations are Effects over `FileSystem`: no synchronous filesystem
 * work on the request path. Documents are cached in memory and reloaded
 * only when the file's mtime changes, writes are serialized per store,
 * long-revoked tokens are pruned on write, and `lastUsedAt` is persisted
 * at most hourly. Corrupt state fails with `CapturePolicyError`.
 */
export class CapturePolicyStore {
  readonly #policyFile: string
  readonly #tokenFile: string
  readonly #lastUsedFlushMs: number
  readonly #gate = Semaphore.makeUnsafe(1)
  #policyCache: { readonly value: CapturePolicy; readonly mtimeMs: number | null } | null = null
  #tokenCache: { readonly state: TokenState; readonly mtimeMs: number | null } | null = null

  constructor(options: { readonly directory: string; readonly lastUsedFlushMs?: number }) {
    this.#policyFile = join(options.directory, "policy.json")
    this.#tokenFile = join(options.directory, "tokens.json")
    this.#lastUsedFlushMs = options.lastUsedFlushMs ?? LAST_USED_FLUSH_MS
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

  writePolicy(policy: CapturePolicy): Effect.Effect<void, CapturePolicyError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.gen(function*() {
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
