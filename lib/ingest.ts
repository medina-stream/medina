import { PutObjectCommand, S3Client as AwsS3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import { artifactRefFromBucket, type ArtifactRef, type ArtifactResolver } from "./artifact"
import type { Bucket } from "./bucket"

export const requiredIngestMetadataKeys = [
  "sdk-version",
  "original-filename",
  "created-at",
] as const;

const ingestMetadataByteBudget = 2048;
const textEncoder = new TextEncoder();

export type IngestMetadata = Record<string, string>;

function createIngestMetadataError(message: string) {
  const error = new Error(message);
  error.name = "IngestMetadataError";
  return error;
}

export function isIngestMetadataError(error: unknown): error is Error {
  return error instanceof Error && error.name === "IngestMetadataError";
}

function normalizeMetadataKey(rawKey: string) {
  const normalized = rawKey
    .trim()
    .replace(/^x-amz-meta-/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw createIngestMetadataError(`Invalid ingest metadata key: ${rawKey}`);
  }

  return normalized;
}

export function normalizeIngestMetadata(metadata: IngestMetadata = {}): IngestMetadata {
  const normalizedEntries = Object.entries(metadata).map(([key, value]) => {
    if (typeof value !== "string") {
      throw createIngestMetadataError(`Invalid ingest metadata value for ${key}`);
    }

    return [normalizeMetadataKey(key), value] as const;
  });

  const keys = normalizedEntries.map(([key]) => key);
  const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);

  if (duplicateKeys.length > 0) {
    throw createIngestMetadataError(`Duplicate ingest metadata keys: ${duplicateKeys.join(", ")}`);
  }

  return Object.fromEntries(normalizedEntries);
}

function getMetadataEntrySize(key: string, value: string) {
  return textEncoder.encode(`x-amz-meta-${key}: ${value}\r\n`).length;
}

export function prepareIngestMetadata(metadata: IngestMetadata = {}): IngestMetadata {
  return prepareStrictIngestMetadata(metadata);
}

export function prepareStrictIngestMetadata(metadata: IngestMetadata = {}): IngestMetadata {
  const normalizedMetadata = normalizeIngestMetadata(metadata);
  const missingRequiredKeys = requiredIngestMetadataKeys.filter((key) => {
    const value = normalizedMetadata[key];
    return typeof value !== "string" || value.trim().length === 0;
  });

  if (missingRequiredKeys.length > 0) {
    throw createIngestMetadataError(`Missing required ingest metadata: ${missingRequiredKeys.join(", ")}`);
  }

  const prioritizedKeys = [
    ...requiredIngestMetadataKeys,
    ...Object.keys(normalizedMetadata).filter(
      (key) => !requiredIngestMetadataKeys.includes(key as typeof requiredIngestMetadataKeys[number]),
    ),
  ];
  let usedBytes = 0;
  const preparedMetadata: IngestMetadata = {};

  for (const key of prioritizedKeys) {
    const value = normalizedMetadata[key];
    if (value === undefined) {
      continue;
    }

    const entrySize = getMetadataEntrySize(key, value);
    if (usedBytes + entrySize > ingestMetadataByteBudget) {
      if (requiredIngestMetadataKeys.includes(key as typeof requiredIngestMetadataKeys[number])) {
        throw createIngestMetadataError(`Required ingest metadata exceeds budget: ${key}`);
      }

      continue;
    }

    preparedMetadata[key] = value;
    usedBytes += entrySize;
  }

  return preparedMetadata;
}

export function getIngestMetadataHeaders(metadata: IngestMetadata = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(prepareIngestMetadata(metadata)).map(([key, value]) => [`x-amz-meta-${key}`, value]),
  );
}

export function getRawIngestMetadataFromHeaders(headers: Headers | Record<string, string>): IngestMetadata {
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  const metadataEntries: Array<[string, string]> = [];

  for (const [key, value] of entries) {
    if (key.toLowerCase().startsWith("x-amz-meta-")) {
      metadataEntries.push([key, value]);
    }
  }

  return normalizeIngestMetadata(Object.fromEntries(metadataEntries));
}

export function getIngestMetadataFromHeaders(headers: Headers | Record<string, string>): IngestMetadata {
  return prepareStrictIngestMetadata(getRawIngestMetadataFromHeaders(headers));
}

// TODO: remove this AWS presigner fallback once Bun supports metadata-aware
// presigned uploads. Current Bun limitation: github.com/oven-sh/bun/issues/17339
export type PresignIngestUploadConfig = {
    accessKeyId?: string;
    bucket: string;
    endpoint?: string;
    forcePathStyle?: string;
    region?: string;
    secretAccessKey?: string;
    sessionToken?: string;
}

function getPresignCredentials(config: PresignIngestUploadConfig) {
    if (!config.accessKeyId || !config.secretAccessKey) {
        return undefined
    }

    return {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        sessionToken: config.sessionToken,
    }
}

function shouldUsePathStyle(endpoint?: string, forcePathStyle?: string) {
    if (!endpoint) {
        return false
    }

    if (forcePathStyle === "true") {
        return true
    }

    if (forcePathStyle === "false") {
        return false
    }

    return !endpoint.includes("amazonaws.com")
}

