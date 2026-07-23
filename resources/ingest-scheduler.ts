#!/usr/bin/env bun

import type { ArtifactResolver } from "../lib/artifact";
import type { Bucket } from "../lib/bucket";
import { priorityForIngestKey } from "../lib/ingest-priority";
import { runResource } from "../lib/resource";
import type { TriageResult } from "../lib/triage";
import {
  completeWork,
  ensureWork,
  failWork,
  readWork,
  repairWorkQueuePointers,
  workItemKey,
  type WorkItem,
} from "../lib/work-queue";
import { IngestProbeError, readIngestAnalysis } from "./ingest";
import { ingestsDefinition } from "./ingests";
import { intervalsDefinition } from "./intervals";
import { recordingsDefinition } from "./recordings";
import { readTriageResult } from "./triage";
import { ensureTranscriptWork, transcriptWorkItemKey } from "./transcript-work";

export { priorityForIngestKey } from "../lib/ingest-priority";

export const ingestWorkDefinition = { name: "ingests", version: "1" } as const;

export type IngestWorkResult = {
  chunkKeys: string[];
  intervalIds: string[];
  recordingId?: string;
  transcriptWorkKeys: string[];
};

type Cursor = { after?: string };
const reconciliationCursorKey = "worker-state/work-reconciliation/ingests.json";

async function readCursor(bucket: Bucket, key: string) {
  if (!(await bucket.exists(key))) return undefined;
  return (await bucket.readJson<Cursor>(key).catch(() => null))?.after;
}

async function writeCursor(bucket: Bucket, key: string, after?: string) {
  await bucket.write(key, `${JSON.stringify({ after }, null, 2)}\n`, { type: "application/json; charset=utf-8" });
}

export function ingestWorkItemKey(ingestKey: string) {
  return workItemKey(ingestWorkDefinition.name, ingestKey);
}

export function getIngestWorkLeaseMs() {
  const raw = Number(process.env.INGEST_WORK_LEASE_MS ?? "21600000");
  return Number.isFinite(raw) && raw > 0 ? raw : 21_600_000;
}

export async function ensureIngestWorkFromTriage(options: {
  bucket: Bucket;
  now?: Date;
  priority?: number;
  reopenFailed?: boolean;
  triage: TriageResult;
  visibleAt?: string;
}): Promise<WorkItem | null> {
  if (options.triage.disposition !== "dispatch"
    || (options.triage.content.kind !== "audio" && options.triage.content.kind !== "av-candidate")) return null;

  const now = options.now ?? new Date();
  const ingestKey = options.triage.ingestKey;
  const existing = await readWork(options.bucket, ingestWorkDefinition.name, ingestKey);
  let reopenComplete = false;
  if (existing?.status === "complete" && existing.definition.version === ingestWorkDefinition.version) {
    const freshness = await runResource(ingestsDefinition, { bucket: options.bucket, dryRun: true, inputKey: ingestKey, now });
    if (!freshness.wouldMaterialize) return existing;
    reopenComplete = true;
  }

  return await ensureWork({
    bucket: options.bucket,
    definition: ingestWorkDefinition,
    inputKey: ingestKey,
    now,
    priority: options.priority ?? priorityForIngestKey(ingestKey, options.triage.content.eventTime ?? options.triage.artifact.createdAt),
    reopenComplete,
    reopenFailed: options.reopenFailed,
    visibleAt: options.visibleAt,
  });
}

function getDailyIntervalIdsFromChunkKeys(chunkKeys: string[]) {
  const intervalIds = new Set<string>();
  for (const key of chunkKeys) {
    const chunkId = key.split("/")[1];
    if (chunkId?.length === 13) intervalIds.add(chunkId.slice(0, 9));
  }
  return [...intervalIds];
}

