import type { Bucket } from "../lib/bucket";
import {
  completeWork,
  ensureWork,
  failWork,
  readWork,
  repairWorkQueuePointers,
  workItemKey,
  type WorkItem,
} from "../lib/work-queue";
import { runResource } from "../lib/resource";
import { gpsHourDefinition, parseGpsHourId } from "./gps-hour";

export const gpsHourWorkDefinition = { name: "gps-hour", version: "3" } as const;
export const gpsHourDebounceMs = 60 * 1000;
export const gpsHourMaxDelayMs = 10 * 60 * 1000;

const reconciliationCursorKey = "worker-state/work-reconciliation/gps-hour.json";
const jsonType = "application/json; charset=utf-8";

type Cursor = { after?: string };

function visibleAtForMembership(input: { current: WorkItem | null; now: Date }) {
  const generationStartedAt = input.current?.status === "pending" || input.current?.status === "running"
    ? new Date(input.current.generationCreatedAt ?? input.current.createdAt)
    : input.now;
  const debounceAt = input.now.getTime() + gpsHourDebounceMs;
  const maximumAt = generationStartedAt.getTime() + gpsHourMaxDelayMs;
  return new Date(Math.min(debounceAt, maximumAt));
}

export function gpsHourWorkItemKey(hourId: string) {
  return workItemKey(gpsHourWorkDefinition.name, hourId);
}

export async function ensureGpsHourWork(input: {
  bucket: Bucket;
  hourId: string;
  membershipChanged: boolean;
  now?: Date;
  priority?: number;
}) {
  const now = input.now ?? new Date();
  const parsedHour = parseGpsHourId(input.hourId);
  const hourId = parsedHour.id;
  const current = await readWork(input.bucket, gpsHourWorkDefinition.name, hourId);
  if (current && !input.membershipChanged) return current;

  return await ensureWork({
    bucket: input.bucket,
    definition: gpsHourWorkDefinition,
    inputKey: hourId,
    now,
    priority: input.priority ?? -parsedHour.startTime.getTime(),
    reopenComplete: input.membershipChanged,
    reopenFailed: input.membershipChanged,
    rerunRunning: input.membershipChanged,
    reschedulePending: input.membershipChanged,
    visibleAt: visibleAtForMembership({ current, now }),
  });
}

export async function executeGpsHourWork(options: {
  backend: Bucket;
  maxAttempts: number;
  publishEvent(data: Record<string, unknown>): Promise<void>;
  work: WorkItem;
}) {
  try {
    const result = await runResource(gpsHourDefinition, {
      bucket: options.backend,
      inputKey: options.work.inputKey,
    });
    const hour = await options.backend.readJson<{ collapsedCount: number; rawCount: number }>(result.outputs[0]!);
    await completeWork({
      bucket: options.backend,
      result: {
        collapsedCount: hour.collapsedCount,
        outputs: result.outputs,
        rawCount: hour.rawCount,
      },
      work: options.work,
    });
    await options.publishEvent({
      collapsedCount: hour.collapsedCount,
      hourId: options.work.inputKey,
      rawCount: hour.rawCount,
      type: "gps-hour.completed",
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
      hourId: options.work.inputKey,
      type: "gps-hour.failed",
    });
    return true;
  }
}

async function readReconciliationCursor(bucket: Bucket) {
  if (!(await bucket.exists(reconciliationCursorKey))) return undefined;
  return (await bucket.readJson<Cursor>(reconciliationCursorKey).catch(() => null))?.after;
}

export async function reconcileGpsHourQueue(bucket: Bucket, scanLimit = 100) {
  const summary = await repairWorkQueuePointers({
    bucket,
    definitionName: gpsHourWorkDefinition.name,
    scanLimit,
    startAfter: await readReconciliationCursor(bucket),
  });
  await bucket.write(reconciliationCursorKey, `${JSON.stringify({ after: summary.nextAfter }, null, 2)}\n`, { type: jsonType });
  return summary;
}
