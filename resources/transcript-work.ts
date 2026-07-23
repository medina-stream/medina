import type { ArtifactResolver } from "../lib/artifact";
import { normalizeBucketKey, type Bucket } from "../lib/bucket";
import { getMaterializationReceiptKey, runResource } from "../lib/resource";
import {
  completeWork,
  ensureWork,
  failWork,
  readWork,
  repairWorkQueuePointers,
  workItemKey,
  type WorkItem,
} from "../lib/work-queue";
import { parseChunkId } from "./chunk";
import type { RecordingManifest } from "./recording";
import { analyzeChunkSpeech, getSpeechAnalysisKey, type SpeechAnalysis } from "./speech-analysis";
import {
  dayIdFromTranscript,
  getTranscriptMaxAgeDays,
  isDayTranscriptId,
  materializeDayTranscripts,
  parseChunkKey,
  resolveChunkTimeZone,
  transcriptChunksDefinition,
} from "./transcripts";

export const transcriptWorkDefinition = { name: "transcript-chunks", version: `${transcriptChunksDefinition.version}:policy-1` } as const;

const discoveryCursorKey = "worker-state/transcript-discovery.json";
const reconciliationCursorKey = "worker-state/work-reconciliation/transcript-chunks.json";
const jsonType = "application/json; charset=utf-8";

type Cursor = { after?: string };

async function readCursor(bucket: Bucket, key: string) {
  if (!(await bucket.exists(key))) return undefined;
  return (await bucket.readJson<Cursor>(key).catch(() => null))?.after;
}

async function writeCursor(bucket: Bucket, key: string, after?: string) {
  await bucket.write(key, `${JSON.stringify({ after }, null, 2)}\n`, { type: jsonType });
}

export function isChunkTooOldToTranscribe(chunkKey: string, now: Date) {
  const maxAgeDays = getTranscriptMaxAgeDays();
  if (maxAgeDays <= 0) return false;
  const { chunkId } = parseChunkKey(chunkKey);
  const { endTime } = parseChunkId(chunkId);
  return now.getTime() - endTime.getTime() > maxAgeDays * 24 * 60 * 60 * 1000;
}

async function readChunkSpeechAnalysis(bucket: Bucket, chunkKey: string) {
  const analysisKey = getSpeechAnalysisKey(chunkKey);
  if (await bucket.exists(analysisKey)) {
    const existing = await bucket.readJson<SpeechAnalysis>(analysisKey).catch(() => null);
    if (existing?.transcriptPolicy) return existing;
  }
  return await analyzeChunkSpeech(chunkKey, { bucket });
}

function priorityForChunk(chunkKey: string) {
  const { chunkId } = parseChunkKey(chunkKey);
  return -parseChunkId(chunkId).startTime.getTime();
}

export function transcriptWorkItemKey(chunkKey: string) {
  return workItemKey(transcriptWorkDefinition.name, normalizeBucketKey(chunkKey));
}

export async function ensureTranscriptWork(options: {
  bucket: Bucket;
  chunkKey: string;
  now?: Date;
  reopenFailed?: boolean;
}) {
  const now = options.now ?? new Date();
  const chunkKey = normalizeBucketKey(options.chunkKey);
  parseChunkKey(chunkKey);
  const existing = await readWork(options.bucket, transcriptWorkDefinition.name, chunkKey);
  let reopenComplete = false;
  if (existing?.status === "complete" && existing.definition.version === transcriptWorkDefinition.version) {
    if (existing.result && "skipped" in existing.result) return existing;
    const freshness = await runResource(transcriptChunksDefinition, {
      bucket: options.bucket,
      dryRun: true,
      inputKey: chunkKey,
      now,
    });
    if (!freshness.wouldMaterialize) return existing;
    reopenComplete = true;
  }

  return await ensureWork({
    bucket: options.bucket,
    definition: transcriptWorkDefinition,
    inputKey: chunkKey,
    now,
    priority: priorityForChunk(chunkKey),
    reopenComplete,
    reopenFailed: options.reopenFailed,
  });
}

