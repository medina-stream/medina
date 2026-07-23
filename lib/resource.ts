import { basename } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { normalizeBucketKey, type Bucket } from "./bucket";
import type { ArtifactResolver } from "./artifact";

export type ResourceReference = {
  id: string;
  kind: string;
  key: string;
  url?: string;
};

export type ResourceRefInput = {
  id: string;
  key?: string;
  url?: string;
};

export type ResourceProvenance = {
  inputs: ResourceReference[];
  transform: {
    name: string;
    version: string;
  };
};

export type ResourceEnvelope<T> = {
  provenance?: ResourceProvenance;
  ref: ResourceReference;
  value: T;
};

export type ResourceDependency = {
  key: string;
  type: "bucket-object";
};

export type ResourceDependencyFingerprint = ResourceDependency & {
  contentType: string | null;
  contentHash: string | null;
  exists: boolean;
  lastModified: string | null;
  size: number | null;
};

export type ResourceWarning = {
  code: string;
  message: string;
};

export type MaterializationReceipt = {
  dependencySetHash: string;
  definition: {
    name: string;
    version: string;
  };
  dependencies: ResourceDependencyFingerprint[];
  materializedAt: string;
  resourceKey: string;
  warnings?: ResourceWarning[];
};

export type MaterializationFreshness =
  | { fresh: true }
  | { fresh: false; reason: "forced" | "missing-output" | "missing-receipt" | "definition-changed" | "dependencies-changed" | "degraded" };

export type ResourceContext = {
  artifacts?: ArtifactResolver;
  bucket: Bucket;
  force: boolean;
  inputKey: string;
  now: Date;
  progress?: (data: Record<string, unknown>) => Promise<void> | void;
};

export type ResourcePlan<State> = {
  dependencies: ResourceDependency[];
  outputs: string[];
  state: State;
};

export type ResourceDefinition<State> = {
  materialize(context: ResourceContext & {
    dependencies: ResourceDependencyFingerprint[];
    plan: ResourcePlan<State>;
    warn(warning: ResourceWarning): void;
  }): Promise<string[] | void>;
  name: string;
  plan(context: ResourceContext): Promise<ResourcePlan<State>>;
  version: string;
};

export type ResourceRunResult<State> = {
  definition: Pick<ResourceDefinition<State>, "name" | "version">;
  dependencies: ResourceDependencyFingerprint[];
  freshness: MaterializationFreshness[];
  materialized: boolean;
  outputs: string[];
  plan: ResourcePlan<State>;
  warnings: ResourceWarning[];
  wouldMaterialize: boolean;
};

export function defineResource<State>(definition: ResourceDefinition<State>) {
  return definition;
}

type ResourceWarningListener = (event: {
  definition: { name: string; version: string };
  inputKey: string;
  warning: ResourceWarning;
}) => void;

const warningListeners = new Set<ResourceWarningListener>();

export function onResourceWarning(listener: ResourceWarningListener): () => void {
  warningListeners.add(listener);
  return () => { warningListeners.delete(listener); };
}

export function bucketObject(key: string): ResourceDependency {
  return {
    key: normalizeBucketKey(key),
    type: "bucket-object",
  };
}

export function getMaterializationReceiptKey(resourceKey: string) {
  return `resource-receipts/${normalizeBucketKey(resourceKey)}.receipt.json`;
}

async function hashArrayBuffer(data: ArrayBuffer) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function getDependencyFingerprintHash(fingerprint: ResourceDependencyFingerprint) {
  return JSON.stringify({
    contentHash: fingerprint.contentHash,
    contentType: fingerprint.contentType,
    exists: fingerprint.exists,
    key: fingerprint.key,
    lastModified: fingerprint.lastModified,
    size: fingerprint.size,
    type: fingerprint.type,
  });
}

export async function getDependencySetHash(fingerprints: ResourceDependencyFingerprint[]) {
  const sorted = fingerprints
    .slice()
    .sort((left, right) => left.key.localeCompare(right.key) || left.type.localeCompare(right.type))
    .map((fingerprint) => getDependencyFingerprintHash(fingerprint))
    .join("\n");

  return await hashArrayBuffer(new TextEncoder().encode(sorted).buffer);
}

