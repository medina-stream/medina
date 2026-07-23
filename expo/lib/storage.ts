import { File } from "expo-file-system";
import { Platform } from "react-native";
import { getRecordingsDir, QUEUE_FILE_NAME } from "./constants";

const UPLOAD_HISTORY_FILE_NAME = "upload-history.json";
const MAX_UPLOAD_HISTORY = 50;

export type UploadStatus = "pending" | "uploading" | "uploaded" | "failed";

export type QueueEntry = {
  uri: string;
  filename: string;
  startsAt?: string;
  status: UploadStatus;
  sizeBytes: number;
  uploadedBytes: number;
  createdAt?: string;
  completedAt?: string;
  ingestId?: string;
  ingestKey?: string;
  lastError?: string;
};

export type UploadHistoryEntry = {
  completedAt: string;
  filename: string;
  ingestId?: string;
  ingestKey?: string;
  sizeBytes: number;
  startsAt?: string;
};

type QueueListener = (queue: QueueEntry[]) => void;
type UploadHistoryListener = (history: UploadHistoryEntry[]) => void;

const listeners = new Set<QueueListener>();
const uploadHistoryListeners = new Set<UploadHistoryListener>();
let memQueue: QueueEntry[] = [];
let memUploadHistory: UploadHistoryEntry[] = [];

export function ensureDir(): void {
  const dir = getRecordingsDir();
  if (!dir.exists) dir.create();
}

function getQueueFile(): File {
  return new File(getRecordingsDir(), QUEUE_FILE_NAME);
}

function getUploadHistoryFile(): File {
  return new File(getRecordingsDir(), UPLOAD_HISTORY_FILE_NAME);
}

function getFileSize(uri: string): number {
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

function normalizeUploadStatus(status: unknown): UploadStatus {
  return status === "uploading" || status === "uploaded" || status === "failed"
    ? status
    : "pending";
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeEntry(entry: Partial<QueueEntry> & Pick<QueueEntry, "uri" | "filename">): QueueEntry {
  const sizeBytes =
    typeof entry.sizeBytes === "number" && entry.sizeBytes >= 0
      ? entry.sizeBytes
      : getFileSize(entry.uri);
  const uploadedBytes =
    typeof entry.uploadedBytes === "number" && entry.uploadedBytes >= 0
      ? Math.min(entry.uploadedBytes, sizeBytes)
      : 0;
  const status = normalizeUploadStatus(entry.status);

  return {
    uri: entry.uri,
    filename: entry.filename,
    startsAt: normalizeOptionalString(entry.startsAt),
    status,
    sizeBytes,
    uploadedBytes: status === "uploaded" ? sizeBytes : uploadedBytes,
    createdAt: normalizeOptionalString(entry.createdAt),
    completedAt: normalizeOptionalString(entry.completedAt),
    ingestId: normalizeOptionalString(entry.ingestId),
    ingestKey: normalizeOptionalString(entry.ingestKey),
    lastError: normalizeOptionalString(entry.lastError),
  };
}

function normalizeUploadHistoryEntry(entry: Partial<UploadHistoryEntry> & Pick<UploadHistoryEntry, "filename">): UploadHistoryEntry {
  return {
    completedAt:
      typeof entry.completedAt === "string" && entry.completedAt.trim().length > 0
        ? entry.completedAt
        : new Date().toISOString(),
    filename: entry.filename,
    ingestId: typeof entry.ingestId === "string" ? entry.ingestId : undefined,
    ingestKey: typeof entry.ingestKey === "string" ? entry.ingestKey : undefined,
    sizeBytes: typeof entry.sizeBytes === "number" && entry.sizeBytes >= 0 ? entry.sizeBytes : 0,
    startsAt: normalizeOptionalString(entry.startsAt),
  };
}

function emitQueue(queue: QueueEntry[]): void {
  for (const listener of listeners) {
    listener(queue);
  }
}

function emitUploadHistory(history: UploadHistoryEntry[]): void {
  for (const listener of uploadHistoryListeners) {
    listener(history);
  }
}

export function loadQueue(): QueueEntry[] {
  if (Platform.OS === "web") return [...memQueue];
  try {
    const file = getQueueFile();
    if (!file.exists) return [];
    const raw = file.textSync();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => normalizeEntry(entry));
  } catch {
    return [];
  }
}

export function loadUploadHistory(): UploadHistoryEntry[] {
  if (Platform.OS === "web") return [...memUploadHistory];
  try {
    const file = getUploadHistoryFile();
    if (!file.exists) return [];
    const raw = file.textSync();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Partial<UploadHistoryEntry> & Pick<UploadHistoryEntry, "filename"> =>
        typeof entry?.filename === "string" && entry.filename.trim().length > 0,
      )
      .map((entry) => normalizeUploadHistoryEntry(entry));
  } catch {
    return [];
  }
}

