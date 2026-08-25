export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  md5Checksum?: string;
  size?: string;
};

async function token(env: Env) {
  const response = await fetch(env.GOOGLE_TOKEN_URL, { method: "POST" });
  if (!response.ok) throw new Error(`Google token request failed: ${response.status}`);
  return (await response.json<{ access_token: string }>()).access_token;
}

async function google(env: Env, path: string) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    headers: { Authorization: `Bearer ${await token(env)}` },
  });
  if (!response.ok) throw new Error(`Google Drive request failed: ${response.status}`);
  return response;
}

export async function listDriveFiles(env: Env, folderId: string) {
  const query = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    orderBy: "modifiedTime desc",
    pageSize: "100",
    fields: "files(id,name,mimeType,modifiedTime,md5Checksum,size)",
  });
  const response = await google(env, `files?${query}`);
  const { files } = await response.json<{ files: DriveFile[] }>();
  return files.filter((file) => !file.mimeType.startsWith("application/vnd.google-apps."));
}

export async function downloadDriveFile(env: Env, id: string) {
  return google(env, `files/${encodeURIComponent(id)}?alt=media`);
}