export async function fingerprintDependency(
  bucketInstance: Bucket,
  dependency: ResourceDependency,
): Promise<ResourceDependencyFingerprint> {
  switch (dependency.type) {
    case "bucket-object": {
      const key = normalizeBucketKey(dependency.key);
      if (!(await bucketInstance.exists(key))) {
        return {
          contentType: null,
          contentHash: null,
          exists: false,
          key,
          lastModified: null,
          size: null,
          type: "bucket-object",
        };
      }

      const stats = await bucketInstance.stat(key);
      return {
        contentType: stats.type ?? stats.headers?.["content-type"] ?? null,
        contentHash: stats.contentHash ?? await hashArrayBuffer(await bucketInstance.readArrayBuffer(key)),
        exists: true,
        key,
        lastModified: stats.lastModified.toISOString(),
        size: stats.size,
        type: "bucket-object",
      };
    }
  }
}

export async function fingerprintDependencies(
  bucketInstance: Bucket,
  dependencies: ResourceDependency[],
): Promise<ResourceDependencyFingerprint[]> {
  return await Promise.all(dependencies.map((dependency) => fingerprintDependency(bucketInstance, dependency)));
}

function sameDependencyFingerprints(
  left: ResourceDependencyFingerprint[],
  right: ResourceDependencyFingerprint[],
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const DEGRADED_RETRY_MS = 15 * 60 * 1000;

export function getMaterializationFreshness(options: {
  currentDependencies: ResourceDependencyFingerprint[];
  currentDependencySetHash?: string;
  definition: Pick<ResourceDefinition<unknown>, "name" | "version">;
  force?: boolean;
  now?: Date;
  outputExists: boolean;
  receipt: MaterializationReceipt | null;
}): MaterializationFreshness {
  if (options.force) {
    return { fresh: false, reason: "forced" };
  }

  if (!options.outputExists) {
    return { fresh: false, reason: "missing-output" };
  }

  if (!options.receipt) {
    return { fresh: false, reason: "missing-receipt" };
  }

  if (
    options.receipt.definition.name !== options.definition.name ||
    options.receipt.definition.version !== options.definition.version
  ) {
    return { fresh: false, reason: "definition-changed" };
  }

  if (options.receipt.warnings?.length) {
    const materializedAt = new Date(options.receipt.materializedAt).getTime();
    const now = (options.now ?? new Date()).getTime();
    if (!Number.isFinite(materializedAt) || now - materializedAt >= DEGRADED_RETRY_MS) {
      return { fresh: false, reason: "degraded" };
    }
  }

  if (options.receipt.dependencySetHash && options.currentDependencySetHash) {
    if (options.receipt.dependencySetHash !== options.currentDependencySetHash) {
      return { fresh: false, reason: "dependencies-changed" };
    }

    return { fresh: true };
  }

  if (!sameDependencyFingerprints(options.receipt.dependencies, options.currentDependencies)) {
    return { fresh: false, reason: "dependencies-changed" };
  }

  return { fresh: true };
}

export async function readMaterializationReceipt(
  bucketInstance: Bucket,
  resourceKey: string,
): Promise<MaterializationReceipt | null> {
  const receiptKey = getMaterializationReceiptKey(resourceKey);
  if (!(await bucketInstance.exists(receiptKey))) {
    return null;
  }

  return await bucketInstance.readJson<MaterializationReceipt>(receiptKey);
}

export async function writeMaterializationReceipt(
  bucketInstance: Bucket,
  receipt: MaterializationReceipt,
) {
  await bucketInstance.write(getMaterializationReceiptKey(receipt.resourceKey), `${JSON.stringify(receipt, null, 2)}\n`, {
    type: "application/json; charset=utf-8",
  });
}

export function createMaterializationReceipt(options: {
  dependencies: ResourceDependencyFingerprint[];
  definition: Pick<ResourceDefinition<unknown>, "name" | "version">;
  dependencySetHash?: string;
  materializedAt?: Date;
  resourceKey: string;
  warnings?: ResourceWarning[];
}): MaterializationReceipt {
  return {
    dependencySetHash: options.dependencySetHash ?? "",
    definition: {
      name: options.definition.name,
      version: options.definition.version,
    },
    dependencies: options.dependencies,
    materializedAt: (options.materializedAt ?? new Date()).toISOString(),
    resourceKey: normalizeBucketKey(options.resourceKey),
    ...(options.warnings?.length ? { warnings: options.warnings } : {}),
  };
}

export class Resource<T> {
  readonly defaultContentType: string;
  readonly kind: string;

  constructor(options: { defaultContentType?: string; kind: string }) {
    this.defaultContentType = options.defaultContentType ?? "application/json; charset=utf-8";
    this.kind = options.kind;
  }

  ref(input: ResourceRefInput): ResourceReference {
    const key = input.key ?? `${this.kind}/${input.id}.json`;

    return {
      id: input.id,
      key,
      kind: this.kind,
      ...(input.url ? { url: input.url } : {}),
    };
  }

  envelope(value: T, input: ResourceRefInput, provenance?: ResourceProvenance): ResourceEnvelope<T> {
    return {
      provenance,
      ref: this.ref(input),
      value,
    };
  }
}

function uuidToBytes(uuid: string) {
  const normalized = uuid.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(normalized)) {
    throw new Error(`Invalid UUID namespace: ${uuid}`);
  }

  return new Uint8Array(normalized.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? []);
}

