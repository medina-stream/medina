import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { dirname, join } from "node:path"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Semaphore from "effect/Semaphore"

/**
 * Small, durable delegation registry. Tokens are opaque and only their SHA-256
 * digest is persisted, so a copied state file cannot be used as a credential.
 *
 * This deliberately has one permission today: `medina`. Splitting it into
 * narrower scopes later changes policy, not the approval/token protocol.
 *
 * All operations are Effects over `FileSystem`: no synchronous filesystem
 * work on the request path. State is cached in memory and reloaded only
 * when the file's mtime changes, writes are serialized per store, expired
 * entries are pruned on write, and `lastUsedAt` is persisted at most hourly.
 * Corrupt or unreadable state fails with `AuthStoreError`, never a sync throw.
 */
export const MEDINA_SCOPE = "medina"

/** How often `lastUsedAt` may be persisted for a token. */
export const LAST_USED_FLUSH_MS = 60 * 60_000

export class AuthStoreError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "AuthStoreError"
    if (cause !== undefined) this.cause = cause
  }
}

export interface DelegationRequest {
  readonly id: string
  readonly clientName: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly status: "pending" | "approved" | "denied" | "redeemed"
  readonly approvedAt: string | null
  readonly approvedBy: string | null
}

interface StoredToken {
  readonly id: string
  readonly requestId: string
  readonly clientName: string
  readonly hash: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
  readonly lastUsedAt: string | null
}

interface State {
  readonly version: 1
  readonly requests: readonly DelegationRequest[]
  readonly tokens: readonly StoredToken[]
}

const emptyState = (): State => ({ version: 1, requests: [], tokens: [] })
const now = () => new Date().toISOString()
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const identifier = () => randomBytes(18).toString("base64url")
const tokenValue = () => `md_${randomBytes(32).toString("base64url")}`

const sameDigest = (left: string, right: string) => {
  const a = Buffer.from(left, "hex")
  const b = Buffer.from(right, "hex")
  return a.length === b.length && timingSafeEqual(a, b)
}

const prune = (state: State, at = Date.now()): State => ({
  version: 1,
  requests: state.requests.filter((request) => Date.parse(request.expiresAt) > at),
  tokens: state.tokens.filter((token) => Date.parse(token.expiresAt) > at)
})

type Fs = FileSystem.FileSystem
const asStoreError = (file: string) => (cause: unknown): AuthStoreError =>
  cause instanceof AuthStoreError ? cause : new AuthStoreError(`delegation registry ${file} is unreadable or corrupt`, cause)

export class MedinaAuth {
  readonly #file: string
  readonly #requestTtlMs: number
  readonly #tokenTtlMs: number
  readonly #lastUsedFlushMs: number
  readonly #gate = Semaphore.makeUnsafe(1)
  #cache: { readonly state: State; readonly mtimeMs: number | null } | null = null

  constructor(options: {
    readonly directory: string
    readonly requestTtlMs?: number
    readonly tokenTtlMs?: number
    readonly lastUsedFlushMs?: number
  }) {
    this.#file = join(options.directory, "delegations.json")
    this.#requestTtlMs = options.requestTtlMs ?? 10 * 60_000
    this.#tokenTtlMs = options.tokenTtlMs ?? 60 * 60_000
    this.#lastUsedFlushMs = options.lastUsedFlushMs ?? LAST_USED_FLUSH_MS
  }

