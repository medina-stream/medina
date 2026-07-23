import type { ArtifactResolver } from "../lib/artifact";
import type { Bucket } from "../lib/bucket";
import { createIngestService, createPresignIngestUpload, getIngestMetadataHeaders, type IngestMetadata } from "../lib/ingest";
import {
  hashFileId,
  isStale,
  readSourceConfig,
  readSyncState,
  sourceIngestKey,
  sourceProvenance,
  writeSyncState,
  type SourceConfig,
  type SourceFactoryOptions,
  type SourceFile,
} from "../lib/source";
import {
  completeWork,
  ensureWork,
  failWork,
  repairWorkQueuePointers,
  type WorkItem,
} from "../lib/work-queue";
import { instantiateSource } from "./source";
import { ensureTriageWork } from "./triage-work";

export const sourceFetchWorkDefinition = { name: "source-fetch", version: "1" } as const;

const reconciliationCursorKey = "worker-state/work-reconciliation/source-fetch.json";
const jsonType = "application/json; charset=utf-8";

type Cursor = { after?: string };

export type SourceFetchSpec = {
  sourceId: string;
  file: SourceFile;
};

export function sourceFetchSpecKey(sourceId: string, fileIdHash: string) {
  return `sources/${sourceId}/fetch/${fileIdHash}.json`;
}

export async function ensureSourceFetchWork(input: {
  bucket: Bucket;
  config: SourceConfig;
  file: SourceFile;
  now?: Date;
}): Promise<WorkItem> {
  const specKey = sourceFetchSpecKey(input.config.id, await hashFileId(input.file.id));
  const spec: SourceFetchSpec = { sourceId: input.config.id, file: input.file };
  await input.bucket.write(specKey, `${JSON.stringify(spec, null, 2)}\n`, { type: jsonType });
  const modifiedMs = new Date(input.file.modifiedTime).getTime();
  return await ensureWork({
    bucket: input.bucket,
    definition: sourceFetchWorkDefinition,
    inputKey: specKey,
    now: input.now,
    priority: Number.isFinite(modifiedMs) ? -modifiedMs : 0,
    reopenComplete: true,
    reopenFailed: true,
  });
}

export async function executeSourceFetchWork(options: {
  artifacts?: ArtifactResolver;
  backend: Bucket;
  factoryOptions?: SourceFactoryOptions;
  maxAttempts: number;
  publishEvent(data: Record<string, unknown>): Promise<void>;
  work: WorkItem;
}) {
  const { backend, work } = options;
  try {
    if (!(await backend.exists(work.inputKey))) {
      await completeWork({ bucket: backend, result: { skipped: "missing-spec" }, work });
      return true;
    }
    const spec = await backend.readJson<SourceFetchSpec>(work.inputKey);
    const config = await readSourceConfig(backend, spec.sourceId);
    if (!config || config.enabled === false) {
      await backend.delete(work.inputKey);
      await completeWork({ bucket: backend, result: { skipped: "source-missing-or-disabled" }, work });
      return true;
    }
    const state = await readSyncState(backend, spec.sourceId, spec.file.id);
    if (!isStale(spec.file, state)) {
      await backend.delete(work.inputKey);
      await completeWork({ bucket: backend, result: { skipped: "fresh" }, work });
      return true;
    }

    const source = instantiateSource(config, options.factoryOptions);
    const { body, contentType, filename } = await source.fetchFile(spec.file);
    const provenance = sourceProvenance(config, spec.file);
    const metadata: IngestMetadata = {
      "sdk-version": `medina-source/${config.type}`,
      "original-filename": filename,
      "created-at": spec.file.modifiedTime,
      ...provenance,
    };
    const headers = new Headers({
      "content-type": contentType,
      "x-medina-ingest-key": await sourceIngestKey(config.id, spec.file),
      ...getIngestMetadataHeaders(metadata),
    });
    const ingestService = createIngestService({
      artifacts: options.artifacts,
      bucket: backend,
      presignIngestUpload: createPresignIngestUpload(null),
    });
    const stored = await ingestService.storeIncomingIngest(
      new Request("https://medina.local/in", { method: "POST", headers, body }),
    );
    await ensureTriageWork({
      bucket: backend,
      ingestKey: stored.key,
      priorityAt: spec.file.modifiedTime,
    });
    await writeSyncState(backend, spec.sourceId, {
      fileId: spec.file.id,
      md5Checksum: spec.file.md5Checksum,
      modifiedTime: spec.file.modifiedTime,
      ingestKey: stored.key,
      ingestedAt: new Date().toISOString(),
    });
    await backend.delete(work.inputKey);
    await completeWork({ bucket: backend, result: { ingestKey: stored.key }, work });
    await options.publishEvent({
      fileName: spec.file.name,
      ingestKey: stored.key,
      sourceId: spec.sourceId,
      type: "source.fetch.completed",
    });
    return true;
  } catch (error) {
    await failWork({
      bucket: backend,
      error,
      maxAttempts: options.maxAttempts,
      retryable: true,
      work,
    });
    await options.publishEvent({
      error: error instanceof Error ? error.message : String(error),
      specKey: work.inputKey,
      type: "source.fetch.failed",
    });
    return true;
  }
}

export async function reconcileSourceFetchQueue(bucket: Bucket, scanLimit = 100) {
  const startAfter = (await bucket.exists(reconciliationCursorKey))
    ? (await bucket.readJson<Cursor>(reconciliationCursorKey).catch(() => null))?.after
    : undefined;
  const summary = await repairWorkQueuePointers({
    bucket,
    definitionName: sourceFetchWorkDefinition.name,
    scanLimit,
    startAfter,
  });
  await bucket.write(reconciliationCursorKey, `${JSON.stringify({ after: summary.nextAfter }, null, 2)}\n`, { type: jsonType });
  return summary;
}
