import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import * as Schema from "effect/Schema"

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

/**
 * Durable store for the policy document and its capability tokens. Tokens
 * are opaque; only their SHA-256 digest is persisted, so a copied state
 * file cannot be used as a credential. Files are written 0600 inside a
 * 0700 directory: the policy embeds bucket upload credentials.
 */
export class CapturePolicyStore {
  readonly #policyFile: string
  readonly #tokenFile: string

  constructor(options: { readonly directory: string }) {
    this.#policyFile = join(options.directory, "policy.json")
    this.#tokenFile = join(options.directory, "tokens.json")
  }

  #writeJson(file: string, value: unknown) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.${identifier()}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, file)
  }

  readPolicy(): CapturePolicy {
    try {
      const policy = decodePolicy(JSON.parse(readFileSync(this.#policyFile, "utf8")))
      if (!policy) throw new Error("stored capture policy failed validation")
      return policy
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultPolicy()
      throw error
    }
  }

  writePolicy(policy: CapturePolicy): void {
    this.#writeJson(this.#policyFile, policy)
  }

  #readTokens(): TokenState {
    try {
      const parsed = JSON.parse(readFileSync(this.#tokenFile, "utf8")) as TokenState
      if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) throw new Error("unsupported policy token registry")
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyTokenState()
      throw error
    }
  }

  issueToken(label: string): { readonly id: string; readonly token: string } {
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
    const state = this.#readTokens()
    this.#writeJson(this.#tokenFile, { ...state, tokens: [...state.tokens, entry] })
    return { id: entry.id, token }
  }

  listTokens(): ReadonlyArray<Omit<PolicyToken, "hash">> {
    return this.#readTokens().tokens.map(({ hash: _hash, ...token }) => token)
  }

  revokeToken(id: string): boolean {
    const state = this.#readTokens()
    const entry = state.tokens.find((token) => token.id === id)
    if (!entry || entry.revokedAt !== null) return false
    const revoked: PolicyToken = { ...entry, revokedAt: now() }
    this.#writeJson(this.#tokenFile, {
      ...state,
      tokens: state.tokens.map((token) => (token.id === id ? revoked : token))
    })
    return true
  }

  /** True for a known, unrevoked token. Touches lastUsedAt on success. */
  verifyToken(token: string): boolean {
    if (!token.startsWith("cpol_")) return false
    const hash = digest(token)
    const state = this.#readTokens()
    const entry = state.tokens.find((candidate) => candidate.revokedAt === null && sameDigest(candidate.hash, hash))
    if (!entry) return false
    const touched: PolicyToken = { ...entry, lastUsedAt: now() }
    this.#writeJson(this.#tokenFile, {
      ...state,
      tokens: state.tokens.map((candidate) => (candidate.id === entry.id ? touched : candidate))
    })
    return true
  }
}
