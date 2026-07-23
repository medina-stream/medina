export type BucketConnection = {
  accessKeyId?: string;
  bucketName: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  region?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export type BucketConfigIdentity = {
  bucket?: string;
  endpoint?: string;
  region?: string;
};

export function bucketConnectionId(connection: BucketConnection) {
  const region = connection.region ?? "auto";
  if (!connection.endpoint) return `s3://${connection.bucketName}/${region}`;

  try {
    const url = new URL(connection.endpoint);
    const endpointId = `${url.host}${url.pathname}`.replace(/\/+$/, "");
    return `s3://${connection.bucketName}@${endpointId}/${region}`;
  } catch {
    return `s3://${connection.bucketName}@${connection.endpoint.replace(/\/+$/, "")}/${region}`;
  }
}

function defaultEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

export function getBucketName(env: Record<string, string | undefined> = defaultEnv()) {
  return env.S3_BUCKET;
}

export function getRequiredBucketName(env: Record<string, string | undefined> = defaultEnv()) {
  const bucket = getBucketName(env);
  if (!bucket) {
    throw new Error("Missing S3_BUCKET. Set S3_BUCKET for S3/R2 storage.");
  }

  return bucket;
}

export function getBucketEndpoint(env: Record<string, string | undefined> = defaultEnv()) {
  return env.S3_ENDPOINT;
}

export function getBucketRegion(env: Record<string, string | undefined> = defaultEnv()) {
  return env.S3_REGION ?? "auto";
}

export function getBucketAccessKeyId(env: Record<string, string | undefined> = defaultEnv()) {
  return env.S3_ACCESS_KEY_ID;
}

export function getBucketSecretAccessKey(env: Record<string, string | undefined> = defaultEnv()) {
  return env.S3_SECRET_ACCESS_KEY;
}

export function getBucketSessionToken(env: Record<string, string | undefined> = defaultEnv()) {
  return env.S3_SESSION_TOKEN;
}

export function getBucketForcePathStyle(env: Record<string, string | undefined> = defaultEnv()) {
  return env.S3_FORCE_PATH_STYLE;
}

export function getBucketConfigIdentity(env: Record<string, string | undefined> = defaultEnv()): BucketConfigIdentity {
  return {
    bucket: getBucketName(env),
    endpoint: getBucketEndpoint(env),
    region: getBucketRegion(env),
  };
}

export type BucketMetadata = Record<string, string>;
export type BucketWriteOptions = {
  headers?: Record<string, string>;
  metadata?: BucketMetadata;
  type?: string;
};
export type BucketWriteData = ArrayBuffer | ArrayBufferView | Blob | ReadableStream<unknown> | string;

export type BucketStat = {
  contentHash?: string | null;
  headers?: Record<string, string>;
  lastModified: Date;
  metadata?: BucketMetadata;
  size: number;
  type?: string;
};

export function parseBucketStat(raw: unknown, key: string): BucketStat {
  if (!raw || typeof raw !== "object") {
    throw new Error(`bucket.stat(${key}): expected an object, got ${typeof raw}`);
  }
  const r = raw as Record<string, unknown>;
  const lastModified = r.lastModified instanceof Date
    ? r.lastModified
    : typeof r.lastModified === "string" || typeof r.lastModified === "number"
      ? new Date(r.lastModified)
      : null;
  if (!lastModified || Number.isNaN(lastModified.getTime())) {
    throw new Error(`bucket.stat(${key}): lastModified is missing or invalid (got ${JSON.stringify(r.lastModified)})`);
  }
  if (typeof r.size !== "number") {
    throw new Error(`bucket.stat(${key}): size is missing or not a number (got ${JSON.stringify(r.size)})`);
  }
  return {
    contentHash: typeof r.contentHash === "string" ? r.contentHash : null,
    headers: r.headers as Record<string, string> | undefined,
    lastModified,
    metadata: r.metadata as BucketMetadata | undefined,
    size: r.size,
    type: typeof r.type === "string" ? r.type : undefined,
  };
}

export type BucketListOptions = {
  maxKeys?: number;
  prefix?: string;
  startAfter?: string;
};

export type BucketListResponse = {
  contents?: {
    key: string;
    lastModified?: string;
    size?: number;
  }[];
  isTruncated?: boolean;
};

export type Bucket = {
  delete(key: string): Promise<unknown>;
  downloadToFile?(key: string, destination: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(options?: BucketListOptions): Promise<BucketListResponse>;
  readArrayBuffer(key: string): Promise<ArrayBuffer>;
  readJson<T>(key: string): Promise<T>;
  readPrefix?(key: string, maxBytes: number): Promise<ArrayBuffer>;
  readText(key: string): Promise<string>;
  stat(key: string): Promise<BucketStat>;
  write(key: string, data: BucketWriteData, options?: BucketWriteOptions): Promise<unknown>;
};

export function normalizeBucketKey(key: string) {
  const normalized = key.replace(/^\/+/, "");

  if (!normalized || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`Invalid bucket key: ${key}`);
  }

  return normalized;
}

export async function readBucketPrefix(bucket: Bucket, key: string, maxBytes: number) {
  const normalizedKey = normalizeBucketKey(key);
  if (bucket.readPrefix) return await bucket.readPrefix(normalizedKey, maxBytes);
  const stat = await bucket.stat(normalizedKey);
  if (stat.size > maxBytes) return undefined;
  return await bucket.readArrayBuffer(normalizedKey);
}

export async function listObjects(bucketInstance: Bucket) {
  return await bucketInstance.list();
}

export async function listAllBucketContents(
  bucketInstance: Bucket,
  options?: BucketListOptions,
): Promise<Array<{ key: string; lastModified?: string; size?: number }>> {
  const contents: Array<{ key: string; lastModified?: string; size?: number }> = [];
  const prefix = options?.prefix ? normalizeBucketKey(options.prefix) : undefined;
  let startAfter = options?.startAfter ? normalizeBucketKey(options.startAfter) : undefined;

  while (true) {
    const page = await bucketInstance.list({ prefix, startAfter });
    const pageContents = page.contents ?? [];
    contents.push(...pageContents);

    if (!page.isTruncated || pageContents.length === 0) {
      break;
    }

    startAfter = pageContents.at(-1)?.key;
    if (!startAfter) {
      break;
    }
  }

  return contents;
}

export async function listAllBucketKeys(
  bucketInstance: Bucket,
  options?: BucketListOptions,
): Promise<string[]> {
  return (await listAllBucketContents(bucketInstance, options)).map((item) => item.key);
}

function formatBytes(size?: number) {
  if (size === undefined) return "?";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isJsonContent(key: string, type: string | undefined) {
  return type?.includes("json") || key.endsWith(".json");
}

function isTextContent(key: string, type: string | undefined) {
  return (
    type?.startsWith("text/") ||
    type?.includes("json") ||
    key.endsWith(".md") ||
    key.endsWith(".txt") ||
    key.endsWith(".log") ||
    key.endsWith(".csv") ||
    key.endsWith(".jsonl")
  );
}

function formatObjectSummary(options: {
  key: string;
  lastModified?: Date;
  size?: number;
  type?: string;
}) {
  return [
    `key: ${options.key}`,
    `content-type: ${options.type || "application/octet-stream"}`,
    `content-length: ${options.size ?? "unknown"}`,
    `last-modified: ${options.lastModified?.toISOString() ?? "unknown"}`,
  ].join("\n");
}

export async function describeBucketKey(bucketInstance: Bucket, key: string): Promise<string> {
  const normalizedKey = normalizeBucketKey(key);
  if (!(await bucketInstance.exists(normalizedKey))) {
    throw new Error(`Bucket key not found: ${normalizedKey}`);
  }

  const stats = await bucketInstance.stat(normalizedKey);
  const type = stats.type || undefined;

  if (isJsonContent(normalizedKey, type)) {
    const value = await bucketInstance.readJson(normalizedKey);
    return JSON.stringify(value, null, 2);
  }

  if (isTextContent(normalizedKey, type)) {
    const text = await bucketInstance.readText(normalizedKey);
    return `${formatObjectSummary({
      key: normalizedKey,
      lastModified: stats.lastModified,
      size: stats.size,
      type,
    })}\n\n${text}`;
  }

  return formatObjectSummary({
    key: normalizedKey,
    lastModified: stats.lastModified,
    size: stats.size,
    type,
  });
}

export async function describeBucketList(bucketInstance: Bucket): Promise<string> {
  const objects = await listObjects(bucketInstance);
  const contents = objects.contents ?? [];

  if (contents.length === 0) {
    return "Bucket is empty.";
  }

  return contents
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((item) => {
      const modified = item.lastModified ? new Date(item.lastModified).toISOString() : "unknown";
      return `${item.key}  ${formatBytes(item.size)}  ${modified}`;
    })
    .join("\n");
}
