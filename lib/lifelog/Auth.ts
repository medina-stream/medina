import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Small, durable delegation registry. Tokens are opaque and only their SHA-256
 * digest is persisted, so a copied state file cannot be used as a credential.
 *
 * This deliberately has one permission today: `medina`. Splitting it into
 * narrower scopes later changes policy, not the approval/token protocol.
 */
export const MEDINA_SCOPE = "medina"

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

export class MedinaAuth {
  readonly #file: string
  readonly #requestTtlMs: number
  readonly #tokenTtlMs: number

  constructor(options: { readonly directory: string, readonly requestTtlMs?: number, readonly tokenTtlMs?: number }) {
    this.#file = join(options.directory, "delegations.json")
    this.#requestTtlMs = options.requestTtlMs ?? 10 * 60_000
    this.#tokenTtlMs = options.tokenTtlMs ?? 60 * 60_000
  }

  #read(): State {
    try {
      const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as State
      if (parsed.version !== 1 || !Array.isArray(parsed.requests) || !Array.isArray(parsed.tokens)) throw new Error("unsupported delegation registry")
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState()
      throw error
    }
  }

  #write(state: State) {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 })
    const temporary = `${this.#file}.${process.pid}.${identifier()}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, this.#file)
  }

  createRequest(clientName: string): DelegationRequest {
    const clean = clientName.trim().replace(/\s+/g, " ").slice(0, 120)
    if (!clean) throw new Error("client_name is required")
    const createdAt = now()
    const request: DelegationRequest = {
      id: identifier(), clientName: clean, createdAt,
      expiresAt: new Date(Date.now() + this.#requestTtlMs).toISOString(),
      status: "pending", approvedAt: null, approvedBy: null
    }
    const state = this.#read()
    this.#write({ ...state, requests: [...state.requests, request] })
    return request
  }

  getRequest(id: string): DelegationRequest | null {
    return this.#read().requests.find((request) => request.id === id) ?? null
  }

  approve(id: string, login: string): DelegationRequest | null {
    const state = this.#read()
    const current = state.requests.find((request) => request.id === id)
    if (!current || current.status !== "pending" || Date.parse(current.expiresAt) <= Date.now()) return null
    const approved: DelegationRequest = { ...current, status: "approved", approvedAt: now(), approvedBy: login }
    this.#write({ ...state, requests: state.requests.map((request) => request.id === id ? approved : request) })
    return approved
  }

  deny(id: string, login: string): DelegationRequest | null {
    const state = this.#read()
    const current = state.requests.find((request) => request.id === id)
    if (!current || current.status !== "pending") return null
    const denied: DelegationRequest = { ...current, status: "denied", approvedAt: now(), approvedBy: login }
    this.#write({ ...state, requests: state.requests.map((request) => request.id === id ? denied : request) })
    return denied
  }

  redeem(id: string): { readonly token: string, readonly expiresAt: string } | "pending" | "denied" | "expired" | "missing" {
    const state = this.#read()
    const request = state.requests.find((entry) => entry.id === id)
    if (!request) return "missing"
    if (request.status === "pending") return Date.parse(request.expiresAt) > Date.now() ? "pending" : "expired"
    if (request.status === "denied") return "denied"
    if (request.status !== "approved") return "missing"
    const token = tokenValue()
    const expiresAt = new Date(Date.now() + this.#tokenTtlMs).toISOString()
    const entry: StoredToken = {
      id: identifier(), requestId: request.id, clientName: request.clientName, hash: digest(token),
      createdAt: now(), expiresAt, revokedAt: null, lastUsedAt: null
    }
    // A request is redeemable once: another poll must not mint another token.
    const redeemed: DelegationRequest = { ...request, status: "redeemed" }
    this.#write({
      ...state,
      requests: state.requests.map((item) => item.id === request.id ? redeemed : item),
      tokens: [...state.tokens, entry]
    })
    return { token, expiresAt }
  }

  authorize(token: string): { readonly clientName: string, readonly tokenId: string } | null {
    const state = this.#read()
    const hash = digest(token)
    const entry = state.tokens.find((candidate) => sameDigest(candidate.hash, hash))
    if (!entry || entry.revokedAt || Date.parse(entry.expiresAt) <= Date.now()) return null
    const updated: StoredToken = { ...entry, lastUsedAt: now() }
    this.#write({ ...state, tokens: state.tokens.map((candidate) => candidate.id === entry.id ? updated : candidate) })
    return { clientName: entry.clientName, tokenId: entry.id }
  }

  revoke(token: string): boolean {
    const state = this.#read()
    const hash = digest(token)
    const entry = state.tokens.find((candidate) => sameDigest(candidate.hash, hash))
    if (!entry || entry.revokedAt) return false
    this.#write({ ...state, tokens: state.tokens.map((candidate) => candidate.id === entry.id ? { ...candidate, revokedAt: now() } : candidate) })
    return true
  }
}