export async function executeIngestWork(options: {
  artifacts?: ArtifactResolver;
  backend: Bucket;
  maxAttempts: number;
  publishEvent(data: Record<string, unknown>): Promise<void>;
  work: WorkItem;
}) {
  const triage = await readTriageResult(options.backend, options.work.inputKey);
  if (triage && (triage.disposition !== "dispatch"
    || (triage.content.kind !== "audio" && triage.content.kind !== "av-candidate"))) {
    await completeWork({
      bucket: options.backend,
      result: { skipped: "triage-no-longer-accepts" },
      work: options.work,
    });
    await options.publishEvent({
      ingestKey: options.work.inputKey,
      type: "ingest.materialization.skipped",
    });
    return true;
  }

  const bucket = options.backend;
  try {
    await options.publishEvent({
      attempt: options.work.attempts,
      ingestKey: options.work.inputKey,
      type: "ingest.materialization.started",
    });
    const ingestResult = await runResource(ingestsDefinition, {
      artifacts: options.artifacts,
      bucket,
      inputKey: options.work.inputKey,
    });
    const analysisKey = ingestResult.plan.state.analysisKey;
    const recordingResult = await runResource(recordingsDefinition, {
      artifacts: options.artifacts,
      bucket,
      inputKey: analysisKey,
      progress: (progress) => options.publishEvent({
        ingestKey: options.work.inputKey,
        ...progress,
        type: "ingest.materialization.progress",
      }),
    });

    let chunkKeys: string[] = [];
    let staleChunkKeys: string[] = [];
    let recordingId: string | undefined;
    if (recordingResult.outputs.length > 0 && recordingResult.plan.state.materializable) {
      recordingId = recordingResult.plan.state.recordingId;
      chunkKeys = recordingResult.plan.state.chunkKeys;
      staleChunkKeys = recordingResult.plan.state.staleChunkKeys;
    } else {
      const analysis = await readIngestAnalysis(bucket, analysisKey);
      if (!analysis?.media.hasAudioStream) {
        console.log(JSON.stringify({ event: "ingest-skip-no-audio", ingestKey: options.work.inputKey, kind: analysis?.media.kind ?? "unknown" }));
      }
    }

    const transcriptWorkKeys: string[] = [];
    for (const chunkKey of chunkKeys) {
      await ensureTranscriptWork({ bucket: options.backend, chunkKey });
      transcriptWorkKeys.push(transcriptWorkItemKey(chunkKey));
    }

    const intervalIds = [...new Set(getDailyIntervalIdsFromChunkKeys([...chunkKeys, ...staleChunkKeys]))].sort();
    for (const intervalId of intervalIds) {
      await runResource(intervalsDefinition, { bucket, inputKey: intervalId });
      await options.publishEvent({ id: intervalId, ingestKey: options.work.inputKey, type: "interval.materialized" });
    }

    const result: IngestWorkResult = { chunkKeys, intervalIds, ...(recordingId ? { recordingId } : {}), transcriptWorkKeys };
    await completeWork({ bucket: options.backend, result, work: options.work });
    await options.publishEvent({ ...result, ingestKey: options.work.inputKey, type: "ingest.materialized" });
    return true;
  } catch (error) {
    await failWork({
      bucket: options.backend,
      error,
      maxAttempts: options.maxAttempts,
      retryable: !(error instanceof IngestProbeError),
      work: options.work,
    });
    await options.publishEvent({
      error: error instanceof Error ? error.message : String(error),
      ingestKey: options.work.inputKey,
      type: "ingest.materialization.failed",
    });
    return true;
  }
}

export async function reconcileIngestWorkQueue(bucket: Bucket, scanLimit = 100) {
  const startAfter = await readCursor(bucket, reconciliationCursorKey);
  const summary = await repairWorkQueuePointers({
    bucket,
    definitionName: ingestWorkDefinition.name,
    scanLimit,
    startAfter,
  });
  await writeCursor(bucket, reconciliationCursorKey, summary.nextAfter);
  return summary;
}
