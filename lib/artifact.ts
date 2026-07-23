import { encodeOrchestrationKeySegment } from "./orchestration-keys";
import { normalizeBucketKey, type Bucket, type BucketStat } from "./bucket";

export type ArtifactRef = {
  contentType?: string;
  createdAt?: string;
  integrity?: { algorithm: "sha256"; digest: string };
  key: string;
  sizeBytes?: number;
};

export type LocalArtifactLease = {
  artifact: ArtifactRef;
  expiresAt: string;
  localPath: string;
  release(): Promise<void>;
  workerId: string;
};

export type PublishArtifactInput = {
  contentType?: string;
  key: string;
  metadata?: Record<string, string>;
  source:
    | { kind: "local-path"; path: string }
    | { kind: "stream"; stream: ReadableStream<Uint8Array> };
};

export type ArtifactResolver = {
  publish(input: PublishArtifactInput): Promise<ArtifactRef>;
  resolve(ref: ArtifactRef): Promise<LocalArtifactLease>;
};

const jsonType = "application/json; charset=utf-8";

export function artifactRefKey(key: string) {
  return `artifact-refs/${encodeOrchestrationKeySegment(normalizeBucketKey(key))}.json`;
}

export async function readArtifactRef(bucket: Bucket, key: string): Promise<ArtifactRef | null> {
  const refKey = artifactRefKey(key);
  if (!(await bucket.exists(refKey))) return null;
  return await bucket.readJson<ArtifactRef>(refKey);
}

export async function writeArtifactRef(bucket: Bucket, ref: ArtifactRef) {
  await bucket.write(artifactRefKey(ref.key), `${JSON.stringify(ref, null, 2)}\n`, { type: jsonType });
}

export async function artifactRefFromBucket(
  bucket: Bucket,
  key: string,
  options?: {
    contentType?: string | null;
    createdAt?: string;
    integrity?: ArtifactRef["integrity"];
    stat?: BucketStat;
  },
): Promise<ArtifactRef> {
  const normalizedKey = normalizeBucketKey(key);
  const stored = await readArtifactRef(bucket, normalizedKey);
  if (stored && !options?.contentType && !options?.createdAt && !options?.integrity && !options?.stat) return stored;
  const stat = options?.stat ?? await bucket.stat(normalizedKey);
  const contentType = options?.contentType ?? stored?.contentType ?? stat.type ?? undefined;
  const createdAt = options?.createdAt ?? stored?.createdAt ?? stat.lastModified.toISOString();
  const integrity = options?.integrity ?? stored?.integrity;

  return {
    ...(contentType ? { contentType } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(integrity ? { integrity } : {}),
    key: normalizedKey,
    sizeBytes: stat.size,
  };
}
