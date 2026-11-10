/**
 * Drive sources (migration §4.3 step 10): the visibility-parity
 * probe, and the port of medina-dev's three Drive sources —
 * `audio-drive`, `drive-allow`, `drive-inventory` — to the Worker.
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
 * The sources port mirrors the server's three sources one for one
 * (lib/capture/Audio.ts, lib/capture/DriveAllow.ts, lib/Drive.ts):
 *
 *   - audio-drive: the newest SOURCE_LATEST files of the one
 *     configured folder (GDRIVE_FOLDER_ID — Easy Voice Recorder),
 *     by Drive id, never by folder name (the account also sees a
 *     same-named twin "AudioRec Recordings" folder; nothing here
 *     matches on names). Audio files are downloaded, hashed
 *     (sha256 = the capture id), stored as capture blobs with
 *     provenance and an ingest receipt — the server's exact
 *     artifacts at the server's exact keys.
 *   - drive-allow: the allowlist (allow/drive.json) intersected
 *     with the live listing; each listed file is imported by
 *     Transloadit straight from Drive to R2 (Medina never
 *     downloads those bytes), then chunked and settled by the
 *     same machinery the normalize stage uses, and finalized
 *     with provenance + the source receipt.
 *   - drive-inventory: the hourly metadata crawl of everything
 *     the credential can see, rewritten to
 *     inventory/drive/latest.json when the entries change.
 *     Inspection, not ingestion: it reads no file content.
 *
 * Modes follow the house pattern: "shadow" discovers and compares
 * without writing or firing anything (the rehearsal); "live"
 * performs, with medina-dev's sources standing down in the same
 * batch (MEDINA_SOURCES without "audio" / "allow" / "inventory").
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ArtifactIndex,
  ArtifactLedger,
  ArtifactReadError,
  IndexRequestError,
  NotebookError,
  appendProvenanceRecord,
  contentTypeForKey,
  parseReceipt,
  type SecretsStoreSecretLike,
} from "./capture.ts";
import {
  ArtifactCatalog,
  type CatalogError,
  type CatalogHead,
  type CatalogObject,
} from "./catalog.ts";
import {
  ChunkValidationError,
  MAX_CHUNK_ATTEMPTS,
  MEDIA_VERSION,
  NormalizeData,
  NormalizeVendor,
  assemblyState,
  fireChunkReceipt,
  manifestFromChunkListing,
  manifestJson,
  mediaChunkPrefix,
  mediaManifestKey,
  parseTransloaditReceipt,
  receiptJson,
  resultDuration,
  type TransloaditReceiptShape,
} from "./normalize.ts";
import {
  accountIdFromEndpoint,
  mintTempCredentials,
  type S3CredentialsValue,
} from "./r2creds.ts";

/** The slices of the normalize stage's services the allowlist
 * flow consumes, as structural shapes (the full services ride
 * the pass's environment for fireChunkReceipt, which yields
 * them itself). */
interface DriveVendorShape {
  readonly configured: boolean;
  readonly authKey: Effect.Effect<string | null, unknown>;
  readonly createAssembly: (
    params: Record<string, unknown>,
  ) => Effect.Effect<
    { readonly assemblyId: string; readonly assemblySslUrl: string },
    unknown
  >;
  readonly getAssembly: (
    assemblyId: string,
  ) => Effect.Effect<unknown, unknown>;
}

interface DriveNormalizeDataShape {
  readonly s3Credentials: S3CredentialsValue | null;
  readonly listChunks: (
    prefix: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly key: string; readonly size: number }>,
    unknown
  >;
}

// ---------------------------------------------------------------------------
// The probe (step 10 groundwork): token exchange + listAll + summary.
// ---------------------------------------------------------------------------

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

/** One Drive file/item as the API returns it (lib/Drive.ts's
 * DriveFile + DriveItem fields, one shape for both). */
export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modifiedTime: string;
  readonly md5Checksum?: string;
  readonly size?: string;
  readonly parents?: ReadonlyArray<string>;
}

/** The server's listAll, verbatim query shape (lib/Drive.ts). The
 * query can be overridden for diagnostics (the parity probe's
 * `sharedWithMe` cross-check). */
export const listAllDrive = async (
  accessToken: string,
  query = "trashed = false",
): Promise<ReadonlyArray<DriveFile>> => {
  const items: Array<DriveFile> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: query,
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
  query?: string,
): Promise<DriveProbeSummary> => {
  const accessToken = await serviceAccountAccessToken(email, privateKeyPem);
  return summarizeDrive(await listAllDrive(accessToken, query));
};

// ---------------------------------------------------------------------------
// The Drive client the sources use (lib/Drive.ts's remaining verbs).
// ---------------------------------------------------------------------------

/** The server's `list`, verbatim (lib/Drive.ts): one page of a
 * folder's children, newest first, Google-apps files filtered
 * out. */
export const listDriveFolder = async (
  accessToken: string,
  folderId: string,
  pageSize: number,
): Promise<ReadonlyArray<DriveFile>> => {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    orderBy: "modifiedTime desc",
    pageSize: String(pageSize),
    fields: "files(id,name,mimeType,modifiedTime,md5Checksum,size)",
  });
  const response = await fetch(`${FILES_URL}?${params}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`files.list failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    files?: ReadonlyArray<DriveFile>;
  };
  return (body.files ?? []).filter(
    (file) => !file.mimeType.startsWith("application/vnd.google-apps."),
  );
};

/** The media download (lib/Drive.ts's `download`): the file's
 * bytes as a stream — hours-long recordings are never buffered
 * whole. */
