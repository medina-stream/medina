/**
 * Drive sources (migration §4.3 step 10) — first piece: the
 * visibility-parity probe for the dedicated service account.
 *
 * medina-dev's Drive stages authenticate through a broker
 * (GOOGLE_TOKEN_URL) whose credential is Scott's own. The move
 * replaces it with a dedicated service account —
 * medina-drive-reader@medina-492522.iam.gserviceaccount.com — whose
 * email + private key sit in the Cloudflare Secrets Store
 * (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
 * attached out-of-band by scripts/reattach-secrets.ts; the values
 * never transit the repo or this code's logs). The Worker exchanges
 * a signed JWT for an access token itself (RS256 via WebCrypto).
 *
 * The probe answers the cutover's gating question — does the new
 * account see everything the broker credential sees? — by running
 * the server's own listAll query (lib/Drive.ts: q = "trashed =
 * false", pageSize 1000, same fields) and summarizing: counts,
 * total bytes, folder names, and a sha256 over the sorted file ids,
 * directly comparable to the same summary computed from the
 * broker's inventory (inventory/drive/latest.json, or a live
 * broker listAll). Read-only: it lists metadata, downloads
 * nothing, writes nothing.
 *
 * The full sources port (audio-drive, drive-allow, inventory on
 * the pipeline cadence) builds on the token exchange below.
 */

export interface DriveProbeSummary {
  readonly total: number;
  readonly files: number;
  readonly folders: number;
  readonly totalBytes: number;
  readonly idsHash: string;
  readonly folderNames: ReadonlyArray<string>;
}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const base64UrlJson = (value: unknown): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

/** PEM (PKCS8) → DER bytes. Tolerates literal "\n" escapes, the
 * form a dashboard paste can produce. */
const pemToDer = (pem: string): Uint8Array => {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
};

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** Service-account JWT exchange: sign (iss = the account email,
 * scope = read-only Drive, aud = the token endpoint), POST the
 * assertion, return the access token. Throws Error on any failure;
 * the message carries the HTTP status only, never key material. */
export const serviceAccountAccessToken = async (
  email: string,
  privateKeyPem: string,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem) as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({
    iss: email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(`token exchange failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (typeof body.access_token !== "string") {
    throw new Error("token exchange returned no access_token");
  }
  return body.access_token;
};

interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: string;
}

/** The server's listAll, verbatim query shape (lib/Drive.ts). */
export const listAllDrive = async (
  accessToken: string,
): Promise<ReadonlyArray<DriveFile>> => {
  const items: Array<DriveFile> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: "trashed = false",
      pageSize: "1000",
      fields:
        "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,parents)",
    });
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const response = await fetch(`${FILES_URL}?${params}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`files.list failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      files?: ReadonlyArray<DriveFile>;
      nextPageToken?: string;
    };
    items.push(...(body.files ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken !== undefined);
  return items;
};

export const summarizeDrive = async (
  items: ReadonlyArray<DriveFile>,
): Promise<DriveProbeSummary> => {
  const folders = items.filter((item) => item.mimeType === FOLDER_MIME);
  const files = items.filter((item) => item.mimeType !== FOLDER_MIME);
  const ids = items.map((item) => item.id).sort();
  return {
    total: items.length,
    files: files.length,
    folders: folders.length,
    totalBytes: files.reduce(
      (sum, file) => sum + (file.size === undefined ? 0 : Number(file.size)),
      0,
    ),
    idsHash: await sha256Hex(ids.join("\n")),
    folderNames: folders.map((folder) => folder.name).sort(),
  };
};

/** The parity probe: exchange + listAll + summary. */
export const driveVisibilityProbe = async (
  email: string,
  privateKeyPem: string,
): Promise<DriveProbeSummary> => {
  const accessToken = await serviceAccountAccessToken(email, privateKeyPem);
  return summarizeDrive(await listAllDrive(accessToken));
};
