import { copyFile, link, mkdir, open, readdir, rename, rmdir, stat, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Bucket } from "./bucket";
import {
  artifactRefFromBucket,
  readArtifactRef,
  writeArtifactRef,
  type ArtifactRef,
  type ArtifactResolver,
  type LocalArtifactLease,
  type PublishArtifactInput,
} from "./artifact";

const defaultCacheMaxBytes = 5 * 1024 * 1024 * 1024;
const leaseMs = 60 * 60 * 1000;

async function exists(path: string) {
  return await stat(path).then(() => true).catch(() => false);
}

async function hashFile(path: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  let sizeBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      hasher.update(bytes);
      sizeBytes += bytes.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { digest: hasher.digest("hex"), sizeBytes };
}

async function spoolStream(stream: ReadableStream<Uint8Array>, path: string) {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "wx");
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = stream.getReader();
  let sizeBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      hasher.update(bytes);
      sizeBytes += bytes.byteLength;
      await file.write(bytes);
    }
  } finally {
    reader.releaseLock();
    await file.close();
  }
  return { digest: hasher.digest("hex"), sizeBytes };
}

export function createArtifactResolver(options: {
  bucket: Bucket;
  cacheDir?: string;
  cacheMaxBytes?: number;
  workerId: string;
}): ArtifactResolver {
  const root = options.cacheDir
    ?? join(process.env.MEDINA_CACHE_DIR?.trim() || "/tmp/medina-cache", "artifacts", "sha256");
  const cacheMaxBytes = options.cacheMaxBytes
    ?? Math.max(0, Number(process.env.MEDINA_CACHE_MAX_BYTES ?? defaultCacheMaxBytes));
  const instanceId = crypto.randomUUID();
  const temporaryRoot = join(root, ".tmp", instanceId);
  const leaseRoot = join(root, ".leases");

  async function initialize() {
    await Promise.all([
      mkdir(temporaryRoot, { recursive: true }),
      mkdir(leaseRoot, { recursive: true }),
    ]);
  }
  const initialized = initialize();

  function casPath(digest: string) {
    return join(root, digest);
  }

  async function insertCas(sourcePath: string, digest: string) {
    await initialized;
    const destination = casPath(digest);
    if (await exists(destination)) return destination;
    try {
      await link(sourcePath, destination);
    } catch {
      await copyFile(sourcePath, destination).catch(async (error) => {
        if (!(await exists(destination))) throw error;
      });
    }
    return destination;
  }

  async function hasActiveLease(digest: string) {
    const directory = join(leaseRoot, digest);
    let active = false;
    for (const entry of await readdir(directory).catch(() => [])) {
      const path = join(directory, entry);
      const record = await Bun.file(path).json().catch(() => null) as { expiresAt?: string } | null;
      if (record?.expiresAt && new Date(record.expiresAt).getTime() > Date.now()) active = true;
      else await unlink(path).catch(() => {});
    }
    if (!active) await rmdir(directory).catch(() => {});
    return active;
  }

  async function prune() {
    if (!Number.isFinite(cacheMaxBytes) || cacheMaxBytes <= 0) return;
    await initialized;
    const entries = await Promise.all((await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map(async (entry) => ({ name: entry.name, stats: await stat(join(root, entry.name)) })));
    let total = entries.reduce((sum, entry) => sum + entry.stats.size, 0);
    for (const entry of entries.sort((left, right) => left.stats.mtimeMs - right.stats.mtimeMs)) {
      if (total <= cacheMaxBytes) break;
      if (await hasActiveLease(entry.name)) continue;
      await unlink(join(root, entry.name)).catch(() => {});
      total -= entry.stats.size;
    }
  }

  async function lease(artifact: ArtifactRef, localPath: string): Promise<LocalArtifactLease> {
    const digest = artifact.integrity?.digest ?? localPath.split("/").at(-1)!;
    const digestLeaseRoot = join(leaseRoot, digest);
    const leasePath = join(digestLeaseRoot, `${process.pid}-${crypto.randomUUID()}`);
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    await mkdir(digestLeaseRoot, { recursive: true });
    await Bun.write(leasePath, JSON.stringify({ expiresAt, workerId: options.workerId }));
    await utimes(localPath, new Date(), new Date()).catch(() => {});
    return {
      artifact,
      expiresAt,
      localPath,
      async release() {
        await unlink(leasePath).catch(() => {});
        await rmdir(digestLeaseRoot).catch(() => {});
      },
      workerId: options.workerId,
    };
  }

  async function publish(input: PublishArtifactInput) {
    await initialized;
    const temporaryPath = join(temporaryRoot, crypto.randomUUID());
    let sourcePath: string;
    let digest: string;
    let sizeBytes: number;
    let removeTemporary = false;

    if (input.source.kind === "stream") {
      ({ digest, sizeBytes } = await spoolStream(input.source.stream, temporaryPath));
      sourcePath = temporaryPath;
      removeTemporary = true;
    } else {
      sourcePath = input.source.path;
      ({ digest, sizeBytes } = await hashFile(sourcePath));
    }

    try {
      await options.bucket.write(input.key, Bun.file(sourcePath), {
        metadata: input.metadata,
        type: input.contentType,
      });
      const localPath = await insertCas(sourcePath, digest);
      const ref: ArtifactRef = {
        ...(input.contentType ? { contentType: input.contentType } : {}),
        createdAt: new Date().toISOString(),
        integrity: { algorithm: "sha256", digest },
        key: input.key,
        sizeBytes,
      };
      const protection = await lease(ref, localPath);
      try {
        await writeArtifactRef(options.bucket, ref);
      } finally {
        await protection.release();
      }
      await prune();
      return ref;
    } finally {
      if (removeTemporary) await unlink(temporaryPath).catch(() => {});
    }
  }

  async function resolve(inputRef: ArtifactRef) {
    await initialized;
    let ref = inputRef.integrity ? inputRef : await readArtifactRef(options.bucket, inputRef.key) ?? inputRef;
    if (ref.integrity?.algorithm === "sha256") {
      const localPath = casPath(ref.integrity.digest);
      if (await exists(localPath)) {
        const acquired = await lease(ref, localPath);
        if (await exists(localPath)) {
          await prune();
          return acquired;
        }
        await acquired.release();
      }
    }

    const temporaryPath = join(temporaryRoot, crypto.randomUUID());
    if (options.bucket.downloadToFile) await options.bucket.downloadToFile(ref.key, temporaryPath);
    else await Bun.write(temporaryPath, await options.bucket.readArrayBuffer(ref.key));
    const { digest, sizeBytes } = await hashFile(temporaryPath);
    if (ref.integrity && ref.integrity.digest !== digest) {
      await unlink(temporaryPath).catch(() => {});
      throw new Error(`Artifact integrity mismatch for ${ref.key}`);
    }
    const localPath = casPath(digest);
    if (!(await exists(localPath))) {
      await rename(temporaryPath, localPath).catch(async (error) => {
        if (!(await exists(localPath))) throw error;
      });
    }
    await unlink(temporaryPath).catch(() => {});
    ref = await artifactRefFromBucket(options.bucket, ref.key, {
      contentType: ref.contentType,
      createdAt: ref.createdAt,
      integrity: { algorithm: "sha256", digest },
    });
    ref = { ...ref, sizeBytes };
    await writeArtifactRef(options.bucket, ref);
    const acquired = await lease(ref, localPath);
    await prune();
    return acquired;
  }

  return { publish, resolve };
}
