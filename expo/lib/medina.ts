import Constants from "expo-constants";
import { Platform } from "react-native";
import { type ServerEvent } from "./events";
import { getMedinaAuthHeaders, getMedinaToken, getServerUrl } from "./settings";

export type Transcript = {
  chunkKey: string;
  endTime: string;
  startTime: string;
  text: string;
  timeZone?: string;
  timeZoneSource?: "gps" | "carry-forward" | "default";
  transcriptKey: string;
};

export type GpsDaySegment = {
  endTime: string;
  kind: "stay" | "travel";
  startTime: string;
  timeZone: string;
  distanceMeters?: number;
  mode?: string;
  place?: string;
};

export type GpsDay = {
  collapsedCount: number;
  dayId: string;
  dominantTimeZone: string;
  generatedAt: string;
  multiZone: boolean;
  rawCount: number;
  segments: GpsDaySegment[];
  summary: string;
  timeline: string[];
  timeZoneCoverage: Array<{ seconds: number; timeZone: string }>;
  timeZoneFallbackUsed: boolean;
  warnings: string[];
};

export type IntervalSummary = {
  coverageSeconds: number;
  durationSeconds: number;
  endTime: string;
  id: string;
  startTime: string;
};

export type ServerStatus = {
  bucket_id: string | null;
  current_user: {
    auth_method: "token" | "tailscale" | "agent";
    credentials: Array<{ type: string; value: string }>;
    profile_pic_url: string;
    username: string;
  } | null;
  hostname: string | null;
  message: string;
  ok: boolean;
  [key: string]: unknown;
};

export type IngestForm = {
  ingestId: string;
  form: {
    action: string;
    method: "POST" | "PUT";
    headers?: Record<string, string>;
  };
  key: string;
};

export type SpeakerSample = {
  contentType: string;
  createdAt: string;
  key: string;
  name: string;
  size: number;
};

export type Speaker = {
  createdAt: string;
  id: string;
  name: string;
  notes?: string;
  sampleCount: number;
  samples: SpeakerSample[];
  updatedAt: string;
};

function normalizeMetadata(metadata?: Record<string, string>): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = rawKey.trim().toLowerCase();
    const value = String(rawValue).trim();
    if (!key || !value) continue;
    normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function addAppSourceMetadata(options?: { filename?: string; metadata?: Record<string, string> }): Record<string, string> {
  const normalized = normalizeMetadata(options?.metadata) || {};
  const version =
    Constants.expoConfig?.version ||
    Constants.manifest2?.extra?.expoClient?.version ||
    "0.0.0-dev";
  const sdkVersion = `medina-app/${version}`;
  normalized["sdk-version"] ||= sdkVersion;
  normalized["original-filename"] ||= options?.filename ?? "";
  normalized["created-at"] ||= normalized["startsat"] || new Date().toISOString();
  normalized.source ||= `${sdkVersion}; platform=${Platform.OS}`;
  return normalized;
}


async function readErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = await res.json() as { message?: unknown; error?: unknown };
    return typeof body.message === "string"
      ? body.message
      : typeof body.error === "string"
        ? body.error
        : null;
  } catch {
    return null;
  }
}

async function validateProtectedAccess(): Promise<void> {
  const token = getMedinaToken();
  if (!token) {
    throw new Error("Token is required. Enter your Medina token.");
  }

  const url = new URL(`${getServerUrl()}/events.json`);
  url.searchParams.set("limit", "1");
  const res = await fetch(url.toString(), {
    headers: getMedinaAuthHeaders(token),
  });
  if (res.ok) return;

  const message = await readErrorMessage(res);
  if (res.status === 401) throw new Error(message || "Token is required. Enter your Medina token.");
  if (res.status === 403) throw new Error(message || "Invalid Medina token.");
  throw new Error(message || `Token validation failed: ${res.status}`);
}

