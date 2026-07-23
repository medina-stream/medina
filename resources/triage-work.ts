import type { ArtifactResolver } from "../lib/artifact";
import type { Bucket } from "../lib/bucket";
import { normalizeBucketKey } from "../lib/bucket";
import { dispatchTriageResult } from "../lib/ingest-handlers";
import { priorityForIngestKey } from "../lib/ingest-priority";
import { readIngestRequestInfo } from "../lib/ingest";
import { runResource } from "../lib/resource";
import {
  completeWork,
  ensureWork,
  failWork,
  readWork,
  repairWorkQueuePointers,
  workItemKey,
  type WorkItem,
} from "../lib/work-queue";
import { readTriageResult, triageDefinition } from "./triage";

export const triageWorkDefinition = { name: "triage", version: "1" } as const;

export type TriageWorkDiscoverySummary = {
  created: number;
  dispatchedHandlers: number;
  existingWork: number;
  ingestKeys: number;
  skippedFresh: number;
};

type Cursor = { after?: string };

const discoveryCursorKey = "worker-state/triage-discovery.json";
const reconciliationCursorKey = "worker-state/work-reconciliation/triage.json";

async function readCursor(bucket: Bucket, key: string) {
  if (!(await bucket.exists(key))) return undefined;
  return (await bucket.readJson<Cursor>(key).catch(() => null))?.after;
}

async function writeCursor(bucket: Bucket, key: string, after?: string) {
  await bucket.write(key, `${JSON.stringify({ after }, null, 2)}\n`, { type: "application/json; charset=utf-8" });
}

export function triageWorkItemKey(ingestKey: string) {
  return workItemKey(triageWorkDefinition.name, ingestKey);
}

async function getPriorityAt(bucket: Bucket, ingestKey: string) {
  const [request, stat] = await Promise.all([
    readIngestRequestInfo(bucket, ingestKey),
    bucket.stat(ingestKey),
  ]);
  return request?.metadata["created-at"] ?? request?.requestedAt ?? stat.lastModified.toISOString();
}

export async function ensureTriageWork(options: {
  bucket: Bucket;
  ingestKey: string;
  now?: Date;
  priority?: number;
  priorityAt?: string;
  reopenFailed?: boolean;
  visibleAt?: string;
}) {
  const now = options.now ?? new Date();
  const ingestKey = normalizeBucketKey(options.ingestKey);
  const existing = await readWork(options.bucket, triageWorkDefinition.name, ingestKey);
  let reopenComplete = false;
  if (existing?.status === "complete" && existing.definition.version === triageWorkDefinition.version) {
    const freshness = await runResource(triageDefinition, { bucket: options.bucket, dryRun: true, inputKey: ingestKey, now });
    if (!freshness.wouldMaterialize) {
      const triage = await readTriageResult(options.bucket, ingestKey);
      if (triage) await dispatchTriageResult({ bucket: options.bucket, now, result: triage });
      return existing;
    }
    reopenComplete = true;
  }
  const priorityAt = options.priorityAt ?? await getPriorityAt(options.bucket, ingestKey);
  return await ensureWork({
    bucket: options.bucket,
    definition: triageWorkDefinition,
    inputKey: ingestKey,
    now,
    priority: options.priority ?? priorityForIngestKey(ingestKey, priorityAt),
    reopenComplete,
    reopenFailed: options.reopenFailed,
    visibleAt: options.visibleAt,
  });
}

export async function reconcileTriageWork(options: {
  bucket: Bucket;
  limit?: number;
  now?: Date;
  scanLimit?: number;
}): Promise<TriageWorkDiscoverySummary> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 100;
  const startAfter = await readCursor(options.bucket, discoveryCursorKey);
  const page = await options.bucket.list({ prefix: "in/", startAfter, maxKeys: Math.max(limit, options.scanLimit ?? 500) });
  const objects = page.contents ?? [];
  const summary: TriageWorkDiscoverySummary = { created: 0, dispatchedHandlers: 0, existingWork: 0, ingestKeys: 0, skippedFresh: 0 };
  let lastScanned: string | undefined;

  for (const object of objects) {
    if (summary.created >= limit) break;
    lastScanned = object.key;
    summary.ingestKeys += 1;
    const existing = await readWork(options.bucket, triageWorkDefinition.name, object.key);
    if (existing?.status === "pending" || existing?.status === "running"
      || (existing?.status === "failed" && existing.definition.version === triageWorkDefinition.version)) {
      summary.existingWork += 1;
      continue;
    }
    const freshness = await runResource(triageDefinition, { bucket: options.bucket, dryRun: true, inputKey: object.key, now });
    if (!freshness.wouldMaterialize) {
      const triage = await readTriageResult(options.bucket, object.key);
      if (triage) {
        const dispatch = await dispatchTriageResult({ bucket: options.bucket, now, result: triage });
        summary.dispatchedHandlers += dispatch.matchedHandlers.length;
      }
      summary.skippedFresh += 1;
      continue;
    }
    await ensureTriageWork({ bucket: options.bucket, ingestKey: object.key, now });
    summary.created += 1;
  }

  const exhausted = summary.ingestKeys === objects.length;
  await writeCursor(options.bucket, discoveryCursorKey, exhausted && !page.isTruncated ? undefined : lastScanned ?? startAfter);
  return summary;
}

export async function executeTriageWork(options: {
  artifacts?: ArtifactResolver;
  backend: Bucket;
  maxAttempts: number;
  publishEvent(data: Record<string, unknown>): Promise<void>;
  work: WorkItem;
}) {
  try {
    const result = await runResource(triageDefinition, {
      artifacts: options.artifacts,
      bucket: options.backend,
      inputKey: options.work.inputKey,
    });
    const triage = await readTriageResult(options.backend, options.work.inputKey);
    if (!triage) throw new Error(`Missing triage result for ${options.work.inputKey}`);
    const dispatch = await dispatchTriageResult({ bucket: options.backend, result: triage });
    await completeWork({
      bucket: options.backend,
      result: {
        dispatchMembershipKeys: dispatch.createdMembershipKeys,
        matchedHandlers: dispatch.matchedHandlers,
        outputs: result.outputs,
        workKeys: dispatch.workKeys,
      },
      work: options.work,
    });
    await options.publishEvent({
      disposition: triage.disposition,
      ingestKey: triage.ingestKey,
      kind: triage.content.kind,
      matchedHandlers: dispatch.matchedHandlers,
      type: "triage.completed",
    });
    return true;
  } catch (error) {
    await failWork({
      bucket: options.backend,
      error,
      maxAttempts: options.maxAttempts,
      retryable: true,
      work: options.work,
    });
    await options.publishEvent({
      error: error instanceof Error ? error.message : String(error),
      ingestKey: options.work.inputKey,
      type: "triage.failed",
    });
    return true;
  }
}

export async function reconcileTriageQueue(bucket: Bucket, scanLimit = 100) {
  const startAfter = await readCursor(bucket, reconciliationCursorKey);
  const summary = await repairWorkQueuePointers({
    bucket,
    definitionName: triageWorkDefinition.name,
    scanLimit,
    startAfter,
  });
  await writeCursor(bucket, reconciliationCursorKey, summary.nextAfter);
  return summary;
}
