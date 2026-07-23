import {
  getBucketEndpoint,
  getBucketName,
  getBucketRegion,
  type BucketConfigIdentity,
} from "./bucket";
import type { CurrentUser as AuthenticatedUser } from "./user";

export type CapabilityStatus = {
  configured: boolean;
  detail: string;
};

export function getCapabilities(): Record<string, CapabilityStatus> {
  const env = process.env;
  const gpsSummaryOff = env.MEDINA_GPS_SUMMARY_MODE === "off";
  const gpsSummaryConfigured = Boolean(env.MEDINA_GPS_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? env.OPENAI_BASE_URL ?? env.MEDINA_GPS_OPENAI_BASE_URL);
  return {
    gps_summary: gpsSummaryOff
      ? { configured: false, detail: "disabled via MEDINA_GPS_SUMMARY_MODE=off" }
      : gpsSummaryConfigured
        ? { configured: true, detail: "llm" }
        : { configured: false, detail: "missing OPENAI_API_KEY (fallback stats summary in use)" },
    transcription: env.DEEPGRAM_API_KEY
      ? { configured: true, detail: "deepgram" }
      : { configured: false, detail: "missing DEEPGRAM_API_KEY" },
  };
}

export type Status = {
  bucket_accessible?: boolean;
  bucket_id: string | null;
  capabilities: Record<string, CapabilityStatus>;
  current_user: {
    auth_method: AuthenticatedUser["auth_method"];
    credentials: AuthenticatedUser["credentials"];
    profile_pic_url: string;
    username: string;
  } | null;
  hostname: string | null;
  message: string;
  ok: boolean;
};

export type CurrentUser = AuthenticatedUser | null;

function publicCurrentUser(currentUser: AuthenticatedUser | null | undefined): Status["current_user"] {
  if (!currentUser) return null;
  return {
    auth_method: currentUser.auth_method,
    credentials: currentUser.credentials,
    profile_pic_url: currentUser.profile_pic_url,
    username: currentUser.username,
  };
}

export function getBucketIdFromConfig(config: BucketConfigIdentity): string | null {
  if (!config.bucket) {
    return null;
  }

  const region = config.region ?? "auto";

  if (!config.endpoint) {
    return `s3://${config.bucket}/${region}`;
  }

  try {
    const url = new URL(config.endpoint);
    const endpointId = `${url.host}${url.pathname}`.replace(/\/+$/, "");
    return `s3://${config.bucket}@${endpointId}/${region}`;
  } catch {
    return `s3://${config.bucket}@${config.endpoint.replace(/\/+$/, "")}/${region}`;
  }
}

function getBucketId() {
  return getBucketIdFromConfig({
    bucket: getBucketName(),
    endpoint: getBucketEndpoint(),
    region: getBucketRegion(),
  });
}

function getHostname(requestUrl?: string) {
  if (requestUrl) {
    try {
      return new URL(requestUrl).host;
    } catch {
      // Fall through to env-based inference when requestUrl is malformed.
    }
  }

  const medinaRoot = process.env.MEDINA_ROOT;
  if (!medinaRoot) {
    return null;
  }

  try {
    return new URL(medinaRoot).host;
  } catch {
    return null;
  }
}

export type StatusOptions = {
  bucketAccessible?: boolean;
  bucketId?: string | null;
};

export function getStatus(requestUrl?: string, currentUser?: CurrentUser, options?: StatusOptions): Status {
  const bucketId = options && "bucketId" in options ? options.bucketId ?? null : getBucketId();
  const bucketAccessible = options?.bucketAccessible;
  const ok = bucketAccessible !== false;
  
  return {
    bucket_accessible: bucketAccessible,
    bucket_id: bucketId,
    capabilities: getCapabilities(),
    current_user: publicCurrentUser(currentUser),
    hostname: getHostname(requestUrl),
    message: ok ? "all systems go (streams-v1)" : "bucket not accessible",
    ok,
  };
}
