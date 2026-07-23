import { listAllBucketKeys, normalizeBucketKey, type Bucket } from "./bucket";
import { decodeOrchestrationKeySegment, encodeOrchestrationKeySegment } from "./orchestration-keys";

export type WorkStatus = "pending" | "running" | "complete" | "failed";

export type WorkDefinition = {
  name: string;
  version: string;
};

export type WorkGenerationHistory = {
  attempts: number;
  completedAt?: string;
  generation: number;
  lastError?: string;
  result?: Record<string, unknown>;
  status: WorkStatus;
  updatedAt: string;
};

export type WorkItem = {
  attempts: number;
  completedAt?: string;
  history?: WorkGenerationHistory[];
  createdAt: string;
  definition: WorkDefinition;
  generation: number;
  generationCreatedAt?: string;
  inputKey: string;
  lastError?: string;
  leaseExpiresAt?: string;
  leaseToken?: string;
  priority: number;
  result?: Record<string, unknown>;
  rerunRequestedAt?: string;
  status: WorkStatus;
  updatedAt: string;
  visibleAt: string;
  workerId?: string;
};

export type WorkLeaseHandle = Pick<WorkItem, "definition" | "generation" | "inputKey" | "leaseToken" | "workerId">;

export type WorkQueuePointer = {
  generation: number;
  inputKey: string;
  priority: number;
  visibleAt: string;
  workKey: string;
};

export type EnsureWorkOptions = {
  bucket: Bucket;
  definition: WorkDefinition;
  inputKey: string;
  now?: Date;
  priority?: number;
  reopenComplete?: boolean;
  reopenFailed?: boolean;
  rerunRunning?: boolean;
  reschedulePending?: boolean;
  visibleAt?: Date | string;
};

export type ClaimWorkOptions = {
  bucket: Bucket;
  definitionName: string;
  leaseMs?: number;
  now?: Date;
  scanLimit?: number;
  tokenFactory?: () => string;
  workerId: string;
};

export type CompleteWorkOptions = {
  bucket: Bucket;
  now?: Date;
  result?: Record<string, unknown>;
  work: WorkLeaseHandle;
};

export type FailWorkOptions = {
  backoffMs?: (attempts: number) => number;
  bucket: Bucket;
  error: unknown;
  maxAttempts?: number;
  now?: Date;
  retryable?: boolean;
  work: WorkLeaseHandle;
};

export type RebuildWorkQueuePointersOptions = {
  bucket: Bucket;
  definitionName: string;
};

export type RebuildWorkQueuePointersSummary = {
  active: number;
  created: number;
  deleted: number;
};

export type RepairWorkQueuePointersOptions = {
  bucket: Bucket;
  definitionName: string;
  scanLimit?: number;
  startAfter?: string;
};

export type RepairWorkQueuePointersSummary = {
  created: number;
  nextAfter?: string;
  scanned: number;
};

const JSON_TYPE = "application/json; charset=utf-8";
const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const PRIORITY_KEY_OFFSET = BigInt(Number.MAX_SAFE_INTEGER);
const PRIORITY_KEY_WIDTH = (PRIORITY_KEY_OFFSET * 2n).toString().length;
const TIMESTAMP_KEY_OFFSET = 1_000_000_000_000_000n;
const TIMESTAMP_KEY_WIDTH = (TIMESTAMP_KEY_OFFSET * 2n).toString().length;

function nowIso(now = new Date()) {
  return now.toISOString();
}

function normalizeDefinitionName(definitionName: string) {
  return normalizeBucketKey(definitionName);
}

function normalizeDefinition(definition: WorkDefinition): WorkDefinition {
  const name = normalizeDefinitionName(definition.name);
  if (typeof definition.version !== "string" || definition.version.length === 0) {
    throw new Error(`Invalid work definition version for ${name}.`);
  }

  return { name, version: definition.version };
}

function normalizeInputKey(inputKey: string) {
  return normalizeBucketKey(inputKey);
}

