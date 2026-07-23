import { listAllBucketContents, type Bucket } from "./bucket";
import type { IngestMetadata } from "./ingest";

export type SourceFile = {
  id: string;
  name: string;
  mimeType?: string;
  md5Checksum?: string;
  modifiedTime: string;
  size?: number;
};

export type SourceSyncSummary = {
  queued: number;
  skipped: number;
  errors: number;
  finishedAt: string;
};

export type SourceConfig = {
  id: string;
  type: string;
  enabled: boolean;
  extensions: string[];
  connectedAt?: string;
  [key: string]: unknown;
};

export type SourceStatus = {
  lastSyncAt: string | null;
  lastSyncStartedAt?: string | null;
  lastSyncError?: string | null;
  lastSyncSummary: SourceSyncSummary | null;
};

export type SourceConfigPublic = Omit<SourceConfig, "refreshToken"> & SourceStatus & { refreshToken?: never };

export type SourceSyncState = {
  fileId: string;
  md5Checksum?: string;
  modifiedTime: string;
  ingestKey: string;
  ingestedAt: string;
};

export interface Source {
  readonly config: SourceConfig;
  listFiles(): Promise<SourceFile[]>;
  fetchFile(file: SourceFile): Promise<{ body: ArrayBuffer; contentType: string; filename: string }>;
}

export type SourceFactoryOptions = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

export type SourceDefinition = {
  type: string;
  create(config: SourceConfig, options?: SourceFactoryOptions): Source;
  secretKeys?: string[];
  validate(config: SourceConfig): void;
};

const sourceDefinitions = new Map<string, SourceDefinition>();

export function registerSourceDefinition(def: SourceDefinition) {
  sourceDefinitions.set(def.type, def);
}

export function getSourceDefinition(type: string): SourceDefinition | undefined {
  return sourceDefinitions.get(type);
}

