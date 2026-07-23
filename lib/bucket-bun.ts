import { open } from "node:fs/promises";

import {
  getBucketAccessKeyId,
  getBucketEndpoint,
  getBucketRegion,
  getBucketSecretAccessKey,
  getBucketSessionToken,
  getRequiredBucketName,
} from "./bucket";
import type { BucketConnection, Bucket } from "./bucket";
import { parseBucketStat } from "./bucket";

export type S3BucketConfig = Omit<BucketConnection, "bucketName"> & {
  bucket: string;
};

function definedS3Options(config: S3BucketConfig): Bun.S3Options {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) as Bun.S3Options;
}

export function createS3Bucket(config?: S3BucketConfig): Bucket {
  const resolvedConfig = config ?? {
    accessKeyId: getBucketAccessKeyId(),
    bucket: getRequiredBucketName(),
    endpoint: getBucketEndpoint(),
    region: getBucketRegion(),
    secretAccessKey: getBucketSecretAccessKey(),
    sessionToken: getBucketSessionToken(),
  };
  const { forcePathStyle: _forcePathStyle, ...s3Options } = resolvedConfig;
  const client = new Bun.S3Client(definedS3Options(s3Options));

  return {
    async delete(key) { return await client.delete(key); },
    async downloadToFile(key, destination) {
      const reader = client.file(key).stream().getReader();
      const output = await open(destination, "w");
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await output.write(value);
        }
      } finally {
        reader.releaseLock();
        await output.close();
      }
    },
    async exists(key) { return await client.file(key).exists(); },
    async list(options) { return await client.list(options); },
    async readArrayBuffer(key) { return await client.file(key).arrayBuffer(); },
    async readJson<T>(key) { return await client.file(key).json() as T; },
    async readPrefix(key, maxBytes) {
      const reader = client.file(key).stream().getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (total < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
          const remaining = maxBytes - total;
          chunks.push(bytes.byteLength > remaining ? bytes.slice(0, remaining) : bytes);
          total += Math.min(bytes.byteLength, remaining);
        }
        if (total >= maxBytes) await reader.cancel();
      } finally {
        reader.releaseLock();
      }
      const output = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return output.buffer;
    },
    async readText(key) { return await client.file(key).text(); },
    async stat(key) {
      const s = await client.file(key).stat();
      const etag = typeof (s as { etag?: unknown }).etag === "string"
        ? (s as { etag: string }).etag.replaceAll('"', "")
        : null;
      return parseBucketStat({
        contentHash: etag,
        lastModified: s.lastModified,
        size: s.size,
        type: s.type,
      }, key);
    },
    async write(key, data, options) {
      return await client.write(key, data as Parameters<typeof client.write>[1], options ? { type: options.type } : undefined);
    },
  };
}

export function createBucketFromEnv(): Bucket {
  return createS3Bucket();
}
