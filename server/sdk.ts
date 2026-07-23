import { hc } from "hono/client";
import type { ApiType } from "./api";

const SDK_VERSION = "medina-sdk/0.1.0";

export type MedinaClientOptions = {
  baseUrl?: string;
  tailscaleLogin?: string;
  token?: string;
};

function resolveBaseUrl(input?: string | MedinaClientOptions): string {
  const baseUrl = typeof input === "string" ? input : input?.baseUrl;
  if (baseUrl) return baseUrl.replace(/\/$/, "").replace(/\/app$/, "");
  if (typeof globalThis.location === "object") return globalThis.location.origin;
  return "http://localhost:3000";
}

function getProcessEnv(key: string): string | undefined {
  const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return processLike?.env?.[key];
}

function resolveToken(input?: string | MedinaClientOptions) {
  return typeof input === "string" ? getProcessEnv("MEDINA_TOKEN") : input?.token ?? getProcessEnv("MEDINA_TOKEN");
}

function resolveTailscaleLogin(input?: string | MedinaClientOptions) {
  if (typeof input !== "string" && input?.tailscaleLogin) return input.tailscaleLogin;
  const logins = getProcessEnv("MEDINA_TAILSCALE_AUTH_LOGINS") ?? "";
  return logins.split(",").map((login) => login.trim()).filter(Boolean)[0];
}

function toKebabCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function normalizeMetadataKeys(metadata?: Record<string, string>): Record<string, string> {
  if (!metadata) return {};
  return Object.fromEntries(Object.entries(metadata).map(([k, v]) => [toKebabCase(k), v]));
}

function resolveUrl(target: string, base: string): string {
  if (/^https?:\/\//.test(target)) return target;
  return new URL(`/${target.replace(/^\/+/, "")}`, base).toString();
}

function isSameOrigin(url: string, base: string) {
  try {
    return new URL(url, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Medina request failed: HTTP ${response.status} ${response.statusText}${body ? ` ${body}` : ""}`);
  }
  return await response.json() as T;
}

export type IngestMetadata = Record<string, string>;

export type IngestDestination = {
  action: string;
  headers: Record<string, string>;
  ingestId: string;
  key: string;
  metadata: IngestMetadata;
  method: string;
};

export function createMedinaClient(input?: string | MedinaClientOptions) {
  const base = resolveBaseUrl(input);
  const token = resolveToken(input);
  const tailscaleLogin = resolveTailscaleLogin(input);
  const api = hc<ApiType>(base);

  function authHeaders(): Record<string, string> {
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tailscaleLogin ? { "Tailscale-User-Login": tailscaleLogin } : {}),
    };
  }

  function request(target: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(authHeaders())) headers.set(key, value);
    return fetch(resolveUrl(target, base), { ...init, headers });
  }

  async function json<T>(target: string, init: RequestInit = {}) {
    return jsonOrThrow<T>(await request(target, {
      ...init,
      headers: { accept: "application/json", ...Object.fromEntries(new Headers(init.headers)) },
    }));
  }

  function connectEvents(): WebSocket {
    const url = new URL(base);
    const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
    if (token) url.searchParams.set("token", token);
    return new WebSocket(`${wsScheme}//${url.host}/events${url.search}`);
  }

  async function createIngestDestination(options: {
    createdAt?: string;
    fileName?: string;
    metadata?: IngestMetadata;
    type: string;
  }): Promise<IngestDestination> {
    const extra = normalizeMetadataKeys(options.metadata);
    const metadata: IngestMetadata = {
      "created-at": options.createdAt ?? new Date().toISOString(),
      "original-filename": options.fileName ?? "",
      "sdk-version": SDK_VERSION,
      ...extra,
    };
    const response = await request("/in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata, type: options.type }),
    });
    const body = await jsonOrThrow<{
      action: string;
      headers?: Record<string, string>;
      ingestId?: string;
      key?: string;
      metadata?: IngestMetadata;
      method: string;
    }>(response);
    const key = body.key ?? (body.ingestId ? `in/${body.ingestId}` : undefined);

    if (!key) {
      throw new Error("Ingest destination response is missing key information.");
    }

    const ingestId = body.ingestId ?? key.replace(/^in\//, "");

    return {
      action: body.action,
      headers: body.headers ?? {},
      ingestId,
      key,
      metadata: body.metadata ?? metadata,
      method: body.method,
    };
  }

  async function uploadToDestination(destination: IngestDestination, body: BodyInit) {
    const headers = new Headers(destination.headers);
    if (isSameOrigin(destination.action, base)) {
      for (const [key, value] of Object.entries(authHeaders())) headers.set(key, value);
    }
    const response = await fetch(destination.action, {
      method: destination.method,
      headers,
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Medina upload failed: HTTP ${response.status} ${response.statusText}${text ? ` ${text}` : ""}`);
    }
    return response;
  }

  async function notifyUploadFinished(input: {
    contentType?: string;
    filename?: string;
    ingestId: string;
    ingestKey?: string;
    sizeBytes?: number;
    source?: string;
  }) {
    return json<{ eventId?: string; ok?: boolean }>("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "ingest-uploaded",
        ingestId: input.ingestId,
        ingestKey: input.ingestKey,
        contentType: input.contentType,
        filename: input.filename,
        sizeBytes: input.sizeBytes,
        source: input.source ?? SDK_VERSION,
      }),
    });
  }

  async function uploadIngest(options: {
    body: BodyInit;
    createdAt?: string;
    fileName?: string;
    metadata?: IngestMetadata;
    notify?: boolean;
    type: string;
  }): Promise<{ ingestId: string; key: string; metadata: IngestMetadata }> {
    const fileName = options.fileName ?? (options.body instanceof File ? options.body.name : undefined);
    if (!fileName) {
      throw new Error("Missing fileName for ingest metadata.");
    }
    const destination = await createIngestDestination({
      createdAt: options.createdAt,
      fileName,
      metadata: options.metadata,
      type: options.type,
    });
    await uploadToDestination(destination, options.body);
    if (options.notify) {
      await notifyUploadFinished({
        contentType: options.type,
        filename: fileName,
        ingestId: destination.ingestId,
        ingestKey: destination.key,
      });
    }
    return { ingestId: destination.ingestId, key: destination.key, metadata: destination.metadata };
  }

  return {
    api,
    authHeaders,
    baseUrl: base,
    connectEvents,
    createIngestDestination,
    getApiDocs: () => request("/api.md"),
    getEvents: (limit?: number) => json<unknown[]>(limit ? `/events.json?limit=${encodeURIComponent(String(limit))}` : "/events.json"),
    getInterval: (id: string) => json<unknown>(`/${id.replace(/\.json$/, "")}.json`),
    getIntervals: () => json<unknown[]>("/intervals.json"),
    getRecordings: () => json<unknown[]>("/recordings.json"),
    getAgentsGuide: () => request("/agents.md"),
    getSkill: () => request("/agents.md"),
    getStatus: () => json<unknown>("/status.json"),
    getTodos: () => json<unknown>("/todos.json"),
    getTranscripts: (query?: { from?: string; to?: string }) => {
      const params = new URLSearchParams();
      if (query?.from) params.set("from", query.from);
      if (query?.to) params.set("to", query.to);
      const suffix = params.size > 0 ? `?${params}` : "";
      return json<unknown[]>(`/transcripts.json${suffix}`);
    },
    json,
    notifyUploadFinished,
    request,
    uploadIngest,
    uploadToDestination,
  };
}

export type MedinaClient = ReturnType<typeof createMedinaClient>;