export async function executeTranscriptWork(options: {
  artifacts?: ArtifactResolver;
  backend: Bucket;
  maxAttempts: number;
  now?: Date;
  publishEvent(data: Record<string, unknown>): Promise<void>;
  work: WorkItem;
}) {
  const now = options.now ?? new Date();
  try {
    if (!(await options.backend.exists(options.work.inputKey))) {
      await completeWork({
        bucket: options.backend,
        result: { skipped: "chunk-no-longer-exists" },
        work: options.work,
      });
      return true;
    }
    if (isChunkTooOldToTranscribe(options.work.inputKey, now)) {
      await completeWork({
        bucket: options.backend,
        result: { skipped: "chunk-too-old" },
        work: options.work,
      });
      return true;
    }
    const speech = await readChunkSpeechAnalysis(options.backend, options.work.inputKey);
    if (!speech.transcriptPolicy.shouldTranscribe) {
      await completeWork({
        bucket: options.backend,
        result: {
          skipped: "no-speech",
          speechLikelihood: speech.speechLikelihood,
          speechSeconds: speech.speechSeconds,
        },
        work: options.work,
      });
      await options.publishEvent({
        chunkKey: options.work.inputKey,
        speechSeconds: speech.speechSeconds,
        type: "transcript.skipped.no-speech",
      });
      return true;
    }
    const result = await runResource(transcriptChunksDefinition, {
      artifacts: options.artifacts,
      bucket: options.backend,
      inputKey: options.work.inputKey,
    });
    if (!(await options.backend.exists(options.work.inputKey))) {
      for (const output of result.outputs) {
        await options.backend.delete(output);
        await options.backend.delete(getMaterializationReceiptKey(output));
      }
      await completeWork({
        bucket: options.backend,
        result: { skipped: "chunk-removed-during-transcription" },
        work: options.work,
      });
      return true;
    }
    await completeWork({
      bucket: options.backend,
      result: { outputs: result.outputs },
      work: options.work,
    });
    const { chunkId } = parseChunkKey(options.work.inputKey);
    const utcDayId = chunkId.slice(0, 9);
    const transcript = await options.backend.readJson<{
      startTime: string;
      timeZone?: string;
    }>(result.outputs[0]!);
    const resolved = await resolveChunkTimeZone(options.backend, transcript.startTime);
    const localDayId = dayIdFromTranscript({ startTime: transcript.startTime, timeZone: resolved.timeZone });
    const affectedDayIds = new Set<string>();
    if (localDayId && isDayTranscriptId(localDayId)) {
      await materializeDayTranscripts(localDayId, { bucket: options.backend });
      affectedDayIds.add(localDayId);
    }
    if (isDayTranscriptId(utcDayId) && utcDayId !== localDayId) {
      await materializeDayTranscripts(utcDayId, { bucket: options.backend });
      affectedDayIds.add(utcDayId);
    }
    await options.publishEvent({
      dayIds: [...affectedDayIds],
      chunkKey: options.work.inputKey,
      transcriptKey: result.outputs[0],
      type: "transcript.materialized",
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
      chunkKey: options.work.inputKey,
      error: error instanceof Error ? error.message : String(error),
      type: "transcript.materialization.failed",
    });
    return true;
  }
}

export async function reconcileTranscriptWork(options: {
  bucket: Bucket;
  limit?: number;
  now?: Date;
  scanLimit?: number;
}) {
  const limit = options.limit ?? 100;
  const startAfter = await readCursor(options.bucket, discoveryCursorKey);
  const page = await options.bucket.list({
    prefix: "recordings/",
    startAfter,
    maxKeys: options.scanLimit ?? 500,
  });
  const objects = page.contents ?? [];
  const summary = { created: 0, scanned: 0, skipped: 0 };
  let lastScanned = startAfter;
  const now = options.now ?? new Date();

  manifestLoop: for (const object of objects) {
    if (summary.created >= limit) break;
    summary.scanned += 1;
    if (!object.key.endsWith("/manifest.json")) {
      summary.skipped += 1;
      lastScanned = object.key;
      continue;
    }
    const manifest = await options.bucket.readJson<RecordingManifest>(object.key).catch(() => null);
    if (!manifest) {
      summary.skipped += 1;
      lastScanned = object.key;
      continue;
    }
    const chunkKeys = Object.values(manifest.chunkFormats).flatMap((playlist) => playlist.chunks.map((chunk) => chunk.key));
    for (const chunkKey of chunkKeys) {
      if (summary.created >= limit) break manifestLoop;
      if (!/^chunks\/\d{13}\/[^/]+\.ogg$/.test(chunkKey)) {
        summary.skipped += 1;
        continue;
      }
      if (isChunkTooOldToTranscribe(chunkKey, now)) {
        summary.skipped += 1;
        continue;
      }
      if (!(await options.bucket.exists(chunkKey))) {
        summary.skipped += 1;
        continue;
      }
      const before = await readWork(options.bucket, transcriptWorkDefinition.name, chunkKey);
      const work = await ensureTranscriptWork({ bucket: options.bucket, chunkKey, now: options.now });
      if (!before || (before.definition.version !== work.definition.version && work.status === "pending")) summary.created += 1;
      else summary.skipped += 1;
    }
    lastScanned = object.key;
  }

  const exhausted = summary.scanned === objects.length;
  await writeCursor(options.bucket, discoveryCursorKey, exhausted && !page.isTruncated ? undefined : lastScanned);
  return summary;
}

export async function reconcileTranscriptQueue(bucket: Bucket, scanLimit = 100) {
  const summary = await repairWorkQueuePointers({
    bucket,
    definitionName: transcriptWorkDefinition.name,
    scanLimit,
    startAfter: await readCursor(bucket, reconciliationCursorKey),
  });
  await writeCursor(bucket, reconciliationCursorKey, summary.nextAfter);
  return summary;
}
