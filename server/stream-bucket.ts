import { createS3Bucket, type S3BucketConfig } from "#lib/bucket-bun";
import type { Bucket } from "#lib/bucket";
import { bucketConnectionId } from "#lib/bucket";
import type { BucketCredentials, Stream } from "#lib/stream";

function toS3BucketConfig(credentials: BucketCredentials): S3BucketConfig {
  return {
    accessKeyId: credentials.accessKeyId,
    bucket: credentials.bucketName,
    endpoint: credentials.endpoint,
    region: credentials.region,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    forcePathStyle: credentials.forcePathStyle,
  };
}

export function toBucketId(credentials: BucketCredentials): string | null {
  return bucketConnectionId(credentials);
}

const bucketCache = new Map<string, Bucket>();

function cacheKeyFor(credentials: BucketCredentials): string {
  return JSON.stringify({
    accessKeyId: credentials.accessKeyId ?? "",
    forcePathStyle: credentials.forcePathStyle ?? false,
    bucketName: credentials.bucketName,
    endpoint: credentials.endpoint ?? "",
    region: credentials.region ?? "auto",
  });
}

export function bucketForCredentials(credentials: BucketCredentials): Bucket {
  const key = cacheKeyFor(credentials);
  const cached = bucketCache.get(key);
  if (cached) return cached;
  const created = createS3Bucket(toS3BucketConfig(credentials));
  bucketCache.set(key, created);
  return created;
}

export function getBucketForStream(stream: Stream): Bucket {
  const credentials = stream.buckets.default ?? Object.values(stream.buckets)[0];
  if (!credentials) {
    throw new Error(`Stream ${stream.host} has no bucket configured.`);
  }
  return bucketForCredentials(credentials);
}