export function saveUploadHistory(history: UploadHistoryEntry[]): void {
  const normalizedHistory = history
    .map((entry) => normalizeUploadHistoryEntry(entry))
    .slice(0, MAX_UPLOAD_HISTORY);
  if (Platform.OS === "web") {
    memUploadHistory = normalizedHistory;
    emitUploadHistory(memUploadHistory);
    return;
  }
  ensureDir();
  const file = getUploadHistoryFile();
  if (!file.exists) file.create();
  file.write(JSON.stringify(normalizedHistory));
  emitUploadHistory(normalizedHistory);
}

export function addUploadHistory(entry: UploadHistoryEntry): void {
  saveUploadHistory([entry, ...loadUploadHistory()].slice(0, MAX_UPLOAD_HISTORY));
}

export function subscribeUploadHistory(listener: UploadHistoryListener): () => void {
  uploadHistoryListeners.add(listener);
  listener(loadUploadHistory());
  return () => {
    uploadHistoryListeners.delete(listener);
  };
}

export function saveQueue(queue: QueueEntry[]): void {
  if (Platform.OS === "web") {
    memQueue = queue.map((entry) => normalizeEntry(entry));
    emitQueue(memQueue);
    return;
  }
  ensureDir();
  const file = getQueueFile();
  if (!file.exists) file.create();
  const normalizedQueue = queue.map((entry) => normalizeEntry(entry));
  file.write(JSON.stringify(normalizedQueue));
  emitQueue(normalizedQueue);
}

export function addToQueue(entry: QueueEntry): void {
  const queue = loadQueue();
  const normalizedEntry = normalizeEntry({
    ...entry,
    createdAt: entry.createdAt ?? new Date().toISOString(),
  });
  const existingIndex = queue.findIndex((item) => item.uri === normalizedEntry.uri);
  if (existingIndex >= 0) {
    queue[existingIndex] = normalizedEntry;
  } else {
    queue.push(normalizedEntry);
  }
  saveQueue(queue);
}

export function removeFromQueue(uri: string): void {
  const queue = loadQueue();
  saveQueue(queue.filter((e) => e.uri !== uri));
}

export function updateEntryStatus(
  uri: string,
  status: QueueEntry["status"],
  options: { error?: string; ingestId?: string; ingestKey?: string } = {},
): void {
  const queue = loadQueue();
  const entry = queue.find((e) => e.uri === uri);
  if (entry) {
    entry.status = status;
    if (status === "pending" || status === "failed") {
      entry.uploadedBytes = 0;
    }
    if (status === "uploaded") {
      entry.uploadedBytes = entry.sizeBytes;
      entry.completedAt = new Date().toISOString();
    }
    if (options.error !== undefined) {
      entry.lastError = options.error;
    } else if (status !== "failed") {
      entry.lastError = undefined;
    }
    if (options.ingestId !== undefined) entry.ingestId = options.ingestId;
    if (options.ingestKey !== undefined) entry.ingestKey = options.ingestKey;
    saveQueue(queue);
  }
}

export function updateEntryProgress(
  uri: string,
  uploadedBytes: number,
  sizeBytes?: number
): void {
  const queue = loadQueue();
  const entry = queue.find((e) => e.uri === uri);
  if (!entry) return;

  if (typeof sizeBytes === "number" && sizeBytes >= 0) {
    entry.sizeBytes = sizeBytes;
  }
  entry.uploadedBytes = Math.max(
    0,
    Math.min(uploadedBytes, entry.sizeBytes || sizeBytes || uploadedBytes)
  );
  saveQueue(queue);
}

export function resetStaleUploads(): void {
  const queue = loadQueue();
  let changed = false;

  for (const entry of queue) {
    if (entry.status === "uploading") {
      entry.status = "pending";
      entry.uploadedBytes = 0;
      changed = true;
    }
  }

  if (changed) {
    saveQueue(queue);
  }
}

export function subscribeQueue(listener: QueueListener): () => void {
  listeners.add(listener);
  listener(loadQueue());
  return () => {
    listeners.delete(listener);
  };
}