function normalizePriority(priority: number) {
  if (!Number.isFinite(priority) || !Number.isSafeInteger(priority)) {
    throw new Error(`Invalid work priority: ${priority}`);
  }

  return priority;
}

function toIsoString(value: Date | string | undefined, fallback: Date) {
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : fallback;

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid work timestamp: ${value}`);
  }

  return date.toISOString();
}

function minIso(left: string, right: string) {
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function encodePriorityKey(priority: number) {
  const normalized = normalizePriority(priority);
  return (BigInt(normalized) + PRIORITY_KEY_OFFSET).toString().padStart(PRIORITY_KEY_WIDTH, "0");
}

function encodeTimestampKey(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(timestamp)) {
    throw new Error(`Invalid work timestamp: ${value}`);
  }

  return (BigInt(timestamp) + TIMESTAMP_KEY_OFFSET).toString().padStart(TIMESTAMP_KEY_WIDTH, "0");
}

function isTrackedStatus(status: WorkStatus) {
  return status === "pending" || status === "running";
}

function stringifyJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function encodeWorkKeySegment(value: string) {
  return encodeOrchestrationKeySegment(normalizeInputKey(value));
}

export function decodeWorkKeySegment(value: string) {
  try {
    return normalizeInputKey(decodeOrchestrationKeySegment(value));
  } catch {
    throw new Error(`Invalid encoded work key segment: ${value}`);
  }
}

export function workItemKey(definitionName: string, inputKey: string) {
  return normalizeBucketKey(`work/${normalizeDefinitionName(definitionName)}/${encodeWorkKeySegment(inputKey)}.json`);
}

export function workQueuePrefix(definitionName: string) {
  return normalizeBucketKey(`work-queue/${normalizeDefinitionName(definitionName)}/`);
}

function readyQueuePrefix(definitionName: string) {
  return `${workQueuePrefix(definitionName)}ready/`;
}

function deferredQueuePrefix(definitionName: string) {
  return `${workQueuePrefix(definitionName)}deferred/`;
}

function leasedQueuePrefix(definitionName: string) {
  return `${workQueuePrefix(definitionName)}leased/`;
}

export function workQueuePointerKey(work: Pick<WorkItem, "definition" | "inputKey" | "leaseExpiresAt" | "priority" | "status" | "updatedAt" | "visibleAt">) {
  const encodedInput = encodeWorkKeySegment(work.inputKey);
  if (work.status === "running") {
    return normalizeBucketKey(
      `${leasedQueuePrefix(work.definition.name)}${encodeTimestampKey(work.leaseExpiresAt ?? work.updatedAt)}-${encodedInput}.json`,
    );
  }

  const visible = new Date(work.visibleAt).getTime() <= new Date(work.updatedAt).getTime();
  if (visible) {
    return normalizeBucketKey(
      `${readyQueuePrefix(work.definition.name)}${encodePriorityKey(work.priority)}-${encodedInput}.json`,
    );
  }

  return normalizeBucketKey(
    `${deferredQueuePrefix(work.definition.name)}${encodeTimestampKey(work.visibleAt)}-${encodePriorityKey(work.priority)}-${encodedInput}.json`,
  );
}

function buildQueuePointer(work: WorkItem): WorkQueuePointer {
  return {
    generation: work.generation,
    inputKey: work.inputKey,
    priority: work.priority,
    visibleAt: work.visibleAt,
    workKey: workItemKey(work.definition.name, work.inputKey),
  };
}

async function writeWork(bucket: Bucket, work: WorkItem) {
  await bucket.write(workItemKey(work.definition.name, work.inputKey), stringifyJson(work), { type: JSON_TYPE });
}

async function writeQueuePointer(bucket: Bucket, work: WorkItem) {
  if (!isTrackedStatus(work.status)) return;
  await bucket.write(workQueuePointerKey(work), stringifyJson(buildQueuePointer(work)), { type: JSON_TYPE });
}

async function syncQueuePointer(bucket: Bucket, previous: WorkItem | null, next: WorkItem | null) {
  const previousKey = previous && isTrackedStatus(previous.status) ? workQueuePointerKey(previous) : null;
  const nextKey = next && isTrackedStatus(next.status) ? workQueuePointerKey(next) : null;

  if (previousKey && previousKey !== nextKey) {
    await bucket.delete(previousKey);
  }

  if (next && nextKey) {
    await bucket.write(nextKey, stringifyJson(buildQueuePointer(next)), { type: JSON_TYPE });
  }
}

function createPendingWork(options: {
  definition: WorkDefinition;
  inputKey: string;
  now: Date;
  priority: number;
  visibleAt: string;
}): WorkItem {
  const createdAt = nowIso(options.now);
  return {
    attempts: 0,
    createdAt,
    definition: options.definition,
    generation: 1,
    generationCreatedAt: createdAt,
    inputKey: options.inputKey,
    priority: options.priority,
    status: "pending",
    updatedAt: createdAt,
    visibleAt: options.visibleAt,
  };
}

function createRunningWork(options: {
  current: WorkItem;
  leaseMs: number;
  now: Date;
  leaseToken: string;
  workerId: string;
}): WorkItem {
  return {
    ...options.current,
    attempts: options.current.attempts + 1,
    lastError: undefined,
    leaseExpiresAt: new Date(options.now.getTime() + options.leaseMs).toISOString(),
    leaseToken: options.leaseToken,
    status: "running",
    updatedAt: nowIso(options.now),
    workerId: options.workerId,
  };
}

function createCompletedWork(current: WorkItem, now: Date, result?: Record<string, unknown>): WorkItem {
  return {
    ...current,
    completedAt: nowIso(now),
    result,
    lastError: undefined,
    leaseExpiresAt: undefined,
    leaseToken: undefined,
    rerunRequestedAt: undefined,
    status: "complete",
    updatedAt: nowIso(now),
    workerId: undefined,
  };
}

function createFailedWork(options: {
  current: WorkItem;
  backoffMs: number;
  maxAttempts: number;
  now: Date;
  retryable: boolean;
  message: string;
}): WorkItem {
  const retry = options.retryable && options.current.attempts < options.maxAttempts;
  return {
    ...options.current,
    lastError: options.message,
    leaseExpiresAt: undefined,
    leaseToken: undefined,
    rerunRequestedAt: undefined,
    status: retry ? "pending" : "failed",
    updatedAt: nowIso(options.now),
    visibleAt: retry
      ? new Date(options.now.getTime() + options.backoffMs).toISOString()
      : nowIso(options.now),
    workerId: undefined,
  };
}

function reopenWork(options: {
  current: WorkItem;
  definition: WorkDefinition;
  now: Date;
  priority: number;
  visibleAt: string;
}): WorkItem {
  return {
    ...options.current,
    attempts: 0,
    completedAt: undefined,
    definition: options.definition,
    generation: options.current.generation + 1,
    generationCreatedAt: nowIso(options.now),
    history: [
      ...(options.current.history ?? []),
      {
        attempts: options.current.attempts,
        completedAt: options.current.completedAt,
        generation: options.current.generation,
        lastError: options.current.lastError,
        result: options.current.result,
        status: options.current.status,
        updatedAt: options.current.updatedAt,
      },
    ],
    lastError: undefined,
    leaseExpiresAt: undefined,
    leaseToken: undefined,
    priority: options.priority,
    result: undefined,
    rerunRequestedAt: undefined,
    status: "pending",
    updatedAt: nowIso(options.now),
    visibleAt: options.visibleAt,
    workerId: undefined,
  };
}

function updateLiveWork(options: {
  current: WorkItem;
  definition: WorkDefinition;
  now: Date;
  priority: number;
  rerunRunning: boolean;
  reschedulePending: boolean;
  visibleAt: string;
}): WorkItem {
  const rerunRunning = options.rerunRunning && options.current.status === "running";
  return {
    ...options.current,
    definition: options.definition,
    generationCreatedAt: options.current.generationCreatedAt ?? options.current.createdAt,
    priority: Math.min(options.current.priority, options.priority),
    rerunRequestedAt: rerunRunning ? nowIso(options.now) : options.current.rerunRequestedAt,
    updatedAt: nowIso(options.now),
    visibleAt: (options.reschedulePending && options.current.status === "pending") || rerunRunning
      ? options.visibleAt
      : minIso(options.current.visibleAt, options.visibleAt),
  };
}

function shouldReopenWork(current: WorkItem, definition: WorkDefinition, reopenComplete: boolean, reopenFailed: boolean) {
  if (current.definition.version !== definition.version) return true;
  if (current.status === "complete" && reopenComplete) return true;
  if (current.status === "failed" && reopenFailed) return true;
  return false;
}

function isEligibleToClaim(work: WorkItem, now: Date) {
  const nowMs = now.getTime();
  if (work.status === "pending") {
    return new Date(work.visibleAt).getTime() <= nowMs;
  }

  if (work.status === "running") {
    return new Date(work.leaseExpiresAt ?? work.updatedAt).getTime() <= nowMs;
  }

  return false;
}

function parseErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function readQueuePointer(bucket: Bucket, key: string): Promise<WorkQueuePointer | null> {
  try {
    return await bucket.readJson<WorkQueuePointer>(key);
  } catch {
    return null;
  }
}

export async function readWork(bucket: Bucket, definitionName: string, inputKey: string): Promise<WorkItem | null> {
  const key = workItemKey(definitionName, inputKey);
  if (!(await bucket.exists(key))) return null;
  return await bucket.readJson<WorkItem>(key);
}

export async function deleteWork(bucket: Bucket, definitionName: string, inputKey: string) {
  const current = await readWork(bucket, definitionName, inputKey);
  if (!current || current.status === "running") return false;
  if (isTrackedStatus(current.status)) await bucket.delete(workQueuePointerKey(current));
  await bucket.delete(workItemKey(definitionName, inputKey));
  return true;
}

function assertLeaseHandle(current: WorkItem, handle: WorkLeaseHandle) {
  if (current.generation !== handle.generation) {
    throw new Error(`Work generation mismatch for ${current.definition.name}:${current.inputKey}.`);
  }
  if (current.status !== "running") {
    throw new Error(`Work is not running for ${current.definition.name}:${current.inputKey}.`);
  }
  if (!handle.leaseToken || current.leaseToken !== handle.leaseToken) {
    throw new Error(`Work lease token mismatch for ${current.definition.name}:${current.inputKey}.`);
  }
  if (handle.workerId && current.workerId !== handle.workerId) {
    throw new Error(`Work worker mismatch for ${current.definition.name}:${current.inputKey}.`);
  }
}

export function getWorkRetryBackoffMs(attempts: number) {
  const normalizedAttempts = Number.isFinite(attempts) ? Math.max(0, Math.trunc(attempts)) : 0;
  const minutes = Math.min(60, Math.max(1, 2 ** Math.max(0, normalizedAttempts - 1)));
  return minutes * 60 * 1000;
}

export async function ensureWork(options: EnsureWorkOptions): Promise<WorkItem> {
  const now = options.now ?? new Date();
  const definition = normalizeDefinition(options.definition);
  const inputKey = normalizeInputKey(options.inputKey);
  const current = await readWork(options.bucket, definition.name, inputKey);
  const priority = normalizePriority(options.priority ?? current?.priority ?? 0);
  const visibleAt = toIsoString(options.visibleAt, now);

  if (!current) {
    const created = createPendingWork({ definition, inputKey, now, priority, visibleAt });
    await writeWork(options.bucket, created);
    await writeQueuePointer(options.bucket, created);
    return created;
  }

  if (current.definition.name !== definition.name || current.inputKey !== inputKey) {
    throw new Error(`Stored work key mismatch for ${definition.name}:${inputKey}.`);
  }

  const reopen = shouldReopenWork(
    current,
    definition,
    options.reopenComplete ?? false,
    options.reopenFailed ?? false,
  );
  if (!reopen && (current.status === "complete" || current.status === "failed")) {
    return current;
  }

  const next = reopen
    ? reopenWork({
      current,
      definition,
      now,
      priority: Math.min(current.priority, priority),
      visibleAt,
    })
    : updateLiveWork({
      current,
      definition,
      now,
      priority,
      rerunRunning: options.rerunRunning ?? false,
      reschedulePending: options.reschedulePending ?? false,
      visibleAt,
    });

  await writeWork(options.bucket, next);
  await syncQueuePointer(options.bucket, current, next);
  return next;
}

export async function claimWork(options: ClaimWorkOptions): Promise<WorkItem | null> {
  const now = options.now ?? new Date();
  const definitionName = normalizeDefinitionName(options.definitionName);
  const scanLimit = options.scanLimit ?? 200;
  const deferred = await options.bucket.list({ prefix: deferredQueuePrefix(definitionName), maxKeys: scanLimit });

  for (const object of deferred.contents ?? []) {
    const pointer = await readQueuePointer(options.bucket, object.key);
    if (!pointer) {
      await options.bucket.delete(object.key);
      continue;
    }
    if (new Date(pointer.visibleAt).getTime() > now.getTime()) break;

    const current = await readWork(options.bucket, definitionName, pointer.inputKey);
    if (!current || current.status !== "pending") {
      await options.bucket.delete(object.key);
      continue;
    }
    const expectedPointerKey = workQueuePointerKey(current);
    if (object.key !== expectedPointerKey) {
      await options.bucket.delete(object.key);
      await writeQueuePointer(options.bucket, current);
      continue;
    }

    const promoted = { ...current, updatedAt: nowIso(now) };
    await writeWork(options.bucket, promoted);
    await syncQueuePointer(options.bucket, current, promoted);
  }

  const ready = await options.bucket.list({ prefix: readyQueuePrefix(definitionName), maxKeys: scanLimit });
  for (const object of ready.contents ?? []) {
    const pointer = await readQueuePointer(options.bucket, object.key);
    if (!pointer) {
      await options.bucket.delete(object.key);
      continue;
    }

    const current = await readWork(options.bucket, definitionName, pointer.inputKey);
    if (!current || current.status !== "pending") {
      await options.bucket.delete(object.key);
      continue;
    }
    const expectedPointerKey = workQueuePointerKey(current);
    if (object.key !== expectedPointerKey) {
      await options.bucket.delete(object.key);
      await writeQueuePointer(options.bucket, current);
      continue;
    }
    if (!isEligibleToClaim(current, now)) continue;

    const claimed = createRunningWork({
      current,
      leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
      leaseToken: options.tokenFactory?.() ?? crypto.randomUUID(),
      now,
      workerId: options.workerId,
    });
    await writeWork(options.bucket, claimed);
    await syncQueuePointer(options.bucket, current, claimed);
    return claimed;
  }

  const leased = await options.bucket.list({ prefix: leasedQueuePrefix(definitionName), maxKeys: scanLimit });
  for (const object of leased.contents ?? []) {
    const pointer = await readQueuePointer(options.bucket, object.key);
    if (!pointer) {
      await options.bucket.delete(object.key);
      continue;
    }

    const current = await readWork(options.bucket, definitionName, pointer.inputKey);
    if (!current || current.status !== "running") {
      await options.bucket.delete(object.key);
      continue;
    }
    const expectedPointerKey = workQueuePointerKey(current);
    if (object.key !== expectedPointerKey) {
      await options.bucket.delete(object.key);
      await writeQueuePointer(options.bucket, current);
      continue;
    }
    if (!isEligibleToClaim(current, now)) break;

    const reclaimed = createRunningWork({
      current,
      leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
      leaseToken: options.tokenFactory?.() ?? crypto.randomUUID(),
      now,
      workerId: options.workerId,
    });
    await writeWork(options.bucket, reclaimed);
    await syncQueuePointer(options.bucket, current, reclaimed);
    return reclaimed;
  }

  return null;
}

export async function completeWork(options: CompleteWorkOptions): Promise<WorkItem> {
  const current = await readWork(options.bucket, options.work.definition.name, options.work.inputKey);
  if (!current) {
    throw new Error(`Work not found for ${options.work.definition.name}:${options.work.inputKey}.`);
  }

  assertLeaseHandle(current, options.work);

  const now = options.now ?? new Date();
  const rerunRequested = Boolean(current.rerunRequestedAt);
  const completed = createCompletedWork(current, now, options.result);
  const next = rerunRequested
    ? reopenWork({
      current: completed,
      definition: completed.definition,
      now,
      priority: completed.priority,
      visibleAt: current.visibleAt,
    })
    : completed;
  await writeWork(options.bucket, next);
  await syncQueuePointer(options.bucket, current, next);
  return next;
}

export async function failWork(options: FailWorkOptions): Promise<WorkItem> {
  const current = await readWork(options.bucket, options.work.definition.name, options.work.inputKey);
  if (!current) {
    throw new Error(`Work not found for ${options.work.definition.name}:${options.work.inputKey}.`);
  }

  assertLeaseHandle(current, options.work);

  const failed = createFailedWork({
    backoffMs: (options.backoffMs ?? getWorkRetryBackoffMs)(current.attempts),
    current,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    message: parseErrorMessage(options.error),
    now: options.now ?? new Date(),
    retryable: options.retryable !== false,
  });
  await writeWork(options.bucket, failed);
  await syncQueuePointer(options.bucket, current, failed);
  return failed;
}

export async function repairWorkQueuePointers(options: RepairWorkQueuePointersOptions): Promise<RepairWorkQueuePointersSummary> {
  const definitionName = normalizeDefinitionName(options.definitionName);
  const page = await options.bucket.list({
    prefix: `work/${definitionName}/`,
    startAfter: options.startAfter,
    maxKeys: options.scanLimit ?? 100,
  });
  const objects = page.contents ?? [];
  let created = 0;

  for (const object of objects) {
    if (!object.key.endsWith(".json")) continue;
    const work = await options.bucket.readJson<WorkItem>(object.key).catch(() => null);
    if (!work || !isTrackedStatus(work.status)) continue;
    const pointerKey = workQueuePointerKey(work);
    if (await options.bucket.exists(pointerKey)) continue;
    await writeQueuePointer(options.bucket, work);
    created += 1;
  }

  return {
    created,
    nextAfter: page.isTruncated ? objects.at(-1)?.key : undefined,
    scanned: objects.length,
  };
}

export async function rebuildWorkQueuePointers(options: RebuildWorkQueuePointersOptions): Promise<RebuildWorkQueuePointersSummary> {
  const definitionName = normalizeDefinitionName(options.definitionName);
  const [workKeys, queueKeys] = await Promise.all([
    listAllBucketKeys(options.bucket, { prefix: `work/${definitionName}/` }),
    listAllBucketKeys(options.bucket, { prefix: workQueuePrefix(definitionName) }),
  ]);

  const expectedPointers = new Map<string, WorkItem>();
  for (const key of workKeys) {
    if (!key.endsWith(".json")) continue;
    const work = await options.bucket.readJson<WorkItem>(key);
    if (work.definition.name !== definitionName || work.status === "complete" || work.status === "failed") {
      continue;
    }

    expectedPointers.set(workQueuePointerKey(work), work);
  }

  let deleted = 0;
  for (const queueKey of queueKeys) {
    if (!expectedPointers.has(queueKey)) {
      await options.bucket.delete(queueKey);
      deleted += 1;
      continue;
    }

    expectedPointers.delete(queueKey);
  }

  let created = 0;
  for (const work of expectedPointers.values()) {
    await writeQueuePointer(options.bucket, work);
    created += 1;
  }

  return {
    active: expectedPointers.size + (queueKeys.length - deleted),
    created,
    deleted,
  };
}