export async function getEvents(limit?: number): Promise<ServerEvent[]> {
  const url = new URL(`${getServerUrl()}/events.json`);
  if (limit) url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString(), {
    headers: getMedinaAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Events request failed: ${res.status}`);
  return res.json();
}

export async function getTranscripts(options: { from?: string; to?: string } = {}): Promise<Transcript[]> {
  const url = new URL(`${getServerUrl()}/transcripts.json`);
  if (options.from) url.searchParams.set("from", options.from);
  if (options.to) url.searchParams.set("to", options.to);
  const res = await fetch(url.toString(), {
    headers: getMedinaAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Transcripts request failed: ${res.status}`);
  return res.json();
}

export async function getDayTranscripts(dayId: string): Promise<Transcript[]> {
  const res = await fetch(`${getServerUrl()}/transcripts/${dayId}.json`, {
    headers: getMedinaAuthHeaders(),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Day transcripts request failed: ${res.status}`);
  return res.json();
}

export function getDayMapUrl(dayId: string): string {
  const file = Platform.OS === "web" ? "map.svg" : "map.png";
  const url = new URL(`${getServerUrl()}/${dayId}/${file}`);
  const token = getMedinaToken();
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export async function getDayGps(dayId: string): Promise<GpsDay | null> {
  const res = await fetch(`${getServerUrl()}/${dayId}/gps.json`, {
    headers: getMedinaAuthHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GPS request failed: ${res.status}`);
  const gps = await res.json() as GpsDay;
  if (gps.segments.length === 0 && gps.warnings.includes("no-gps")) return null;
  return gps;
}

export async function getIntervalSummary(id: string): Promise<IntervalSummary> {
  const res = await fetch(`${getServerUrl()}/${id}.json`, {
    headers: getMedinaAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Interval request failed: ${res.status}`);
  return res.json();
}

export async function getStatus(): Promise<ServerStatus> {
  const res = await fetch(`${getServerUrl()}/status.json`, {
    headers: getMedinaAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
  const status = await res.json() as ServerStatus;
  await validateProtectedAccess();
  return status;
}

export async function getSpeakers(): Promise<Speaker[]> {
  const res = await fetch(`${getServerUrl()}/speakers.json`, {
    headers: getMedinaAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Speakers request failed: ${res.status}`);
  return res.json();
}

export async function createSpeaker(input: { name: string; notes?: string }): Promise<Speaker> {
  const res = await fetch(`${getServerUrl()}/speakers`, {
    body: JSON.stringify(input),
    headers: { ...getMedinaAuthHeaders(), "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok) throw new Error(`Create speaker failed: ${res.status}`);
  return res.json();
}

export async function updateSpeaker(id: string, input: { name: string; notes?: string }): Promise<Speaker> {
  const res = await fetch(`${getServerUrl()}/speakers/${id}`, {
    body: JSON.stringify(input),
    headers: { ...getMedinaAuthHeaders(), "content-type": "application/json" },
    method: "PUT",
  });
  if (!res.ok) throw new Error(`Update speaker failed: ${res.status}`);
  return res.json();
}

export async function deleteSpeaker(id: string): Promise<void> {
  const res = await fetch(`${getServerUrl()}/speakers/${id}`, {
    headers: getMedinaAuthHeaders(),
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Delete speaker failed: ${res.status}`);
}

export async function uploadSpeakerSample(id: string, file: { arrayBuffer(): Promise<ArrayBuffer>; name?: string; type?: string }): Promise<Speaker> {
  const filename = file.name || `sample-${Date.now()}.ogg`;
  const url = new URL(`${getServerUrl()}/speakers/${id}/samples`);
  url.searchParams.set("filename", filename);
  const res = await fetch(url.toString(), {
    body: await file.arrayBuffer(),
    headers: {
      ...getMedinaAuthHeaders(),
      "content-type": file.type || "application/octet-stream",
    },
    method: "POST",
  });
  if (!res.ok) throw new Error(`Upload sample failed: ${res.status}`);
  return res.json();
}

export async function deleteSpeakerSample(id: string, sampleName: string): Promise<Speaker> {
  const res = await fetch(`${getServerUrl()}/speakers/${id}/samples/${encodeURIComponent(sampleName)}`, {
    headers: getMedinaAuthHeaders(),
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Delete sample failed: ${res.status}`);
  return res.json();
}

export async function requestIngestForm(options?: {
  filename?: string;
  contentType?: string;
  metadata?: Record<string, string>;
}): Promise<IngestForm> {
  const metadata = addAppSourceMetadata({ filename: options?.filename, metadata: options?.metadata });
  const res = await fetch(`${getServerUrl()}/in`, {
    body: JSON.stringify({
      metadata,
      type: options?.contentType || "application/octet-stream",
    }),
    headers: {
      ...getMedinaAuthHeaders(),
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!res.ok) throw new Error(`Ingest form request failed: ${res.status}`);
  const destination = await res.json() as {
    action: string;
    headers?: Record<string, string>;
    ingestId: string;
    key: string;
    method: "POST" | "PUT";
  };

  return {
    form: {
      action: destination.action,
      headers: destination.headers,
      method: destination.method,
    },
    ingestId: destination.ingestId,
    key: destination.key,
  };
}

export async function notifyUploadFinished(
  ingestId: string,
  file: { ingestKey?: string; sizeBytes: number; filename: string },
): Promise<void> {
  const res = await fetch(`${getServerUrl()}/events`, {
    method: "POST",
    headers: { ...getMedinaAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "ingest-uploaded",
      ingestId,
      ingestKey: file.ingestKey,
      filename: file.filename,
      sizeBytes: file.sizeBytes,
    }),
  });
  if (!res.ok) throw new Error(`Notify upload failed: ${res.status}`);
}

export type SourceConfig = {
  id: string;
  type: string;
  enabled: boolean;
  extensions: string[];
  account?: string | null;
  folderId?: string;
  path?: string;
  connectedAt?: string;
  lastSyncAt?: string | null;
  lastSyncStartedAt?: string | null;
  lastSyncError?: string | null;
  lastSyncSummary?: { queued: number; skipped: number; errors: number; finishedAt: string } | null;
};

export type SourcesResponse = { sources: SourceConfig[] };

export async function getSources(): Promise<SourcesResponse> {
  const res = await fetch(`${getServerUrl()}/sources.json`, { headers: getMedinaAuthHeaders() });
  if (!res.ok) throw new Error(`Sources request failed: ${res.status}`);
  return res.json();
}

export async function getSource(id: string): Promise<SourceConfig> {
  const res = await fetch(`${getServerUrl()}/sources/${encodeURIComponent(id)}.json`, { headers: getMedinaAuthHeaders() });
  if (!res.ok) throw new Error(`Source request failed: ${res.status}`);
  return res.json();
}

export function connectGoogleUrl(options: { sourceId?: string } = {}): string {
  const url = new URL(`${getServerUrl()}/connect/google`);
  if (options.sourceId) url.searchParams.set("sourceId", options.sourceId);
  return url.toString();
}

export async function updateSource(id: string, patch: Record<string, unknown>): Promise<SourceConfig> {
  const res = await fetch(`${getServerUrl()}/sources/${id}`, {
    body: JSON.stringify(patch),
    headers: { ...getMedinaAuthHeaders(), "content-type": "application/json" },
    method: "PUT",
  });
  if (!res.ok) throw new Error(`Update source failed: ${res.status}`);
  return res.json();
}

export async function deleteSource(id: string): Promise<void> {
  const res = await fetch(`${getServerUrl()}/sources/${id}`, {
    headers: getMedinaAuthHeaders(),
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Delete source failed: ${res.status}`);
}

export async function syncSource(id: string): Promise<{ sourceId: string; type: string; synced: boolean; summary: SourceConfig["lastSyncSummary"] }> {
  const res = await fetch(`${getServerUrl()}/sources/${id}/sync`, {
    headers: getMedinaAuthHeaders(),
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    throw new Error(body?.message ?? `Source sync failed: ${res.status}`);
  }
  return res.json();
}
