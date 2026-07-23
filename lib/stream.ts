import { constantTimeTokenEquals, extractMedinaToken, tailscaleUserLoginHeader, type AuthzDecision } from "./authz";
import type { Bucket, BucketConnection } from "./bucket";
import type { User } from "./user";

export type ModelId = string | number;

export type BucketCredentials = BucketConnection & { id?: ModelId };
export type StreamBucket = BucketCredentials;
export type StreamBuckets = Record<string, StreamBucket>;
export type StreamSandbox = { name: string };

export type Stream = {
  host: string;
  hostAliases?: string[];
  name?: string;
  description?: string;
  preferences?: StreamPreferences;
  buckets: StreamBuckets;
  sandboxes?: StreamSandbox[];
  users: User[];
};

export class UnknownStreamHostError extends Error {
  constructor(host: string | null | undefined) {
    super(`No stream is configured for host: ${host ?? "missing"}`);
    this.name = "UnknownStreamHostError";
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const numericIdPattern = /^\d+$/;

export function getEnv(name: string, env: Record<string, string | undefined> = process.env) {
  return env[name];
}

export function isUuidOrNumericId(id: ModelId) {
  if (typeof id === "number") return Number.isSafeInteger(id) && id >= 0;
  return uuidPattern.test(id) || numericIdPattern.test(id);
}

export function assertUuidOrNumericId(kind: string, id: ModelId) {
  if (!isUuidOrNumericId(id)) throw new Error(`${kind} id must be a UUID or numeric id, got ${JSON.stringify(id)}`);
}

export function createBucketCredentials(credentials: BucketCredentials): BucketCredentials {
  if (credentials.id !== undefined) assertUuidOrNumericId("bucket credentials", credentials.id);
  return { ...credentials };
}

export function normalizeStreamHost(host: string | null | undefined) {
  if (!host) return null;
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 0 ? trimmed.slice(1, end).replace(/\.$/, "") || null : trimmed.replace(/\.$/, "") || null;
  }

  return trimmed.split(":", 1)[0].replace(/\.$/, "") || null;
}

export function hostFromRequest(req: Request): string | null {
  return normalizeStreamHost(req.headers.get("host") ?? new URL(req.url).host);
}

export function hostFromMedinaRoot(env: Record<string, string | undefined> = process.env) {
  const root = getEnv("MEDINA_ROOT", env);
  if (!root) return null;

  try {
    return normalizeStreamHost(new URL(root).host);
  } catch {
    return normalizeStreamHost(root);
  }
}

export function streamHosts(stream: Stream) {
  return [stream.host, ...(stream.hostAliases ?? [])]
    .map(normalizeStreamHost)
    .filter((host): host is string => Boolean(host));
}

export function streamMatchesHost(stream: Stream, host: string | null | undefined) {
  const normalizedHost = normalizeStreamHost(host);
  if (!normalizedHost) return false;
  return streamHosts(stream).includes(normalizedHost);
}

export function createStream(stream: Stream): Stream {
  return {
    ...stream,
    buckets: Object.fromEntries(Object.entries(stream.buckets).map(([name, bucket]) => [name, createBucketCredentials(bucket)])),
    host: normalizeStreamHost(stream.host) ?? "localhost",
    hostAliases: stream.hostAliases?.map(normalizeStreamHost).filter((host): host is string => Boolean(host)),
  };
}

export function streamFromRequest(req: Request, streams: Stream[]): Stream | null {
  if (streams.length === 0) return null;

  const host = hostFromRequest(req);
  if (!host) return null;

  return streams.find((stream) => streamMatchesHost(stream, host)) ?? null;
}

export function authorizeStreamRequest(stream: Stream, req: Request): AuthzDecision {
  if (req.method === "OPTIONS") return { allowed: true, reason: "public" };

  const tailscaleLogin = req.headers.get(tailscaleUserLoginHeader)?.trim();
  if (tailscaleLogin) {
    const allowed = stream.users.some((user) => user.credentials.some((credential) =>
      credential.type === "tailscale" && credential.value.toLowerCase() === tailscaleLogin.toLowerCase()
    ));
    if (allowed) return { allowed: true, reason: "tailscale" };
  }

  const token = extractMedinaToken(req);
  if (!token) {
    return tailscaleLogin
      ? { allowed: false, message: `Tailscale user ${tailscaleLogin} is not allowed for this stream.`, reason: "tailscale-login-forbidden", status: 403 }
      : { allowed: false, message: "Missing Medina token or Tailscale identity.", reason: "missing-token", status: 401 };
  }

  for (const user of stream.users) {
    for (const userToken of user.tokens) {
      if (constantTimeTokenEquals(token, userToken.token)) return { allowed: true, reason: "token" };
    }
  }

  return { allowed: false, message: "Invalid Medina token.", reason: "bad-token", status: 403 };
}

export const streamPreferencesKey = "medina.conf";

export type StreamPreferences = {
  name: string;
  [key: string]: unknown;
};

export const defaultStreamPreferences: StreamPreferences = {
  name: "My Stream",
};

function parseStreamPreferences(value: unknown): StreamPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${streamPreferencesKey} must contain a JSON object.`);
  }

  const preferences = value as Record<string, unknown>;
  if (typeof preferences.name !== "string" || !preferences.name.trim()) {
    throw new Error(`${streamPreferencesKey} must contain a non-empty string name.`);
  }

  return {
    ...preferences,
    name: preferences.name.trim(),
  } as StreamPreferences;
}

export async function readStreamPreferences(bucket: Bucket): Promise<StreamPreferences> {
  if (!(await bucket.exists(streamPreferencesKey))) {
    return { ...defaultStreamPreferences };
  }

  return parseStreamPreferences(await bucket.readJson(streamPreferencesKey));
}

export async function ensureStreamPreferences(bucket: Bucket): Promise<StreamPreferences> {
  if (await bucket.exists(streamPreferencesKey)) {
    return await readStreamPreferences(bucket);
  }

  const preferences = { ...defaultStreamPreferences };
  await bucket.write(streamPreferencesKey, `${JSON.stringify(preferences, null, 2)}\n`, {
    type: "application/json; charset=utf-8",
  });
  return preferences;
}