function formatUuid(bytes: Uint8Array) {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export const medinaResourceNamespaceUuid = "0f5d7c9d-4b0d-4b45-a7cb-3d4d5ff7e5a1";

export async function createDeterministicResourceUuid(name: string, namespace = medinaResourceNamespaceUuid) {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes);
  input.set(nameBytes, namespaceBytes.length);

  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const uuidBytes = hash.slice(0, 16);
  uuidBytes[6] = ((uuidBytes[6] ?? 0) & 0x0f) | 0x50;
  uuidBytes[8] = ((uuidBytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(uuidBytes);
}

export function resolveTempFilePath(fileName: string) {
  const normalizedName = path.basename(fileName.trim()) || "ingest";
  return path.join("/tmp", normalizedName);
}

export async function fetchBucketObjectToTempFile(
  key: string,
  fileName: string,
  options?: {
    bucket: Bucket;
    tempDir?: string;
  },
): Promise<string> {
  if (!options?.bucket) throw new Error("fetchBucketObjectToTempFile requires an explicit bucket.");
  const bucketInstance = options.bucket;
  const tempDir = options?.tempDir ?? await mkdtemp(path.join(tmpdir(), "medina-resource-"));
  const tempPath = path.join(tempDir, path.basename(fileName.trim()) || "ingest");
  if (bucketInstance.downloadToFile) {
    await bucketInstance.downloadToFile(key, tempPath);
  } else {
    await writeFile(tempPath, new Uint8Array(await bucketInstance.readArrayBuffer(key)));
  }
  return tempPath;
}

export async function writeBucketJson(key: string, value: unknown, bucketInstance: Bucket): Promise<void> {
  await bucketInstance.write(key, `${JSON.stringify(value, null, 2)}\n`, {
    type: "application/json; charset=utf-8",
  });
}

export function parseResourceArgs(argv = process.argv) {
  const scriptName = basename(argv[1] ?? "resource-script");
  const inputKey = argv[2];

  if (!inputKey) {
    throw new Error(`usage: ${scriptName} <bucket-key> [--force]`);
  }

  return {
    force: argv.includes("--force"),
    inputKey: normalizeBucketKey(inputKey),
  };
}

function normalizeOutputKeys(outputs: string[]) {
  return outputs.map((key) => normalizeBucketKey(key));
}

function sameOrderedKeys(left: string[], right: string[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function mapConcurrent<T, Result>(items: T[], concurrency: number, fn: (item: T) => Promise<Result>): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]!);
    }
  }));

  return results;
}

