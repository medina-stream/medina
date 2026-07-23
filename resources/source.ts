import type { Bucket } from "../lib/bucket";
import { ensureSourceFetchWork } from "./source-fetch";
import {
  fileMatchesExtensions,
  isStale,
  listSourceConfigs,
  listSyncStates,
  readSourceConfig,
  readSourceStatus,
  writeSourceStatus,
  type Source,
  type SourceConfig,
  type SourceFactoryOptions,
  type SourceFile,
  type SourceSyncState,
  type SourceSyncSummary,
  getSourceDefinition,
} from "../lib/source";

export type SourceSyncResult = {
  sourceId: string;
  type: string;
  synced: boolean;
  summary: SourceSyncSummary | null;
};

export function instantiateSource(config: SourceConfig, options?: SourceFactoryOptions): Source {
  const def = getSourceDefinition(config.type);
  if (!def) throw new Error(`Unknown source type: ${config.type}`);
  def.validate(config);
  return def.create(config, options);
}

export async function syncSource(input: {
  bucket: Bucket;
  config: SourceConfig;
  options?: SourceFactoryOptions;
}): Promise<SourceSyncResult> {
  if (input.config.enabled === false) {
    return { sourceId: input.config.id, type: input.config.type, synced: false, summary: null };
  }
  const startedAt = new Date().toISOString();
  const previousStatus = await readSourceStatus(input.bucket, input.config.id);
  await writeSourceStatus(input.bucket, input.config.id, { ...previousStatus, lastSyncStartedAt: startedAt, lastSyncError: null });

  const source = instantiateSource(input.config, input.options);
  let files: SourceFile[];
  let syncStates: Map<string, SourceSyncState>;
  try {
    [files, syncStates] = await Promise.all([
      source.listFiles(),
      listSyncStates(input.bucket, input.config.id),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeSourceStatus(input.bucket, input.config.id, { ...previousStatus, lastSyncStartedAt: startedAt, lastSyncError: message });
    throw error;
  }

  let queued = 0;
  let skipped = 0;
  let errors = 0;

  const stale: SourceFile[] = [];
  for (const file of files) {
    if (!fileMatchesExtensions(file.name, input.config.extensions)) {
      skipped += 1;
      continue;
    }
    if (!isStale(file, syncStates.get(file.id) ?? null)) {
      skipped += 1;
      continue;
    }
    stale.push(file);
  }

  const enqueueConcurrency = 16;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(enqueueConcurrency, stale.length) }, async () => {
    while (cursor < stale.length) {
      const file = stale[cursor]!;
      cursor += 1;
      try {
        await ensureSourceFetchWork({ bucket: input.bucket, config: input.config, file });
        queued += 1;
      } catch (error) {
        errors += 1;
        console.error(JSON.stringify({
          event: "source-sync-file-error",
          sourceId: input.config.id,
          fileId: file.id,
          name: file.name,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }));

  const finishedAt = new Date().toISOString();
  const summary: SourceSyncSummary = { queued, skipped, errors, finishedAt };
  if (await readSourceConfig(input.bucket, input.config.id)) {
    await writeSourceStatus(input.bucket, input.config.id, {
      lastSyncAt: finishedAt,
      lastSyncStartedAt: startedAt,
      lastSyncError: null,
      lastSyncSummary: summary,
    });
  }
  return { sourceId: input.config.id, type: input.config.type, synced: true, summary };
}

export async function syncAllSources(input: {
  bucket: Bucket;
  options?: SourceFactoryOptions;
}): Promise<SourceSyncResult[]> {
  const configs = await listSourceConfigs(input.bucket);
  const results: SourceSyncResult[] = [];
  for (const config of configs) {
    if (config.enabled === false) continue;
    try {
      results.push(await syncSource({ bucket: input.bucket, config, options: input.options }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "source-sync-error",
        sourceId: config.id,
        type: config.type,
        error: error instanceof Error ? error.message : String(error),
      }));
      results.push({ sourceId: config.id, type: config.type, synced: false, summary: null });
    }
  }
  return results;
}

export async function syncOneSourceById(input: {
  bucket: Bucket;
  id: string;
  options?: SourceFactoryOptions;
}): Promise<SourceSyncResult> {
  const config = await readSourceConfig(input.bucket, input.id);
  if (!config) throw new Error(`No source with id ${input.id}.`);
  return syncSource({ bucket: input.bucket, config, options: input.options });
}

export type { SourceFile };
