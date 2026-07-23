import type { ArtifactRef } from "./artifact";
import { normalizeBucketKey, type Bucket } from "./bucket";
import {
  decodeOrchestrationKeySegment,
  dispatchGroupPrefix,
  dispatchMembershipKey,
  dispatchStateKey,
  encodeOrchestrationKeySegment,
  triageKey,
} from "./orchestration-keys";
import type { TriageContentKind } from "./ingest-classification";
import type { TriageDisposition, TriageResult } from "./triage";
import { workItemKey, type WorkDefinition, type WorkItem } from "./work-queue";

export type { TriageContentKind } from "./ingest-classification";
export type { TriageDisposition, TriageResult } from "./triage";

const JSON_TYPE = "application/json; charset=utf-8";

export type IngestHandlerSchedule =
  | { mode: "immediate" }
  | { mode: "debounce"; delayMs: number; maxDelayMs: number }
  | { mode: "periodic"; intervalMs: number }
  | { mode: "lazy" };

export type DispatchMembership = {
  artifact: ArtifactRef;
  content: TriageResult["content"];
  createdAt: string;
  groupKey: string;
  handler: { name: string; work: { name: string; version: string } };
  ingestKey: string;
  inputKey: string;
  priority: number;
  triageKey: string;
  version: 1;
};

export type IngestHandlerDefinition = {
  accepts(result: TriageResult): boolean;
  dispositions?: readonly TriageDisposition[];
  ensureWork(input: {
    bucket: Bucket;
    membership: DispatchMembership;
    membershipChanged: boolean;
    now: Date;
    result: TriageResult;
  }): Promise<WorkItem | null>;
  groupKey(result: TriageResult): string;
  inputKey(result: TriageResult): string;
  name: string;
  priority(result: TriageResult): number;
  schedule: IngestHandlerSchedule;
  work: WorkDefinition;
};

const ingestHandlers = new Map<string, IngestHandlerDefinition>();

function nowIso(now = new Date()) {
  return now.toISOString();
}

function stringifyJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertNonEmptyString(value: string, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}: expected a non-empty string.`);
  }
  return value;
}

function normalizeWorkDefinition(work: WorkDefinition): WorkDefinition {
  const name = normalizeBucketKey(work.name);
  const version = assertNonEmptyString(work.version, `work definition version for ${name}`);
  return { name, version };
}

function normalizePriority(priority: number) {
  if (!Number.isFinite(priority) || !Number.isSafeInteger(priority)) {
    throw new Error(`Invalid ingest handler priority: ${priority}`);
  }

  return priority;
}

export {
  decodeOrchestrationKeySegment,
  dispatchGroupPrefix,
  dispatchMembershipKey,
  dispatchStateKey,
  encodeOrchestrationKeySegment,
  triageKey,
};

export function registerIngestHandler(def: IngestHandlerDefinition) {
  const name = normalizeBucketKey(def.name);
  const existing = ingestHandlers.get(name);
  if (existing) {
    throw new Error(`Ingest handler already registered: ${name}`);
  }

  const registered: IngestHandlerDefinition = {
    ...def,
    name,
    work: normalizeWorkDefinition(def.work),
  };
  ingestHandlers.set(name, registered);
  return registered;
}

export function setIngestHandler(def: IngestHandlerDefinition) {
  const name = normalizeBucketKey(def.name);
  const registered: IngestHandlerDefinition = {
    ...def,
    name,
    work: normalizeWorkDefinition(def.work),
  };
  ingestHandlers.set(name, registered);
  return registered;
}

export function listIngestHandlers() {
  return [...ingestHandlers.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function clearIngestHandlers() {
  ingestHandlers.clear();
}

export const resetIngestHandlers = clearIngestHandlers;

async function readExistingMembership(bucket: Bucket, key: string): Promise<DispatchMembership | null> {
  if (!(await bucket.exists(key))) return null;
  return await bucket.readJson<DispatchMembership>(key).catch(() => null);
}

async function writeMembership(bucket: Bucket, key: string, membership: DispatchMembership) {
  await bucket.write(key, stringifyJson(membership), { type: JSON_TYPE });
}

function createMembership(options: {
  handler: IngestHandlerDefinition;
  now: Date;
  result: TriageResult;
}): DispatchMembership {
  const work = normalizeWorkDefinition(options.handler.work);
  const ingestKey = normalizeBucketKey(options.result.ingestKey);
  return {
    artifact: options.result.artifact,
    content: options.result.content,
    createdAt: nowIso(options.now),
    groupKey: assertNonEmptyString(options.handler.groupKey(options.result), `group key for handler ${options.handler.name}`),
    handler: {
      name: options.handler.name,
      work,
    },
    ingestKey,
    inputKey: normalizeBucketKey(options.handler.inputKey(options.result)),
    priority: normalizePriority(options.handler.priority(options.result)),
    triageKey: triageKey(ingestKey),
    version: 1,
  };
}

export async function dispatchTriageResult(input: {
  bucket: Bucket;
  now?: Date;
  result: TriageResult;
}): Promise<{
  createdMembershipKeys: string[];
  matchedHandlers: string[];
  workKeys: string[];
}> {
  const now = input.now ?? new Date();
  const createdMembershipKeys = new Set<string>();
  const matchedHandlers = new Set<string>();
  const membershipKeys = new Set<string>();
  const workKeys = new Set<string>();
  const stateKey = dispatchStateKey(input.result.ingestKey);
  const previousState: { membershipKeys?: string[]; triageKey?: string } = await input.bucket.exists(stateKey)
    ? await input.bucket.readJson<{ membershipKeys?: string[]; triageKey?: string }>(stateKey).catch(() => ({}))
    : {};

  for (const handler of listIngestHandlers()) {
    const dispositions = handler.dispositions ?? ["dispatch"];
    if (!dispositions.includes(input.result.disposition) || !handler.accepts(input.result)) continue;
    matchedHandlers.add(handler.name);

    const candidateMembership = createMembership({ handler, now, result: input.result });
    const membershipKey = dispatchMembershipKey(handler.name, candidateMembership.groupKey, candidateMembership.triageKey);
    membershipKeys.add(membershipKey);
    const existingMembership = await readExistingMembership(input.bucket, membershipKey);
    const membership = existingMembership
      ? { ...candidateMembership, createdAt: existingMembership.createdAt }
      : candidateMembership;

    const membershipChanged = !existingMembership || JSON.stringify(existingMembership) !== JSON.stringify(membership);
    if (membershipChanged) {
      await writeMembership(input.bucket, membershipKey, membership);
      if (!existingMembership) createdMembershipKeys.add(membershipKey);
    }

    const work = await handler.ensureWork({
      bucket: input.bucket,
      membership,
      membershipChanged,
      now,
      result: input.result,
    });
    if (work) workKeys.add(workItemKey(work.definition.name, work.inputKey));
  }

  for (const previousKey of previousState.membershipKeys ?? []) {
    if (membershipKeys.has(previousKey)) continue;
    const previousMembership = await readExistingMembership(input.bucket, previousKey);
    if (previousMembership) {
      const previousHandler = listIngestHandlers().find((handler) => handler.name === previousMembership.handler.name);
      if (previousHandler) {
        const work = await previousHandler.ensureWork({
          bucket: input.bucket,
          membership: previousMembership,
          membershipChanged: true,
          now,
          result: input.result,
        });
        if (work) workKeys.add(workItemKey(work.definition.name, work.inputKey));
      }
    }
    await input.bucket.delete(previousKey);
  }
  const sortedMembershipKeys = [...membershipKeys].sort();
  const sourceTriageKey = triageKey(input.result.ingestKey);
  if (JSON.stringify(previousState.membershipKeys ?? []) !== JSON.stringify(sortedMembershipKeys)
    || previousState.triageKey !== sourceTriageKey) {
    await input.bucket.write(stateKey, stringifyJson({
      membershipKeys: sortedMembershipKeys,
      triageKey: sourceTriageKey,
      updatedAt: nowIso(now),
      version: 1,
    }), { type: JSON_TYPE });
  }

  return {
    createdMembershipKeys: [...createdMembershipKeys],
    matchedHandlers: [...matchedHandlers],
    workKeys: [...workKeys],
  };
}