export async function runResource<State>(
  definition: ResourceDefinition<State>,
  options: {
    artifacts?: ArtifactResolver;
    bucket: Bucket;
    dryRun?: boolean;
    force?: boolean;
    inputKey: string;
    now?: Date;
    progress?: ResourceContext["progress"];
  },
): Promise<ResourceRunResult<State>> {
  const dryRun = options.dryRun ?? false;
  const context: ResourceContext = {
    artifacts: options.artifacts,
    bucket: options.bucket,
    force: options.force ?? false,
    inputKey: normalizeBucketKey(options.inputKey),
    now: options.now ?? new Date(),
    progress: options.progress,
  };
  const plan = await definition.plan(context);
  const outputs = normalizeOutputKeys(plan.outputs);
  const normalizedPlan: ResourcePlan<State> = {
    ...plan,
    outputs,
  };
  const dependencies = await fingerprintDependencies(context.bucket, normalizedPlan.dependencies);
  const dependencySetHash = await getDependencySetHash(dependencies);

  if (outputs.length === 0) {
    return {
      definition,
      dependencies,
      freshness: [],
      materialized: false,
      outputs,
      plan: normalizedPlan,
      warnings: [],
      wouldMaterialize: false,
    };
  }

  const checkConcurrency = Math.max(1, Math.trunc(Number(process.env.RESOURCE_CHECK_CONCURRENCY ?? "8")) || 8);
  const outputStates = await mapConcurrent(outputs, checkConcurrency, async (resourceKey) => {
    const exists = await context.bucket.exists(resourceKey);
    return {
      exists,
      receipt: exists ? await readMaterializationReceipt(context.bucket, resourceKey) : null,
    };
  });
  const receipts = outputStates.map((state) => state.receipt);
  const outputExists = outputStates.map((state) => state.exists);
  const freshness = outputs.map((resourceKey, index) => getMaterializationFreshness({
    currentDependencies: dependencies,
    currentDependencySetHash: dependencySetHash,
    definition,
    force: context.force,
    now: context.now,
    outputExists: outputExists[index] ?? false,
    receipt: receipts[index] ?? null,
  }));

  const needsMaterialization = freshness.some((result) => !result.fresh);

  if (!needsMaterialization || dryRun) {
    return {
      definition,
      dependencies,
      freshness,
      materialized: false,
      outputs,
      plan: normalizedPlan,
      warnings: receipts.flatMap((receipt) => receipt?.warnings ?? []),
      wouldMaterialize: needsMaterialization,
    };
  }

  const warnings: ResourceWarning[] = [];
  const materializedOutputs = normalizeOutputKeys(await definition.materialize({
    ...context,
    dependencies,
    plan: normalizedPlan,
    warn(warning) {
      warnings.push(warning);
      console.warn(`[resource] ${definition.name} ${context.inputKey} degraded: ${warning.code}: ${warning.message}`);
      for (const listener of warningListeners) {
        try {
          listener({ definition: { name: definition.name, version: definition.version }, inputKey: context.inputKey, warning });
        } catch {
          // Listeners must not break materialization.
        }
      }
    },
  }) ?? outputs);

  if (!sameOrderedKeys(outputs, materializedOutputs)) {
    throw new Error(
      `Materialized outputs for ${definition.name} did not match the planned outputs.\nplanned=${JSON.stringify(outputs)}\nactual=${JSON.stringify(materializedOutputs)}`,
    );
  }

  for (const resourceKey of outputs) {
    await writeMaterializationReceipt(context.bucket, createMaterializationReceipt({
      definition,
      dependencySetHash,
      dependencies,
      materializedAt: context.now,
      resourceKey,
      warnings,
    }));
  }

  return {
    definition,
    dependencies,
    freshness,
    materialized: true,
    outputs,
    plan: normalizedPlan,
    warnings,
    wouldMaterialize: true,
  };
}

