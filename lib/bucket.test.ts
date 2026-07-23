import type { Bucket, BucketListOptions, BucketStat, BucketWriteData, BucketWriteOptions } from "./bucket";
import { normalizeBucketKey, parseBucketStat } from "./bucket";

type StoredObject = {
  body: Uint8Array;
  headers?: Record<string, string>;
  lastModified: Date;
  metadata?: Record<string, string>;
  type?: string;
};

async function toBytes(data: BucketWriteData): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (data instanceof ReadableStream) {
    const reader = data.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
        chunks.push(bytes);
        size += bytes.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
  throw new Error("Unsupported bucket write data.");
}

async function hashBytes(data: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createMemoryBucket(): Bucket {
  const objects = new Map<string, StoredObject>();

  return {
    async delete(key) {
      objects.delete(normalizeBucketKey(key));
    },
    async exists(key) {
      return objects.has(normalizeBucketKey(key));
    },
    async list(options?: BucketListOptions) {
      const prefix = options?.prefix ? normalizeBucketKey(options.prefix) : undefined;
      const startAfter = options?.startAfter ? normalizeBucketKey(options.startAfter) : undefined;
      const contents = [...objects.entries()]
        .filter(([key]) => !prefix || key.startsWith(prefix))
        .filter(([key]) => !startAfter || key > startAfter)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, object]) => ({ key, lastModified: object.lastModified.toISOString(), size: object.body.byteLength }));
      const maxKeys = options?.maxKeys ?? contents.length;
      return {
        contents: contents.slice(0, maxKeys),
        isTruncated: contents.length > maxKeys,
      };
    },
    async readArrayBuffer(key) {
      const object = objects.get(normalizeBucketKey(key));
      if (!object) throw new Error(`Bucket key not found: ${key}`);
      return object.body.buffer.slice(object.body.byteOffset, object.body.byteOffset + object.body.byteLength) as ArrayBuffer;
    },
    async readJson<T>(key) {
      return JSON.parse(await this.readText(key)) as T;
    },
    async readPrefix(key, maxBytes) {
      const buffer = await this.readArrayBuffer(key);
      return buffer.slice(0, Math.max(0, maxBytes));
    },
    async readText(key) {
      return new TextDecoder().decode(await this.readArrayBuffer(key));
    },
    async stat(key): Promise<BucketStat> {
      const normalized = normalizeBucketKey(key);
      const object = objects.get(normalized);
      if (!object) throw new Error(`Bucket key not found: ${normalized}`);
      return parseBucketStat({
        contentHash: await hashBytes(object.body),
        headers: object.headers,
        lastModified: object.lastModified,
        metadata: object.metadata,
        size: object.body.byteLength,
        type: object.type ?? object.headers?.["content-type"],
      }, normalized);
    },
    async write(key, data, options?: BucketWriteOptions) {
      objects.set(normalizeBucketKey(key), {
        body: await toBytes(data),
        headers: options?.headers,
        lastModified: new Date(),
        metadata: options?.metadata,
        type: options?.type,
      });
    },
  };
}
