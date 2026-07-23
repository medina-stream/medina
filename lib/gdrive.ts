export const googleDriveConnectionKey = "connections/google-drive.json";
const googleDrivePendingKey = "connections/google-drive-pending.json";

const googleAuthBase = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenEndpoint = "https://oauth2.googleapis.com/token";
const googleUserInfoEndpoint = "https://www.googleapis.com/oauth2/v2/userinfo";
const googleDriveFilesEndpoint = "https://www.googleapis.com/drive/v3/files";

const driveReadonlyScope = "https://www.googleapis.com/auth/drive.readonly";
const userinfoScopes = ["openid", "https://www.googleapis.com/auth/userinfo.email"];
export const googleDriveScopes = [...userinfoScopes, driveReadonlyScope].join(" ");

type FetchLike = typeof fetch;

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  modifiedTime: string;
  size?: string;
};

function getEnv(name: string, env: Record<string, string | undefined> = process.env) {
  return env[name];
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function requireGoogleCredentials(env: Record<string, string | undefined> = process.env) {
  const clientId = getEnv("GOOGLE_CLIENT_ID", env);
  const clientSecret = getEnv("GOOGLE_CLIENT_SECRET", env);
  if (!clientId || !clientSecret) {
    throw new Error("Google Drive connection requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }
  return { clientId, clientSecret };
}

export type GdrivePendingPayload = {
  folderId?: string;
  sourceId?: string;
};

export async function createPendingState(bucket: import("./bucket").Bucket, payload: GdrivePendingPayload = {}) {
  const state = crypto.randomUUID();
  const pending = { state, createdAt: nowIso(), payload };
  await bucket.write(googleDrivePendingKey, JSON.stringify(pending), { type: "application/json; charset=utf-8" });
  return state;
}

export async function consumePendingState(bucket: import("./bucket").Bucket, state: string): Promise<GdrivePendingPayload | null> {
  if (!(await bucket.exists(googleDrivePendingKey))) return null;
  const pending = await bucket.readJson<{ state: string; createdAt: string; payload?: GdrivePendingPayload }>(googleDrivePendingKey);
  await bucket.delete(googleDrivePendingKey);
  if (pending.state !== state) return null;
  const createdAt = new Date(pending.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  if (Date.now() - createdAt.getTime() > 10 * 60 * 1000) return null;
  return pending.payload ?? {};
}

export function buildAuthorizationUrl(redirectUri: string, env: Record<string, string | undefined> = process.env) {
  const { clientId } = requireGoogleCredentials(env);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: googleDriveScopes,
    access_type: "offline",
    prompt: "consent",
  });
  return `${googleAuthBase}?${params.toString()}`;
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  redirectUri: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}) {
  const { clientId, clientSecret } = requireGoogleCredentials(input.env);
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    code: input.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetchImpl(googleTokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${await response.text()}`);
  }
  const token = (await response.json()) as { refresh_token?: string; access_token?: string; scope?: string };
  if (!token.refresh_token) {
    throw new Error("Google did not return a refresh token. Revoke access in Google settings and try again.");
  }
  return { refreshToken: token.refresh_token, accessToken: token.access_token ?? "", scope: token.scope ?? googleDriveScopes };
}

export async function refreshAccessToken(
  refreshToken: string,
  options: { env?: Record<string, string | undefined>; fetchImpl?: FetchLike } = {},
) {
  const { clientId, clientSecret } = requireGoogleCredentials(options.env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const response = await fetchImpl(googleTokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${response.status} ${await response.text()}`);
  }
  const token = (await response.json()) as { access_token: string };
  return token.access_token;
}

export async function fetchUserEmail(accessToken: string, fetchImpl: FetchLike): Promise<string | null> {
  const response = await fetchImpl(googleUserInfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const info = (await response.json()) as { email?: string };
  return info.email ?? null;
}

const googleNativeExportMime: Record<string, { mimeType: string; ext: string }> = {
  "application/vnd.google-apps.document": { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
  "application/vnd.google-apps.spreadsheet": { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
  "application/vnd.google-apps.presentation": { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" },
  "application/vnd.google-apps.drawing": { mimeType: "image/png", ext: ".png" },
};

export function isGoogleNativeDocument(mimeType: string) {
  return mimeType in googleNativeExportMime;
}

export function exportTargetForFile(file: DriveFile): { mimeType: string; filename: string } | null {
  const spec = googleNativeExportMime[file.mimeType];
  if (!spec) return null;
  const base = file.name.toLowerCase().endsWith(spec.ext) ? file.name : `${file.name}${spec.ext}`;
  return { mimeType: spec.mimeType, filename: base };
}

export async function listDriveFiles(input: {
  folderId: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<DriveFile[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${input.folderId}' in parents and trashed = false`,
      pageSize: "1000",
      fields: "nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime,size)",
      orderBy: "modifiedTime desc",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetchImpl(`${googleDriveFilesEndpoint}?${params.toString()}`, {
      headers: { authorization: `Bearer ${input.accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Google Drive list failed: ${response.status} ${await response.text()}`);
    }
    const page = (await response.json()) as { nextPageToken?: string; files?: DriveFile[] };
    for (const file of page.files ?? []) {
      if (file.mimeType === "application/vnd.google-apps.shortcut") continue;
      files.push(file);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return files;
}

export async function downloadDriveFile(input: {
  file: DriveFile;
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<ArrayBuffer> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const exportTarget = exportTargetForFile(input.file);
  const params = new URLSearchParams({ supportsAllDrives: "true" });
  if (exportTarget) {
    params.set("mimeType", exportTarget.mimeType);
    const response = await fetchImpl(
      `${googleDriveFilesEndpoint}/${encodeURIComponent(input.file.id)}/export?${params.toString()}`,
      { headers: { authorization: `Bearer ${input.accessToken}` } },
    );
    if (!response.ok) throw new Error(`Drive export failed for ${input.file.name}: ${response.status}`);
    return response.arrayBuffer();
  }
  params.set("alt", "media");
  const response = await fetchImpl(
    `${googleDriveFilesEndpoint}/${encodeURIComponent(input.file.id)}?${params.toString()}`,
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (!response.ok) throw new Error(`Drive download failed for ${input.file.name}: ${response.status}`);
  return response.arrayBuffer();
}