export function knownSourceTypes(): string[] {
  return [...sourceDefinitions.keys()];
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

export function sourceConfigKey(id: string) {
  return `sources/${id}.json`;
}

export function sourceStatusKey(id: string) {
  return `sources/${id}/status.json`;
}

export async function readSourceStatus(bucket: Bucket, id: string): Promise<SourceStatus> {
  const key = sourceStatusKey(id);
  if (!(await bucket.exists(key))) return { lastSyncAt: null, lastSyncSummary: null };
  return await bucket.readJson<SourceStatus>(key);
}

export async function writeSourceStatus(bucket: Bucket, id: string, status: SourceStatus) {
  await bucket.write(sourceStatusKey(id), `${JSON.stringify(status, null, 2)}\n`, {
    type: "application/json; charset=utf-8",
  });
}

export async function toPublicSourceConfig(bucket: Bucket, config: SourceConfig): Promise<SourceConfigPublic> {
  const {
    lastSyncAt: legacyLastSyncAt,
    lastSyncSummary: legacyLastSyncSummary,
    ...stored
  } = config as SourceConfig & { lastSyncAt?: string | null; lastSyncSummary?: SourceSyncSummary | null };
  const rest = { ...stored };
  const secretKeys = new Set(["refreshToken", ...(getSourceDefinition(config.type)?.secretKeys ?? [])]);
  for (const key of secretKeys) delete rest[key];
  const status = await readSourceStatus(bucket, config.id);
  return {
    ...rest,
    lastSyncAt: status.lastSyncAt ?? legacyLastSyncAt ?? null,
    lastSyncStartedAt: status.lastSyncStartedAt ?? null,
    lastSyncError: status.lastSyncError ?? null,
    lastSyncSummary: status.lastSyncSummary ?? legacyLastSyncSummary ?? null,
  } as SourceConfigPublic;
}

export async function listSourceConfigs(bucket: Bucket): Promise<SourceConfig[]> {
  const listed = await listAllBucketContents(bucket, { prefix: "sources/" });
  const configs: SourceConfig[] = [];
  for (const obj of listed) {
    if (!obj.key.endsWith(".json")) continue;
    if (obj.key.startsWith("sources/") && obj.key.slice("sources/".length).includes("/")) continue;
    try {
      configs.push(await bucket.readJson<SourceConfig>(obj.key));
    } catch {
      continue;
    }
  }
  return configs;
}

export async function readSourceConfig(bucket: Bucket, id: string): Promise<SourceConfig | null> {
  const key = sourceConfigKey(id);
  if (!(await bucket.exists(key))) return null;
  return await bucket.readJson<SourceConfig>(key);
}

export async function writeSourceConfig(bucket: Bucket, config: SourceConfig) {
  await bucket.write(sourceConfigKey(config.id), `${JSON.stringify(config, null, 2)}\n`, {
    type: "application/json; charset=utf-8",
  });
}

export async function deleteSourceConfig(bucket: Bucket, id: string) {
  await bucket.delete(sourceConfigKey(id));
  const states = await listAllBucketContents(bucket, { prefix: `sources/${id}/` });
  for (const obj of states) {
    await bucket.delete(obj.key);
  }
}

export async function createSource(bucket: Bucket, config: SourceConfig): Promise<SourceConfig> {
  const definition = getSourceDefinition(config.type);
  if (definition) definition.validate(config);
  await writeSourceConfig(bucket, config);
  return config;
}

export async function updateSourceConfig(
  bucket: Bucket,
  id: string,
  patch: Partial<Pick<SourceConfig, "extensions" | "enabled"> & Record<string, unknown>>,
): Promise<SourceConfig> {
  const existing = await readSourceConfig(bucket, id);
  if (!existing) throw new Error(`No source with id ${id}.`);
  const next: SourceConfig = { ...existing, ...patch, id: existing.id, type: existing.type };
  await writeSourceConfig(bucket, next);
  return next;
}

export function fileMatchesExtensions(name: string, extensions: string[]) {
  if (extensions.length === 0) return true;
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

export function isStale(file: SourceFile, state: SourceSyncState | null): boolean {
  if (!state) return true;
  if (state.md5Checksum && file.md5Checksum && state.md5Checksum !== file.md5Checksum) return true;
  return state.modifiedTime !== file.modifiedTime;
}

async function hashText(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data.buffer));
  return [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashFileId(fileId: string): Promise<string> {
  return await hashText(fileId);
}

export async function sourceIngestKey(sourceId: string, file: SourceFile): Promise<string> {
  const version = file.md5Checksum ?? file.modifiedTime;
  return `in/source-${await hashText(`${sourceId}\n${file.id}\n${version}`)}`;
}

function syncStateKey(sourceId: string, fileIdHash: string) {
  return `sources/${sourceId}/sync/${fileIdHash}.json`;
}

export async function readSyncState(bucket: Bucket, sourceId: string, fileId: string): Promise<SourceSyncState | null> {
  const key = syncStateKey(sourceId, await hashFileId(fileId));
  if (!(await bucket.exists(key))) return null;
  return await bucket.readJson<SourceSyncState>(key);
}

export async function writeSyncState(bucket: Bucket, sourceId: string, state: SourceSyncState) {
  const key = syncStateKey(sourceId, await hashFileId(state.fileId));
  await bucket.write(key, `${JSON.stringify(state, null, 2)}\n`, { type: "application/json; charset=utf-8" });
}

export async function listSyncStates(bucket: Bucket, sourceId: string): Promise<Map<string, SourceSyncState>> {
  const objects = await listAllBucketContents(bucket, { prefix: `sources/${sourceId}/sync/` });
  const states = await Promise.all(objects
    .filter((object) => object.key.endsWith(".json"))
    .map((object) => bucket.readJson<SourceSyncState>(object.key).catch(() => null)));
  return new Map(states.filter((state): state is SourceSyncState => state !== null).map((state) => [state.fileId, state]));
}

export function sourceProvenance(config: SourceConfig, file: SourceFile): IngestMetadata {
  return {
    source: config.type,
    "source-id": config.id,
    "source-file-id": file.id,
  };
}

const legacyGdriveConnectionKey = "connections/google-drive.json";
const legacyGdrivePendingKey = "connections/google-drive-pending.json";
const legacyGdriveSyncPrefix = "gdrive-sync/";

export async function migrateLegacyGdriveConnection(bucket: Bucket): Promise<SourceConfig | null> {
  if (!(await bucket.exists(legacyGdriveConnectionKey))) return null;
  const old = await bucket.readJson<{
    refreshToken: string;
    scope: string;
    account: string | null;
    folderId: string;
    extensions: string[];
    connectedAt: string;
    lastSyncAt: string | null;
    lastSyncSummary: SourceSyncSummary | null;
  }>(legacyGdriveConnectionKey);

  const id = `legacy-google-drive-${await hashFileId(old.folderId)}`;
  const config: SourceConfig = {
    id,
    type: "google-drive",
    enabled: true,
    extensions: old.extensions,
    refreshToken: old.refreshToken,
    scope: old.scope,
    account: old.account,
    folderId: old.folderId,
    connectedAt: old.connectedAt,
  };
  await writeSourceConfig(bucket, config);

  const states = await listAllBucketContents(bucket, { prefix: legacyGdriveSyncPrefix });
  for (const obj of states) {
    if (!obj.key.endsWith(".json")) continue;
    const state = await bucket.readJson<SourceSyncState>(obj.key);
    await writeSyncState(bucket, id, state);
  }
  await writeSourceStatus(bucket, id, {
    lastSyncAt: old.lastSyncAt,
    lastSyncSummary: old.lastSyncSummary,
  });
  for (const obj of states) {
    await bucket.delete(obj.key);
  }
  await bucket.delete(legacyGdriveConnectionKey);
  await bucket.delete(legacyGdrivePendingKey);

  return config;
}

export async function ensureSourcesMigrated(bucket: Bucket): Promise<void> {
  await migrateLegacyGdriveConnection(bucket);
}