export const downloadDriveFile = async (
  accessToken: string,
  fileId: string,
): Promise<ReadableStream> => {
  const response = await fetch(
    `${FILES_URL}/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok || response.body === null) {
    throw new Error(
      `files.get (media) failed: HTTP ${response.status}`,
    );
  }
  return response.body;
};

/** The import request (lib/Drive.ts's `importRequest`): the media
 * URL plus the short-lived authorization header Transloadit
 * imports with. The header is ephemeral — it goes to Transloadit
 * inside the assembly params and is never persisted or logged. */
export const driveImportRequest = (
  accessToken: string,
  fileId: string,
): { readonly url: string; readonly headers: ReadonlyArray<string> } => ({
  url: `${FILES_URL}/${encodeURIComponent(fileId)}?alt=media`,
  headers: [`Authorization: Bearer ${accessToken}`],
});

// ---------------------------------------------------------------------------
// Key recipes — the server's, verbatim (lib/lifelog/Resources.ts,
// lib/capture/TransloaditNormalize.ts, lib/capture/DriveAllow.ts).
// ---------------------------------------------------------------------------

export const AUDIO_DRIVE_SOURCE = "audio-drive";
export const DRIVE_ALLOW_SOURCE = "drive-allow";
export const DRIVE_INVENTORY_KEY = "inventory/drive/latest.json";
export const DRIVE_ALLOWLIST_KEY = "allow/drive.json";

const TRANSCRIPT_VERSION = "assemblyai-u35p-v1";
const WORKFLOW_VERSION = "remote-media-v1";
const JOB_TTL_SECONDS = 24 * 60 * 60;

const sanitizeIdPart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "");

/** Resources.ts `ingestId`. */
export const driveIngestId = (
  sourceName: string,
  fileId: string,
  version: string,
): string => sanitizeIdPart(`${sourceName}-${fileId}-${version}`);

/** Resources.ts `ingestReceiptKey`. */
export const driveIngestReceiptKey = (
  sourceName: string,
  fileId: string,
  version: string,
): string =>
  `ingest/${sourceName}/${sanitizeIdPart(`${fileId}-${version}`)}.json`;

/** TransloaditNormalize.ts `transloaditDriveReceiptKey`. */
export const driveJobReceiptKey = (
  fileId: string,
  version: string,
): string =>
  `ingest/drive-allow-transloadit/${sanitizeIdPart(`${fileId}-${version}`)}.json`;

export const driveCaptureDir = (captureId: string): string =>
  `capture/${captureId}`;

export const driveProvenanceKey = (captureId: string): string =>
  `${driveCaptureDir(captureId)}/provenance.json`;

/** Resources.ts `captureBlobName`. */
export const driveCaptureBlobName = (filename: string): string => {
  const name = filename.replace(/[/\\]/g, "_");
  return name === "provenance.json" || name.startsWith(".tmp-")
    ? `_${name}`
    : name;
};

export const driveCaptureBlobKey = (
  captureId: string,
  filename: string,
): string =>
  `${driveCaptureDir(captureId)}/${driveCaptureBlobName(filename)}`;

/** Resources.ts `transcriptKey` — the grandfather probe. */
export const driveTranscriptKey = (ingestId: string): string =>
  `transcript/${TRANSCRIPT_VERSION}/${ingestId}.json`;

/** A Drive file's ingest version (Audio.ts): its checksum when
 * Drive reports one, else its modified time. */
export const driveFileVersion = (file: DriveFile): string =>
  file.md5Checksum ?? file.modifiedTime;

const mediaMime = (mimeType: string): boolean =>
  mimeType.startsWith("audio/") || mimeType.startsWith("video/");

// ---------------------------------------------------------------------------
// The inventory build (lib/capture/DriveAllow.ts, verbatim logic).
// ---------------------------------------------------------------------------

export interface DriveInventoryEntry {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly mimeType: string;
  readonly modifiedTime: string;
  readonly size: number | null;
  readonly md5Checksum: string | null;
}

export interface DriveInventoryShape {
  readonly crawledAt: string;
  readonly fileCount: number;
  readonly folderCount: number;
  readonly totalBytes: number;
  readonly entries: ReadonlyArray<DriveInventoryEntry>;
}

/** Resolve each item's folder path from the parents graph
 * (DriveAllow.ts `resolvePaths`). Folders outside the visible
 * set truncate the path rather than failing. */
export const resolveDrivePaths = (
  items: ReadonlyArray<DriveFile>,
): ReadonlyMap<string, string> => {
  const folders = new Map(
    items
      .filter((item) => item.mimeType === FOLDER_MIME)
      .map((item) => [item.id, item]),
  );
  const memo = new Map<string, string>();
  const folderPath = (id: string, seen: ReadonlySet<string>): string => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const folder = folders.get(id);
    if (folder === undefined || seen.has(id)) return "";
    const parent = folder.parents?.[0];
    const above =
      parent === undefined ? "" : folderPath(parent, new Set([...seen, id]));
    const path = above === "" ? folder.name : `${above}/${folder.name}`;
    memo.set(id, path);
    return path;
  };
  const paths = new Map<string, string>();
  for (const item of items) {
    const parent = item.parents?.[0];
    paths.set(item.id, parent === undefined ? "" : folderPath(parent, new Set()));
  }
  return paths;
};

/** DriveAllow.ts `buildInventory`, with the crawl instant passed
 * in (the server's is the write instant). */
export const buildDriveInventory = (
  items: ReadonlyArray<DriveFile>,
  crawledAt: string,
): DriveInventoryShape => {
  const paths = resolveDrivePaths(items);
  const entries = items
    .map((item) => ({
      id: item.id,
      name: item.name,
      path: paths.get(item.id) ?? "",
      mimeType: item.mimeType,
      modifiedTime: item.modifiedTime,
      size: item.size === undefined ? null : Number(item.size),
      md5Checksum: item.md5Checksum ?? null,
    }))
    .sort((a, b) =>
      `${a.path}/${a.name}`.localeCompare(`${b.path}/${b.name}`),
    );
  return {
    crawledAt,
    fileCount: entries.filter((entry) => entry.mimeType !== FOLDER_MIME)
      .length,
    folderCount: entries.filter((entry) => entry.mimeType === FOLDER_MIME)
      .length,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
    entries,
  };
};

/** The inventory document as the server serializes it (the
 * DriveInventory schema class's field order). */
export const driveInventoryJson = (
  inventory: DriveInventoryShape,
): string =>
  JSON.stringify({
    crawledAt: inventory.crawledAt,
    fileCount: inventory.fileCount,
    folderCount: inventory.folderCount,
    totalBytes: inventory.totalBytes,
    entries: inventory.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      path: entry.path,
      mimeType: entry.mimeType,
      modifiedTime: entry.modifiedTime,
      size: entry.size,
      md5Checksum: entry.md5Checksum,
    })),
  });

// ---------------------------------------------------------------------------
// Streaming hashes and uploads: Drive downloads can be hundreds
// of MB, so the bytes move as streams throughout — hashed via
// DigestStream where the runtime offers it, landed in R2 via
// multipart upload in 8 MiB parts.
// ---------------------------------------------------------------------------

const hexOf = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** sha256 of a web stream, hex. Uses workerd's DigestStream when
 * present; the fallback buffers (correct anywhere, and what the
 * tests exercise with small fixtures). */
export const sha256OfStream = async (
  body: ReadableStream,
): Promise<string> => {
  const DigestStream = (
    crypto as unknown as {
      DigestStream?: new (
        algorithm: string,
      ) => WritableStream & { readonly digest: Promise<ArrayBuffer> };
    }
  ).DigestStream;
  if (typeof DigestStream === "function") {
    const stream = new DigestStream("SHA-256");
    const digest = stream.digest;
    await body.pipeTo(stream);
    return hexOf(new Uint8Array(await digest));
  }
  const bytes = new Uint8Array(
    await new Response(body).arrayBuffer(),
  );
  return hexOf(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
};

export interface MultipartUploadLike {
  readonly uploadId: string;
  uploadPart(
    partNumber: number,
    value: Uint8Array,
  ): Promise<{ readonly etag: string }>;
  complete(
    parts: ReadonlyArray<{
      readonly partNumber: number;
      readonly etag: string;
    }>,
  ): Promise<unknown>;
  abort(): Promise<void>;
}

export interface DriveBucketLike {
  head(key: string): Promise<unknown>;
  get(key: string): Promise<unknown>;
  put(
    key: string,
    value: string | Uint8Array,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
    },
  ): Promise<unknown>;
  list(options: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly delimiter?: string;
  }): Promise<unknown>;
  createMultipartUpload?(
    key: string,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
    },
  ): Promise<MultipartUploadLike>;
}

const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

/** Land a stream in R2 under `key` through a multipart upload,
 * resolving to the byte count written. Constant memory (one
 * part buffer). Aborts the upload on any failure, so a partial
 * object never lands. */
export const putStreamMultipart = async (
  bucket: DriveBucketLike,
  key: string,
  body: ReadableStream,
  contentType: string,
): Promise<number> => {
  if (bucket.createMultipartUpload === undefined) {
    throw new Error("the artifact bucket binding has no multipart upload");
  }
  const upload = await bucket.createMultipartUpload(key, {
    httpMetadata: { contentType },
  });
  try {
    const reader = body.getReader();
    const parts: Array<{ partNumber: number; etag: string }> = [];
    let total = 0;
    let chunks: Array<Uint8Array> = [];
    let buffered = 0;
    const emit = async (): Promise<void> => {
      const merged = new Uint8Array(buffered);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const part = await upload.uploadPart(parts.length + 1, merged);
      parts.push({ partNumber: parts.length + 1, etag: part.etag });
      chunks = [];
      buffered = 0;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
      buffered += value.byteLength;
      if (buffered >= MULTIPART_PART_BYTES) await emit();
    }
    if (buffered > 0 || parts.length === 0) await emit();
    await upload.complete(parts);
    return total;
  } catch (cause) {
    await upload.abort().catch(() => undefined);
    throw cause;
  }
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const ItemFailure = Schema.Struct({
  item: Schema.String,
  error: Schema.String,
});

export class DriveReport extends Schema.Class<DriveReport>("DriveReport")({
  ranAt: Schema.String,
  mode: Schema.Literals(["cron", "manual"]),
  live: Schema.Boolean,
  /** The service-account bindings resolved (email + key). When
   * false, every source is disabled, as on the server without
   * GOOGLE_TOKEN_URL. */
  configured: Schema.Boolean,
  /** The audio folder (GDRIVE_FOLDER_ID), or null when unset. */
  folderId: Schema.NullOr(Schema.String),
  audio: Schema.Struct({
    /** Files the folder listing returned, in listing order. */
    discovered: Schema.Number,
    discoveredIds: Schema.Array(Schema.String),
    ingested: Schema.Number,
    cached: Schema.Number,
    skipped: Schema.Number,
    /** Shadow only: names of files that would be ingested. */
    wouldIngest: Schema.Array(Schema.String),
    failures: Schema.Array(ItemFailure),
  }),
  allow: Schema.Struct({
    /** Entries on the allowlist. */
    listed: Schema.Number,
    /** Entries processed (the server's discovery count: every
     * entry, visible or not). */
    discovered: Schema.Number,
    ingested: Schema.Number,
    cached: Schema.Number,
    skipped: Schema.Number,
    /** Allowlisted ids the credential cannot see. */
    missing: Schema.Array(Schema.String),
    /** Shadow only: visible, unreceipted entries and the state
     * the live flow would start from. */
    wouldIngest: Schema.Array(
      Schema.Struct({ id: Schema.String, state: Schema.String }),
    ),
    failures: Schema.Array(ItemFailure),
  }),
  /** The inventory crawl, when one ran this pass. */
  inventory: Schema.NullOr(
    Schema.Struct({
      total: Schema.Number,
      files: Schema.Number,
      folders: Schema.Number,
      totalBytes: Schema.Number,
      /** sha256 over the sorted item ids — the probe's summary,
       * comparable across credentials. */
      idsHash: Schema.String,
      /** Entries differ from the stored crawl. */
      changed: Schema.Boolean,
      /** Live only: latest.json was rewritten. */
      written: Schema.Boolean,
      /** The stored crawl's counts, for the delta (null when no
       * stored crawl exists). */
      storedFiles: Schema.NullOr(Schema.Number),
      storedFolders: Schema.NullOr(Schema.Number),
    }),
  ),
  /** The rehearsal's byte-integrity check, when one ran: a
   * receipted file downloaded through the service account and
   * hashed; `match` says the sha256 equals the receipt's capture
   * id — the same bytes the server ingested. */
  byteCheck: Schema.NullOr(
    Schema.Struct({
      fileId: Schema.String,
      name: Schema.String,
      size: Schema.Number,
      expected: Schema.String,
      actual: Schema.String,
      match: Schema.Boolean,
    }),
  ),
  errors: Schema.Array(
    Schema.Struct({ item: Schema.String, detail: Schema.String }),
  ),
}) {}

export interface DrivePassOptions {
  readonly mode: "cron" | "manual";
  readonly now: Date;
  /** True when DRIVE_MODE is live (writes and assembly fires
   * happen); false discovers and compares only. */
  readonly perform: boolean;
  /** "auto": crawl when the last crawl is ~an hour old (the
   * server's hourly loop); "force": crawl now; "skip": don't. */
  readonly inventory: "auto" | "force" | "skip";
  /** Download this discovered audio file (or "smallest" — the
   * smallest receipted one) and verify its sha256 against its
   * ingest receipt. Manual rehearsal tooling. */
  readonly byteCheck?: string;
}

// ---------------------------------------------------------------------------
// Platform: services
// ---------------------------------------------------------------------------

export class DriveApiError extends Data.TaggedError("DriveApiError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface DriveApiShape {
  /** The bindings' resolution states (never values), for the
   * report: "ok" | "missing" | "empty" | "unreadable". */
  readonly bindingStates: {
    readonly email: string;
    readonly privateKey: string;
  };
  readonly configured: boolean;
  readonly listFolder: (
    folderId: string,
    pageSize: number,
  ) => Effect.Effect<ReadonlyArray<DriveFile>, DriveApiError>;
  readonly listAll: Effect.Effect<
    ReadonlyArray<DriveFile>,
    DriveApiError
  >;
  readonly download: (
    fileId: string,
  ) => Effect.Effect<ReadableStream, DriveApiError>;
  readonly importRequest: (
    fileId: string,
  ) => Effect.Effect<
    { readonly url: string; readonly headers: ReadonlyArray<string> },
    DriveApiError
  >;
}

export class DriveApi extends Context.Service<DriveApi, DriveApiShape>()(
  "medina-cloudflare/DriveApi",
) {}

export interface DriveDataShape {
  readonly exists: (
    key: string,
  ) => Effect.Effect<boolean, ArtifactReadError>;
  /** Parsed JSON, or null when absent or unreadable (the
   * server's readJson-or-none posture). */
  readonly readJson: (
    key: string,
  ) => Effect.Effect<unknown | null, ArtifactReadError>;
  readonly readText: (
    key: string,
  ) => Effect.Effect<string | null, ArtifactReadError>;
  readonly writeText: (
    key: string,
    text: string,
  ) => Effect.Effect<void, ArtifactReadError | IndexRequestError>;
  readonly head: (
    key: string,
  ) => Effect.Effect<CatalogHead | null, CatalogError>;
  /** Stream a blob into the bucket (multipart), registering it
   * size-only like the ledger's blob writes; resolves to the
   * byte count. */
  readonly putBlobStream: (
    key: string,
    body: ReadableStream,
  ) => Effect.Effect<number, ArtifactReadError | IndexRequestError>;
}

export class DriveData extends Context.Service<DriveData, DriveDataShape>()(
  "medina-cloudflare/DriveData",
) {}

export interface DriveNotebookShape {
  readonly record: (
    report: DriveReport,
  ) => Effect.Effect<void, NotebookError>;
  readonly latest: Effect.Effect<
    Option.Option<DriveReport>,
    NotebookError
  >;
  /** The last completed inventory crawl's instant (ISO), or
   * null when none has run. */
  readonly lastInventoryAt: Effect.Effect<string | null, NotebookError>;
  readonly setLastInventoryAt: (
    iso: string,
  ) => Effect.Effect<void, NotebookError>;
}

export class DriveNotebook extends Context.Service<
  DriveNotebook,
  DriveNotebookShape
>()("medina-cloudflare/DriveNotebook") {}

export class DriveConfig extends Context.Service<
  DriveConfig,
  {
    /** medina-dev's GDRIVE_FOLDER_ID; null disables audio-drive,
     * as on the server. */
    readonly folderId: string | null;
    /** medina-dev's SOURCE_LATEST (its Config default is 25;
     * medina-dev's .env sets 10). */
    readonly sourceLatest: number;
  }
>()("medina-cloudflare/DriveConfig") {}

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface DriveStageEnv {
  readonly artifacts: DriveBucketLike;
  readonly notebook: DurableObjectNamespaceLike;
  readonly serviceAccountEmail: SecretsStoreSecretLike | null;
  readonly serviceAccountPrivateKey: SecretsStoreSecretLike | null;
  readonly folderId: string | null;
  readonly sourceLatest: number;
}

export const DRIVE_DO_NAME = "drive-shadow-v1";

type BindingResolution =
  | { readonly state: "ok"; readonly value: string }
  | { readonly state: "missing" | "empty" | "unreadable" };

const resolveBinding = async (
  binding: SecretsStoreSecretLike | null,
): Promise<BindingResolution> => {
  if (binding === null) return { state: "missing" };
  try {
    const value = await binding.get();
    return typeof value === "string" && value.length > 0
      ? { state: "ok", value }
      : { state: "empty" };
  } catch {
    return { state: "unreadable" };
  }
};

export const drivePlatformLayer = (
  env: DriveStageEnv,
): Layer.Layer<
  DriveApi | DriveData | DriveNotebook | DriveConfig,
  never,
  ArtifactLedger | ArtifactCatalog | ArtifactIndex
> =>
  Layer.mergeAll(
    Layer.effect(
      DriveApi,
      Effect.gen(function* () {
        const email = yield* Effect.promise(() =>
          resolveBinding(env.serviceAccountEmail),
        );
        const privateKey = yield* Effect.promise(() =>
          resolveBinding(env.serviceAccountPrivateKey),
        );
        const configured =
          email.state === "ok" && privateKey.state === "ok";
        const emailValue = email.state === "ok" ? email.value : null;
        const keyValue =
          privateKey.state === "ok" ? privateKey.value : null;
        let tokenPromise: Promise<string> | null = null;
        const token = (): Promise<string> => {
          if (emailValue === null || keyValue === null) {
            return Promise.reject(
              new Error("the Drive service account is not configured"),
            );
          }
          tokenPromise ??= serviceAccountAccessToken(emailValue, keyValue);
          return tokenPromise;
        };
        const call = <A>(label: string, run: (t: string) => Promise<A>) =>
          Effect.tryPromise({
            try: async () => run(await token()),
            catch: (cause) =>
              new DriveApiError({
                message: cause instanceof Error ? cause.message : label,
                cause,
              }),
          });
        return {
          bindingStates: {
            email: email.state,
            privateKey: privateKey.state,
          },
          configured,
          listFolder: (folderId, pageSize) =>
            call("files.list failed", (t) =>
              listDriveFolder(t, folderId, pageSize),
            ),
          listAll: call("files.list (all) failed", (t) => listAllDrive(t)),
          download: (fileId) =>
            call("files.get (media) failed", (t) =>
              downloadDriveFile(t, fileId),
            ),
          importRequest: (fileId) =>
            call("import request failed", async (t) =>
              driveImportRequest(t, fileId),
            ),
        };
      }),
    ),
    Layer.effect(
      DriveData,
      Effect.gen(function* () {
        const ledger = yield* ArtifactLedger;
        const catalog = yield* ArtifactCatalog;
        const index = yield* ArtifactIndex;
        return {
          exists: (key) => ledger.exists(key),
          readJson: (key) =>
            Effect.map(ledger.readJson(key), (value) =>
              Option.isSome(value) ? value.value : null,
            ),
          readText: (key) =>
            Effect.map(ledger.readText(key), (value) =>
              Option.isSome(value) ? value.value : null,
            ),
          writeText: (key, text) => ledger.writeText(key, text),
          head: (key) => catalog.head(key),
          putBlobStream: (key, body) =>
            Effect.gen(function* () {
              const size = yield* Effect.tryPromise({
                try: () =>
                  putStreamMultipart(
                    env.artifacts,
                    key,
                    body,
                    contentTypeForKey(key, "application/octet-stream"),
                  ),
                catch: (cause) =>
                  new ArtifactReadError({
                    key,
                    message: `streaming ${key} into the artifact bucket failed`,
                    cause,
                  }),
              });
              // The ledger's blob-write registration: size only —
              // the bytes arrived by stream, so no content hash
              // was computed for the registration.
              yield* index.register(key, size, null);
              return size;
            }),
        };
      }),
    ),
    Layer.succeed(DriveNotebook, {
      record: (report) =>
        Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(DRIVE_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://drive-shadow/report", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(report),
              }),
            );
            if (!response.ok) {
              throw new Error(
                `notebook rejected a report: ${response.status}`,
              );
            }
          },
          catch: (cause) =>
            new NotebookError({
              message: "recording a drive report failed",
              cause,
            }),
        }),
      latest: Effect.tryPromise({
        try: async () => {
          const stub = env.notebook.get(
            env.notebook.idFromName(DRIVE_DO_NAME),
          );
          const response = await stub.fetch(
            new Request("http://drive-shadow/status"),
          );
          if (!response.ok) {
            throw new Error(`notebook status answered ${response.status}`);
          }
          const body = (await response.json()) as {
            lastReport?: unknown;
          };
          if (body.lastReport === null || body.lastReport === undefined) {
            return Option.none<DriveReport>();
          }
          return Option.some(body.lastReport as DriveReport);
        },
        catch: (cause) =>
          new NotebookError({
            message: "reading the drive notebook failed",
            cause,
          }),
      }),
      lastInventoryAt: Effect.tryPromise({
        try: async () => {
          const stub = env.notebook.get(
            env.notebook.idFromName(DRIVE_DO_NAME),
          );
          const response = await stub.fetch(
            new Request("http://drive-shadow/meta?key=last_inventory_at"),
          );
          if (!response.ok) {
            throw new Error(`notebook meta answered ${response.status}`);
          }
          const body = (await response.json()) as { value?: unknown };
          return typeof body.value === "string" ? body.value : null;
        },
        catch: (cause) =>
          new NotebookError({
            message: "reading the drive inventory marker failed",
            cause,
          }),
      }),
      setLastInventoryAt: (iso) =>
        Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(DRIVE_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://drive-shadow/meta", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  key: "last_inventory_at",
                  value: iso,
                }),
              }),
            );
            if (!response.ok) {
              throw new Error(
                `notebook meta write answered ${response.status}`,
              );
            }
          },
          catch: (cause) =>
            new NotebookError({
              message: "writing the drive inventory marker failed",
              cause,
            }),
        }),
    }),
    Layer.succeed(DriveConfig, {
      folderId: env.folderId,
      sourceLatest: env.sourceLatest,
    }),
  );

// ---------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------

type ItemOutcome =
  | { readonly kind: "ingested" }
  | { readonly kind: "cached" }
  | { readonly kind: "skipped" }
  | { readonly kind: "would-ingest"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };

const errorDetail = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);

/** One provenance append, the server's rule (Audio.ts /
 * DriveAllow.ts finalization): the same (source, fileId,
 * filename) sighting is recorded once. Live only — callers gate
 * on perform. */
const appendProvenance = (
  data: DriveDataShape,
  sourceName: string,
  captureId: string,
  file: DriveFile,
  now: Date,
): Effect.Effect<void, ArtifactReadError | IndexRequestError> =>
  Effect.gen(function* () {
    const key = driveProvenanceKey(captureId);
    const existing = yield* data.readJson(key);
    const { next, changed } = appendProvenanceRecord(existing, captureId, {
      source: sourceName,
      filename: file.name,
      fileId: file.id,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      md5Checksum: file.md5Checksum ?? null,
      fetchedAt: now.toISOString(),
    });
    if (changed) yield* data.writeText(key, JSON.stringify(next));
  });

/** One audio-drive file (lib/capture/Audio.ts `ingestAudioFile`,
 * one for one): receipt first, then the non-audio skip, then the
 * legacy-transcript adoption, then download + hash + store. The
 * server's `promoteLiveTranscript` tail is a proven no-op for
 * Drive files — it parses the file id as a capture-app object key
 * and Drive ids never parse — so it is not reproduced. */
const audioOutcome = (
  api: DriveApiShape,
  data: DriveDataShape,
  file: DriveFile,
  perform: boolean,
  now: Date,
): Effect.Effect<ItemOutcome & { readonly captureId?: string }, never> =>
  Effect.gen(function* () {
    const version = driveFileVersion(file);
    const receiptKey = driveIngestReceiptKey(
      AUDIO_DRIVE_SOURCE,
      file.id,
      version,
    );
    const receiptRaw = yield* data.readJson(receiptKey);
    const receipt = receiptRaw === null ? null : parseReceipt(receiptRaw);
    if (receipt !== null) {
      return { kind: "cached" as const, captureId: receipt.captureId };
    }
    if (!file.mimeType.startsWith("audio/")) {
      return { kind: "skipped" as const };
    }
    const legacyId = driveIngestId(AUDIO_DRIVE_SOURCE, file.id, version);
    if (yield* data.exists(driveTranscriptKey(legacyId))) {
      if (perform) {
        yield* data.writeText(
          receiptKey,
          JSON.stringify({
            captureId: legacyId,
            ingestedAt: now.toISOString(),
          }),
        );
      }
      return { kind: "cached" as const, captureId: legacyId };
    }
    if (!perform) {
      return { kind: "would-ingest" as const, detail: "new file" };
    }
    const download = yield* api.download(file.id);
    const captureId = yield* Effect.promise(() => sha256OfStream(download));
    const blobKey = driveCaptureBlobKey(captureId, file.name);
    if (!(yield* data.exists(blobKey))) {
      const expected =
        file.size === undefined ? null : Number(file.size);
      const written = yield* data.putBlobStream(
        blobKey,
        yield* api.download(file.id),
      );
      if (expected !== null && written !== expected) {
        return yield* Effect.fail(
          new Error(
            `downloaded ${written} bytes for ${file.name}; Drive reports ${expected}`,
          ),
        );
      }
    }
    yield* appendProvenance(data, AUDIO_DRIVE_SOURCE, captureId, file, now);
    yield* data.writeText(
      receiptKey,
      JSON.stringify({ captureId, ingestedAt: now.toISOString() }),
    );
    return { kind: "ingested" as const, captureId };
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({ kind: "error" as const, detail: errorDetail(cause) }),
    ),
  );

/** The drive-allow finalization (lib/capture/TransloaditNormalize.ts
 * `ingestDrive`'s tail): provenance, then the source receipt. */
const finalizeAllowFile = (
  data: DriveDataShape,
  item: DriveFile,
  captureId: string,
  finalReceiptKey: string,
  now: Date,
): Effect.Effect<void, ArtifactReadError | IndexRequestError> =>
  Effect.gen(function* () {
    yield* appendProvenance(data, DRIVE_ALLOW_SOURCE, captureId, item, now);
    yield* data.writeText(
      finalReceiptKey,
      JSON.stringify({ captureId, ingestedAt: now.toISOString() }),
    );
  });

/** Fire the drive-import assembly (lib's `ingestDrive` first
 * branch): Transloadit pulls the file from Drive with the
 * ephemeral bearer header and stores the original at the
 * capture key under a credential scoped to that one object.
 * Returns the job receipt to persist. */
const fireDriveImport = (
  api: DriveApiShape,
  vendor: DriveVendorShape,
  normalizeData: DriveNormalizeDataShape,
  item: DriveFile,
  captureId: string,
  originalKey: string,
  now: Date,
): Effect.Effect<TransloaditReceiptShape, Error> =>
  Effect.gen(function* () {
    const s3 = normalizeData.s3Credentials;
    if (s3 === null) {
      return yield* Effect.fail(
        new Error(
          "the ARTIFACTS_S3 binding is missing or unreadable: cannot mint the import store credential",
        ),
      );
    }
    const authKey = yield* vendor.authKey;
    if (authKey === null) {
      return yield* Effect.fail(
        new Error("the TRANSLOADIT_API_KEY binding is missing or empty"),
      );
    }
    const remote = yield* api.importRequest(item.id);
    const store = yield* mintTempCredentials({
      endpoint: s3.endpoint,
      accountId: accountIdFromEndpoint(s3.endpoint),
      parent: s3,
      bucket: s3.bucketName,
      permission: "object-read-write",
      ttlSeconds: JOB_TTL_SECONDS,
      objects: [originalKey],
      now,
    });
    const created = yield* vendor.createAssembly({
      auth: { key: authKey },
      steps: {
        import: {
          robot: "/http/import",
          url: remote.url,
          headers: [...remote.headers],
          result: true,
        },
        store_original: {
          robot: "/s3/store",
          use: "import",
          bucket: s3.bucketName,
          bucket_region: "auto",
          host: s3.endpoint,
          no_vhost: true,
          key: store.accessKeyId,
          secret: store.secretAccessKey,
          session_token: store.sessionToken,
          acl: "bucket-default",
          path: originalKey,
          result: true,
        },
      },
    });
    return {
      assemblyId: created.assemblyId,
      assemblySslUrl: created.assemblySslUrl,
      createdAt: now.toISOString(),
      mediaVersion: MEDIA_VERSION,
      workflowVersion: WORKFLOW_VERSION,
      phase: "import" as const,
      captureId,
      originalKey,
      sourceDurationSeconds: null,
      previousAssemblyIds: [],
    };
  }).pipe(Effect.mapError((cause) => new Error(errorDetail(cause))));

/** One drive-allow file (lib/capture/DriveAllow.ts's source over
 * lib's `ingestDrive`, one for one): the final receipt caches;
 * otherwise the job-receipt state machine advances one step —
 * fire the import, poll it, fire the chunk assembly, settle it,
 * finalize. Shadow mode reports the state it would start from
 * and touches nothing. */
const allowOutcome = (
  api: DriveApiShape,
  data: DriveDataShape,
  vendor: DriveVendorShape,
  normalizeData: DriveNormalizeDataShape,
  item: DriveFile,
  perform: boolean,
  now: Date,
): Effect.Effect<ItemOutcome, never, NormalizeData | NormalizeVendor> =>
  Effect.gen(function* () {
    const version = driveFileVersion(item);
    const finalReceiptKey = driveIngestReceiptKey(
      DRIVE_ALLOW_SOURCE,
      item.id,
      version,
    );
    if (yield* data.exists(finalReceiptKey)) {
      return { kind: "cached" as const };
    }
    const jobKey = driveJobReceiptKey(item.id, version);
    const jobText = yield* data.readText(jobKey);
    let job: TransloaditReceiptShape | null = null;
    if (jobText !== null) {
      try {
        job = parseTransloaditReceipt(JSON.parse(jobText) as unknown);
      } catch {
        job = null;
      }
    }
    if (!perform) {
      return {
        kind: "would-ingest" as const,
        detail:
          job === null
            ? "fire-import"
            : job.phase === "completed"
              ? "finalize"
              : `poll-${job.phase ?? "unknown"}`,
      };
    }
    if (!vendor.configured || normalizeData.s3Credentials === null) {
      return yield* Effect.fail(
        new Error(
          `allowlisted Drive file ${item.id} requires configured Transloadit remote ingest; refusing to download it to this host`,
        ),
      );
    }
    const captureId = driveIngestId(DRIVE_ALLOW_SOURCE, item.id, version);
    const originalKey = driveCaptureBlobKey(captureId, item.name);

    if (job === null) {
      const fired = yield* fireDriveImport(
        api,
        vendor,
        normalizeData,
        item,
        captureId,
        originalKey,
        now,
      );
      yield* data.writeText(jobKey, receiptJson(fired));
      return { kind: "ingested" as const };
    }

    if (job.phase === "completed") {
      yield* finalizeAllowFile(data, item, captureId, finalReceiptKey, now);
      return { kind: "ingested" as const };
    }

    const assembly = yield* vendor.getAssembly(job.assemblyId);
    const state = assemblyState(assembly);
    if (typeof state === "object") {
      return yield* Effect.fail(
        new Error(
          `Transloadit assembly ${job.assemblyId} failed: ${state.error}`,
        ),
      );
    }
    if (state === "pending") return { kind: "skipped" as const };

    if (job.phase === "import") {
      const original = yield* data.head(originalKey);
      if (original === null || original.size <= 0) {
        return yield* Effect.fail(
          new Error(
            `Transloadit completed without R2 original for ${captureId}: ${originalKey}`,
          ),
        );
      }
      if (mediaMime(item.mimeType)) {
        const duration = resultDuration(assembly, [
          "import",
          "store_original",
        ]);
        if (duration === null) {
          return yield* Effect.fail(
            new Error(
              `Transloadit returned no media duration for ${item.name} (${item.id})`,
            ),
          );
        }
        const fired = yield* fireChunkReceipt({
          captureId,
          sourceKey: originalKey,
          originalKey,
          durationSeconds: duration,
          previousAssemblyIds: [job.assemblyId],
          chunkPrefix: mediaChunkPrefix(captureId),
          now,
        });
        yield* data.writeText(jobKey, receiptJson(fired));
        return { kind: "ingested" as const };
      }
      yield* data.writeText(
        jobKey,
        receiptJson({ ...job, phase: "completed", completedAt: now.toISOString() }),
      );
      yield* finalizeAllowFile(data, item, captureId, finalReceiptKey, now);
      return { kind: "ingested" as const };
    }

    if (job.phase === "chunks" && job.sourceDurationSeconds != null) {
      const duration = job.sourceDurationSeconds;
      const chunkPrefix = mediaChunkPrefix(captureId);
      const stored = yield* normalizeData.listChunks(chunkPrefix);
      let manifest;
      try {
        manifest = manifestFromChunkListing({
          captureId,
          durationSeconds: duration,
          chunkPrefix,
          stored,
          createdAt: now.toISOString(),
        });
      } catch (cause) {
        if (!(cause instanceof ChunkValidationError)) throw cause;
        const attempts = (job.previousAssemblyIds?.length ?? 0) + 1;
        if (attempts >= MAX_CHUNK_ATTEMPTS) {
          return yield* Effect.fail(
            new Error(
              `Transloadit chunks for ${captureId} failed validation after ${attempts} attempts; not re-firing: ${cause.message}`,
            ),
          );
        }
        const fired = yield* fireChunkReceipt({
          captureId,
          sourceKey: job.originalKey ?? originalKey,
          originalKey: job.originalKey ?? originalKey,
          durationSeconds: duration,
          previousAssemblyIds: [
            ...(job.previousAssemblyIds ?? []),
            job.assemblyId,
          ],
          chunkPrefix,
          now,
        });
        yield* data.writeText(jobKey, receiptJson(fired));
        return { kind: "ingested" as const };
      }
      yield* data.writeText(
        mediaManifestKey(captureId),
        manifestJson(manifest),
      );
      yield* data.writeText(
        jobKey,
        receiptJson({ ...job, phase: "completed", completedAt: now.toISOString() }),
      );
      yield* finalizeAllowFile(data, item, captureId, finalReceiptKey, now);
      return { kind: "ingested" as const };
    }

    return yield* Effect.fail(
      new Error(
        `invalid Transloadit Drive receipt for ${item.id}: phase ${job.phase ?? "missing"}`,
      ),
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({ kind: "error" as const, detail: errorDetail(cause) }),
    ),
  );

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

const INVENTORY_INTERVAL_MS = 55 * 60 * 1000;

export const runDrivePass = (
  options: DrivePassOptions,
): Effect.Effect<
  DriveReport,
  NotebookError,
  | DriveApi
  | DriveData
  | DriveNotebook
  | DriveConfig
  | NormalizeData
  | NormalizeVendor
> =>
  Effect.gen(function* () {
    const api = yield* DriveApi;
    const data = yield* DriveData;
    const notebook = yield* DriveNotebook;
    const config = yield* DriveConfig;
    const normalizeData = yield* NormalizeData;
    const vendor = yield* NormalizeVendor;
    const now = options.now;
    const errors: Array<{ item: string; detail: string }> = [];

    const audio = {
      discovered: 0,
      discoveredIds: [] as Array<string>,
      ingested: 0,
      cached: 0,
      skipped: 0,
      wouldIngest: [] as Array<string>,
      failures: [] as Array<{ item: string; error: string }>,
    };
    const allow = {
      listed: 0,
      discovered: 0,
      ingested: 0,
      cached: 0,
      skipped: 0,
      missing: [] as Array<string>,
      wouldIngest: [] as Array<{ id: string; state: string }>,
      failures: [] as Array<{ item: string; error: string }>,
    };
    let inventory: DriveReport["inventory"] = null;
    let byteCheck: DriveReport["byteCheck"] = null;
    const receiptedAudio: Array<{
      file: DriveFile;
      captureId: string;
    }> = [];

    if (!api.configured) {
      errors.push({
        item: "drive",
        detail:
          `service account bindings: email=${api.bindingStates.email}, ` +
          `privateKey=${api.bindingStates.privateKey} — sources disabled`,
      });
    } else {
      // --- audio-drive -------------------------------------------------
      let discovered: ReadonlyArray<DriveFile> = [];
      if (config.folderId === null) {
        errors.push({
          item: AUDIO_DRIVE_SOURCE,
          detail: "GDRIVE_FOLDER_ID is not set — source disabled",
        });
      } else {
        discovered = yield* api
          .listFolder(config.folderId, config.sourceLatest)
          .pipe(
            Effect.catch((cause) => {
              errors.push({
                item: AUDIO_DRIVE_SOURCE,
                detail: errorDetail(cause),
              });
              return Effect.succeed([] as ReadonlyArray<DriveFile>);
            }),
          );
      }
      audio.discovered = discovered.length;
      audio.discoveredIds = discovered.map((file) => file.id);
      for (const file of discovered) {
        const outcome = yield* audioOutcome(
          api,
          data,
          file,
          options.perform,
          now,
        );
        if (outcome.kind === "ingested") audio.ingested++;
        else if (outcome.kind === "cached") {
          audio.cached++;
          if (outcome.captureId !== undefined) {
            receiptedAudio.push({ file, captureId: outcome.captureId });
          }
        } else if (outcome.kind === "skipped") audio.skipped++;
        else if (outcome.kind === "would-ingest") {
          audio.wouldIngest.push(file.name);
        } else {
          audio.failures.push({ item: file.name, error: outcome.detail });
        }
      }

      // --- the shared listing (drive-allow discovery + inventory) -----
      const allowlistText = yield* data
        .readText(DRIVE_ALLOWLIST_KEY)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      let allowlistIds: Array<string> | null = null;
      if (allowlistText !== null) {
        try {
          const parsed = JSON.parse(allowlistText) as {
            files?: ReadonlyArray<{ id?: unknown }>;
          };
          allowlistIds = (parsed.files ?? [])
            .map((entry) => entry.id)
            .filter((id): id is string => typeof id === "string");
        } catch {
          errors.push({
            item: DRIVE_ALLOW_SOURCE,
            detail: "allow/drive.json is unreadable",
          });
        }
      } else {
        allowlistIds = [];
      }
      allow.listed = allowlistIds?.length ?? 0;

      const inventoryDue =
        options.inventory === "force"
          ? true
          : options.inventory === "skip"
            ? false
            : yield* notebook.lastInventoryAt.pipe(
                Effect.map((last) => {
                  if (last === null) return true;
                  const at = Date.parse(last);
                  return (
                    !Number.isFinite(at) ||
                    now.getTime() - at >= INVENTORY_INTERVAL_MS
                  );
                }),
                Effect.catch(() => Effect.succeed(true)),
              );

      let allItems: ReadonlyArray<DriveFile> | null = null;
      if ((allowlistIds !== null && allowlistIds.length > 0) || inventoryDue) {
        allItems = yield* api.listAll.pipe(
          Effect.catch((cause) => {
            errors.push({ item: "drive", detail: errorDetail(cause) });
            return Effect.succeed(null);
          }),
        );
      }

      // --- drive-allow --------------------------------------------------
      if (allowlistIds !== null && allItems !== null) {
        const byId = new Map(allItems.map((item) => [item.id, item]));
        allow.discovered = allowlistIds.length;
        for (const id of allowlistIds) {
          const item = byId.get(id);
          if (item === undefined) {
            allow.missing.push(id);
            allow.failures.push({
              item: id,
              error: `allowlisted file ${id} is not visible to the Drive credential`,
            });
            continue;
          }
          const outcome = yield* allowOutcome(
            api,
            data,
            vendor,
            normalizeData,
            item,
            options.perform,
            now,
          );
          if (outcome.kind === "ingested") allow.ingested++;
          else if (outcome.kind === "cached") allow.cached++;
          else if (outcome.kind === "skipped") allow.skipped++;
          else if (outcome.kind === "would-ingest") {
            allow.wouldIngest.push({ id, state: outcome.detail });
          } else {
            allow.failures.push({
              item: `${item.name} (${id})`,
              error: outcome.detail,
            });
          }
        }
      }

      // --- drive-inventory ----------------------------------------------
      if (inventoryDue && allItems !== null) {
        const crawl = yield* Effect.gen(function* () {
          const built = buildDriveInventory(allItems, now.toISOString());
          const summary = yield* Effect.promise(() =>
            summarizeDrive(allItems),
          );
          const storedText = yield* data.readText(DRIVE_INVENTORY_KEY);
          let stored: DriveInventoryShape | null = null;
          if (storedText !== null) {
            try {
              stored = JSON.parse(storedText) as DriveInventoryShape;
            } catch {
              stored = null;
            }
          }
          const changed =
            stored === null ||
            JSON.stringify(stored.entries) !==
              JSON.stringify(built.entries);
          let written = false;
          if (changed && options.perform) {
            yield* data.writeText(
              DRIVE_INVENTORY_KEY,
              driveInventoryJson(built),
            );
            written = true;
          }
          yield* notebook.setLastInventoryAt(now.toISOString());
          return {
            total: summary.total,
            files: built.fileCount,
            folders: built.folderCount,
            totalBytes: built.totalBytes,
            idsHash: summary.idsHash,
            changed,
            written,
            storedFiles: stored?.fileCount ?? null,
            storedFolders: stored?.folderCount ?? null,
          };
        }).pipe(
          Effect.catch((cause) => {
            errors.push({
              item: "drive-inventory",
              detail: errorDetail(cause),
            });
            return Effect.succeed(null);
          }),
        );
        inventory = crawl;
      }

      // --- the byte check (manual rehearsal) ----------------------------
      if (options.byteCheck !== undefined) {
        const target =
          options.byteCheck === "smallest"
            ? receiptedAudio.reduce<(typeof receiptedAudio)[number] | null>(
                (best, entry) =>
                  best === null ||
                  Number(entry.file.size ?? Infinity) <
                    Number(best.file.size ?? Infinity)
                    ? entry
                    : best,
                null,
              )
            : (receiptedAudio.find(
                (entry) => entry.file.id === options.byteCheck,
              ) ?? null);
        if (target === null) {
          errors.push({
            item: "byte-check",
            detail: `no receipted discovered file matches ${options.byteCheck}`,
          });
        } else {
          byteCheck = yield* Effect.gen(function* () {
            const stream = yield* api.download(target.file.id);
            const actual = yield* Effect.promise(() =>
              sha256OfStream(stream),
            );
            return {
              fileId: target.file.id,
              name: target.file.name,
              size: Number(target.file.size ?? 0),
              expected: target.captureId,
              actual,
              match: actual === target.captureId,
            };
          }).pipe(
            Effect.catch((cause) => {
              errors.push({
                item: "byte-check",
                detail: errorDetail(cause),
              });
              return Effect.succeed(null);
            }),
          );
        }
      }
    }

    const report = new DriveReport({
      ranAt: now.toISOString(),
      mode: options.mode,
      live: options.perform,
      configured: api.configured,
      folderId: config.folderId,
      audio,
      allow,
      inventory,
      byteCheck,
      errors,
    });
    yield* notebook.record(report);
    return report;
  });

// ---------------------------------------------------------------------------
// DriveShadow: the stage's notebook (reports + the inventory
// cadence marker), in its own SQLite storage.
// ---------------------------------------------------------------------------

interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>;
  readonly rowsWritten: number;
}

interface SqlStorageLike {
  exec(query: string, ...bindings: Array<unknown>): SqlCursorLike;
}

interface DurableObjectStateLike {
  readonly storage: { readonly sql: SqlStorageLike };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export class DriveShadow {
  private readonly sql: SqlStorageLike;

  constructor(state: DurableObjectStateLike) {
    this.sql = state.storage.sql;
    void state.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS reports (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ran_at TEXT NOT NULL,
           report TEXT NOT NULL
         )`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         )`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (request.method === "POST" && url.pathname === "/report") {
      const body = await request.text();
      let ranAt = new Date().toISOString();
      try {
        const parsed = JSON.parse(body) as { ranAt?: unknown };
        if (typeof parsed.ranAt === "string") ranAt = parsed.ranAt;
      } catch {
        // keep the default; the body is still stored verbatim
      }
      this.sql.exec(
        `INSERT INTO reports (ran_at, report) VALUES (?, ?)`,
        ranAt,
        body,
      );
      this.sql.exec(
        `DELETE FROM reports WHERE id NOT IN (
           SELECT id FROM reports ORDER BY id DESC LIMIT 100
         )`,
      );
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const rows = this.sql
        .exec(`SELECT report FROM reports ORDER BY id DESC LIMIT 1`)
        .toArray();
      const countRows = this.sql
        .exec(`SELECT COUNT(*) AS n FROM reports`)
        .toArray();
      const lastReport =
        rows.length > 0 && typeof rows[0]?.["report"] === "string"
          ? (JSON.parse(rows[0]["report"] as string) as unknown)
          : null;
      return json({
        runCount: Number(countRows[0]?.["n"] ?? 0),
        lastReport,
      });
    }
    if (request.method === "GET" && url.pathname === "/meta") {
      const key = url.searchParams.get("key") ?? "";
      const rows = this.sql
        .exec(`SELECT value FROM meta WHERE key = ?`, key)
        .toArray();
      return json({
        value:
          rows.length > 0 && typeof rows[0]?.["value"] === "string"
            ? rows[0]["value"]
            : null,
      });
    }
    if (request.method === "POST" && url.pathname === "/meta") {
      const body = (await request.json().catch(() => ({}))) as {
        key?: unknown;
        value?: unknown;
      };
      if (typeof body.key === "string" && typeof body.value === "string") {
        this.sql.exec(
          `INSERT INTO meta (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          body.key,
          body.value,
        );
      }
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }
}