export function createPresignIngestUpload(config: PresignIngestUploadConfig | null) {
    if (!config) {
        return async function missingBucketPresignIngestUpload() {
            throw new Error("Missing S3_BUCKET for ingest presigning.")
        }
    }

    const presignClient = new AwsS3Client({
        bucketEndpoint: false,
        credentials: getPresignCredentials(config),
        endpoint: config.endpoint,
        forcePathStyle: shouldUsePathStyle(config.endpoint, config.forcePathStyle),
        region: config.region ?? "auto",
    })

    return async function configuredPresignIngestUpload(options: {
        expiresIn: number;
        key: string;
        metadata: IngestMetadata;
        type: string;
    }) {
        const metadataHeaders = new Set(
            Object.keys(options.metadata).map((key) => `x-amz-meta-${key}`),
        )

        return await getSignedUrl(presignClient, new PutObjectCommand({
            Bucket: config.bucket,
            ContentType: options.type,
            Key: options.key,
            Metadata: options.metadata,
        }), {
            expiresIn: options.expiresIn,
            signableHeaders: new Set(["content-type"]),
            unhoistableHeaders: metadataHeaders,
        })
    }
}

export type PresignIngestUpload = ReturnType<typeof createPresignIngestUpload>

export type IngestRequestInfo = {
    ingestKey: string;
    metadata: IngestMetadata;
    requestedAt: string;
    type: string;
};

export type GetIngestDestinationOptions = {
    metadata?: IngestMetadata;
    type: string;
};

export type IngestDestination = {
    action: string;
    headers: Record<string, string>;
    key: string;
    metadata: IngestMetadata;
    method: string;
}

export function createIngestKey() {
    return `in/${crypto.randomUUID()}`
}

export function getIngestRequestKey(ingestKey: string): string {
    const normalizedKey = ingestKey.replace(/^\/+/, '')
    return `ingest-requests/${normalizedKey}.json`
}

type IngestServiceDependencies = {
    artifacts?: ArtifactResolver;
    bucket: Bucket;
    directUploadAction?: string | ((ingestId: string) => string);
    onStoredIngest?: (input: { artifact: ArtifactRef; key: string; localPath?: string; metadata: IngestMetadata; type: string }) => Promise<void> | void;
    presignIngestUpload: PresignIngestUpload;
};

export async function readIngestRequestInfo(bucket: Bucket, ingestKey: string): Promise<IngestRequestInfo | null> {
    const requestKey = getIngestRequestKey(ingestKey)
    if (!(await bucket.exists(requestKey))) {
        return null
    }

    return await bucket.readJson<IngestRequestInfo>(requestKey)
}

export function createIngestService(dependencies: IngestServiceDependencies) {
    async function readRequestInfo(ingestKey: string): Promise<IngestRequestInfo | null> {
        return await readIngestRequestInfo(dependencies.bucket, ingestKey)
    }

    async function writeIngestRequestInfo(info: IngestRequestInfo) {
        await dependencies.bucket.write(getIngestRequestKey(info.ingestKey), JSON.stringify(info, null, 2), {
            type: 'application/json; charset=utf-8',
        })
    }

    async function ensureIngestRequestInfo(info: IngestRequestInfo) {
        if (await readRequestInfo(info.ingestKey)) {
            return
        }

        await writeIngestRequestInfo(info)
    }

    async function getIngestDestination(options: GetIngestDestinationOptions): Promise<IngestDestination> {
        const key = createIngestKey()
        const metadata = prepareIngestMetadata(options.metadata)
        const headers = {
            'Content-Type': options.type,
            ...getIngestMetadataHeaders(metadata),
        }
        const requestInfo: IngestRequestInfo = {
            ingestKey: key,
            metadata,
            requestedAt: new Date().toISOString(),
            type: options.type,
        }

        await writeIngestRequestInfo(requestInfo)

        if (dependencies.directUploadAction) {
            const ingestId = key.replace(/^in\//, "")
            return {
                action: typeof dependencies.directUploadAction === "function"
                    ? dependencies.directUploadAction(ingestId)
                    : dependencies.directUploadAction,
                headers: {
                    ...headers,
                    "x-medina-ingest-key": key,
                },
                key,
                metadata,
                method: "PUT",
            }
        }

        const expiresIn = 60 * 60

        return {
            action: await dependencies.presignIngestUpload({
                expiresIn,
                key,
                metadata,
                type: options.type,
            }),
            headers,
            key,
            metadata,
            method: 'PUT',
        }
    }

    async function storeIncomingIngest(request: Request) {
        const metadata = getRawIngestMetadataFromHeaders(request.headers)
        const type = request.headers.get("content-type") ?? "application/octet-stream"
        const key = request.headers.get("x-medina-ingest-key")?.replace(/^\/+/, "") || createIngestKey()
        const headers = Object.fromEntries(request.headers.entries())
        const requestInfo: IngestRequestInfo = {
            ingestKey: key,
            metadata,
            requestedAt: new Date().toISOString(),
            type,
        }

        await ensureIngestRequestInfo(requestInfo)
        let artifact: ArtifactRef
        let localPath: string | undefined
        let release: (() => Promise<void>) | undefined
        if (dependencies.artifacts) {
            const stream = request.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
            artifact = await dependencies.artifacts.publish({
                contentType: type,
                key,
                metadata,
                source: { kind: "stream", stream: stream as ReadableStream<Uint8Array> },
            })
            const lease = await dependencies.artifacts.resolve(artifact)
            artifact = lease.artifact
            localPath = lease.localPath
            release = lease.release
        } else {
            const body = await request.arrayBuffer()
            await dependencies.bucket.write(key, body, { headers, metadata, type })
            artifact = await artifactRefFromBucket(dependencies.bucket, key, { contentType: type })
        }
        try {
            await dependencies.onStoredIngest?.({ artifact, key, localPath, metadata, type })
        } finally {
            await release?.()
        }

        return {
            key,
            metadata,
        }
    }

    return {
        getIngestDestination,
        readIngestRequestInfo: readRequestInfo,
        storeIncomingIngest,
    }
}