  #read(): Effect.Effect<State, AuthStoreError, Fs> {
    const self = this
    const file = self.#file
    return Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      if (!(yield* fs.exists(file))) {
        self.#cache = { state: emptyState(), mtimeMs: null }
        return emptyState()
      }
      const info = yield* fs.stat(file)
      const mtimeMs = Option.match(info.mtime, { onNone: () => null, onSome: (date: Date) => date.getTime() })
      if (self.#cache !== null && self.#cache.mtimeMs !== null && self.#cache.mtimeMs === mtimeMs) return self.#cache.state
      const text = yield* fs.readFileString(file)
      let parsed: State
      try {
        parsed = JSON.parse(text) as State
        if (parsed.version !== 1 || !Array.isArray(parsed.requests) || !Array.isArray(parsed.tokens)) {
          throw new Error("unsupported delegation registry")
        }
      } catch (cause) {
        return yield* Effect.fail(new AuthStoreError(`delegation registry ${file} is corrupt`, cause))
      }
      self.#cache = { state: parsed, mtimeMs }
      return parsed
    }).pipe(Effect.mapError(asStoreError(file)))
  }

  #write(state: State): Effect.Effect<void, AuthStoreError, Fs> {
    const self = this
    const file = self.#file
    return Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const pruned = prune(state)
      yield* fs.makeDirectory(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.${identifier()}.tmp`
      yield* fs.writeFileString(temporary, JSON.stringify(pruned, null, 2) + "\n", { mode: 0o600 })
      yield* fs.rename(temporary, file)
      // Refresh the cache from the file we just wrote; its mtime is the key.
      const info = yield* fs.stat(file).pipe(Effect.option)
      self.#cache = {
        state: pruned,
        mtimeMs: Option.isSome(info)
          ? Option.match(info.value.mtime, { onNone: () => null, onSome: (date: Date) => date.getTime() })
          : null
      }
    }).pipe(Effect.mapError(asStoreError(file)))
  }

  createRequest(clientName: string): Effect.Effect<DelegationRequest, AuthStoreError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.gen(function*() {
      const clean = clientName.trim().replace(/\s+/g, " ").slice(0, 120)
      if (!clean) return yield* Effect.fail(new AuthStoreError("client_name is required"))
      const createdAt = now()
      const request: DelegationRequest = {
        id: identifier(), clientName: clean, createdAt,
        expiresAt: new Date(Date.now() + self.#requestTtlMs).toISOString(),
        status: "pending", approvedAt: null, approvedBy: null
      }
      const state = yield* self.#read()
      yield* self.#write({ ...state, requests: [...state.requests, request] })
      return request
    }))
  }

  getRequest(id: string): Effect.Effect<DelegationRequest | null, AuthStoreError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.map(self.#read(), (state) =>
      state.requests.find((request) => request.id === id) ?? null
    ))
  }

  approve(id: string, login: string): Effect.Effect<DelegationRequest | null, AuthStoreError, Fs> {
    const self = this
    return self.#decide(id, login, "approved")
  }

  deny(id: string, login: string): Effect.Effect<DelegationRequest | null, AuthStoreError, Fs> {
    const self = this
    return self.#decide(id, login, "denied")
  }

  #decide(id: string, login: string, status: "approved" | "denied"): Effect.Effect<DelegationRequest | null, AuthStoreError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.gen(function*() {
      const state = yield* self.#read()
      const current = state.requests.find((request) => request.id === id)
      if (!current || current.status !== "pending" || Date.parse(current.expiresAt) <= Date.now()) return null
      const decided: DelegationRequest = { ...current, status, approvedAt: now(), approvedBy: login }
      yield* self.#write({ ...state, requests: state.requests.map((request) => request.id === id ? decided : request) })
      return decided
    }))
  }

  redeem(id: string): Effect.Effect<{ readonly token: string; readonly expiresAt: string } | "pending" | "denied" | "expired" | "missing", AuthStoreError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.gen(function*() {
      const state = yield* self.#read()
      const request = state.requests.find((entry) => entry.id === id)
      if (!request) return "missing" as const
      if (request.status === "pending") return Date.parse(request.expiresAt) > Date.now() ? "pending" as const : "expired" as const
      if (request.status === "denied") return "denied" as const
      if (request.status !== "approved") return "missing" as const
      const token = tokenValue()
      const expiresAt = new Date(Date.now() + self.#tokenTtlMs).toISOString()
      const entry: StoredToken = {
        id: identifier(), requestId: request.id, clientName: request.clientName, hash: digest(token),
        createdAt: now(), expiresAt, revokedAt: null, lastUsedAt: null
      }
      // A request is redeemable once: another poll must not mint another token.
      const redeemed: DelegationRequest = { ...request, status: "redeemed" }
      yield* self.#write({
        ...state,
        requests: state.requests.map((item) => item.id === request.id ? redeemed : item),
        tokens: [...state.tokens, entry]
      })
      return { token, expiresAt }
    }))
  }

  authorize(token: string): Effect.Effect<{ readonly clientName: string; readonly tokenId: string } | null, AuthStoreError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.gen(function*() {
      const state = yield* self.#read()
      const hash = digest(token)
      const entry = state.tokens.find((candidate) => sameDigest(candidate.hash, hash))
      if (!entry || entry.revokedAt || Date.parse(entry.expiresAt) <= Date.now()) return null
      // Debounced: only persist lastUsedAt when the stored stamp is stale.
      const lastUsedMs = entry.lastUsedAt === null ? null : Date.parse(entry.lastUsedAt)
      if (lastUsedMs === null || Date.now() - lastUsedMs >= self.#lastUsedFlushMs) {
        const updated: StoredToken = { ...entry, lastUsedAt: now() }
        yield* self.#write({ ...state, tokens: state.tokens.map((candidate) => candidate.id === entry.id ? updated : candidate) })
      }
      return { clientName: entry.clientName, tokenId: entry.id }
    }))
  }

  listTokens(): Effect.Effect<ReadonlyArray<Omit<StoredToken, "hash">>, AuthStoreError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.map(self.#read(), (state) =>
      state.tokens.map(({ hash: _hash, ...token }) => token)
    ))
  }

  revokeId(id: string): Effect.Effect<boolean, AuthStoreError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.gen(function*() {
      const state = yield* self.#read()
      const entry = state.tokens.find((candidate) => candidate.id === id)
      if (!entry || entry.revokedAt) return false
      yield* self.#write({ ...state, tokens: state.tokens.map((candidate) => candidate.id === id ? { ...candidate, revokedAt: now() } : candidate) })
      return true
    }))
  }

  revoke(token: string): Effect.Effect<boolean, AuthStoreError, Fs> {
    const self = this
    return self.#gate.withPermit(Effect.gen(function*() {
      const state = yield* self.#read()
      const hash = digest(token)
      const entry = state.tokens.find((candidate) => sameDigest(candidate.hash, hash))
      if (!entry || entry.revokedAt) return false
      yield* self.#write({ ...state, tokens: state.tokens.map((candidate) => candidate.id === entry.id ? { ...candidate, revokedAt: now() } : candidate) })
      return true
    }))
  }
}
