import { listAllBucketKeys, type Bucket } from "../lib/bucket";
import { Resource } from "../lib/resource";
import type { ResourceCheckIssue } from "./ingest";
import {
  createRecordingFromManifest,
  getRecordingDurationSeconds,
  getRecordingPrefix,
  type Recording,
  type RecordingManifest,
} from "./recording";

export const intervalsResource = new Resource<Interval>({
  kind: "intervals",
});

export type IntervalLength = "P1D" | "P1M" | "P1Y";

export type Interval = {
  coverageSeconds: number;
  durationSeconds: number;
  endTime: string;
  id: string;
  key: string;
  length: IntervalLength;
  recordings: Recording[];
  startTime: string;
};

export type ParsedIntervalId = {
  endTime: Date;
  id: string;
  key: string;
  length: IntervalLength;
  startTime: Date;
};

function padDatePart(value: number, length: number) {
  return String(value).padStart(length, "0");
}

function assertValidDate(value: Date, label: string) {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid ${label}`);
  }
}

export function getIntervalBucketKey(intervalId: string) {
  return `intervals/${intervalId}.json`;
}

export function getDailyIntervalId(value: Date) {
  assertValidDate(value, "interval date");
  return [
    padDatePart(value.getUTCFullYear(), 5),
    padDatePart(value.getUTCMonth() + 1, 2),
    padDatePart(value.getUTCDate(), 2),
  ].join("");
}

export function getMonthlyIntervalId(value: Date) {
  assertValidDate(value, "interval date");
  return [
    padDatePart(value.getUTCFullYear(), 5),
    padDatePart(value.getUTCMonth() + 1, 2),
  ].join("");
}

export function getYearlyIntervalId(value: Date) {
  assertValidDate(value, "interval date");
  return padDatePart(value.getUTCFullYear(), 5);
}

export function normalizeIntervalIdInput(value: string) {
  return value
    .replace(/^intervals\//, "")
    .replace(/\.json$/, "")
    .trim();
}

export function parseIntervalId(value: string): ParsedIntervalId {
  const id = normalizeIntervalIdInput(value);

  if (/^\d{9}$/.test(id)) {
    const year = Number(id.slice(0, 5));
    const month = Number(id.slice(5, 7));
    const day = Number(id.slice(7, 9));
    const startTime = new Date(Date.UTC(year, month - 1, day));
    const endTime = new Date(Date.UTC(year, month - 1, day + 1));
    return {
      endTime,
      id,
      key: getIntervalBucketKey(id),
      length: "P1D",
      startTime,
    };
  }

  if (/^\d{7}$/.test(id)) {
    const year = Number(id.slice(0, 5));
    const month = Number(id.slice(5, 7));
    const startTime = new Date(Date.UTC(year, month - 1, 1));
    const endTime = new Date(Date.UTC(year, month, 1));
    return {
      endTime,
      id,
      key: getIntervalBucketKey(id),
      length: "P1M",
      startTime,
    };
  }

  if (/^\d{5}$/.test(id)) {
    const year = Number(id);
    const startTime = new Date(Date.UTC(year, 0, 1));
    const endTime = new Date(Date.UTC(year + 1, 0, 1));
    return {
      endTime,
      id,
      key: getIntervalBucketKey(id),
      length: "P1Y",
      startTime,
    };
  }

  throw new Error(`Invalid interval id: ${value}`);
}

function getDurationSeconds(startTime: Date, endTime: Date) {
  return Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 1000));
}

function getRecordingEndTime(recording: Recording) {
  if (!recording.startTime || recording.durationSeconds === null) {
    return null;
  }

  const startMs = new Date(recording.startTime).getTime();
  if (Number.isNaN(startMs)) {
    return null;
  }

  return new Date(startMs + recording.durationSeconds * 1000);
}

export function recordingOverlapsInterval(
  recording: Recording,
  startTime: Date,
  endTime: Date,
) {
  if (!recording.startTime) {
    return false;
  }

  const recordingStart = new Date(recording.startTime);
  if (Number.isNaN(recordingStart.getTime())) {
    return false;
  }

  const recordingEnd = getRecordingEndTime(recording) ?? recordingStart;
  return recordingStart < endTime && recordingEnd > startTime;
}

function getCoverageSeconds(recording: Recording, startTime: Date, endTime: Date) {
  if (!recording.startTime || recording.durationSeconds === null) {
    return 0;
  }

  const recordingStartMs = new Date(recording.startTime).getTime();
  if (Number.isNaN(recordingStartMs)) {
    return 0;
  }

  const recordingEndMs = recordingStartMs + recording.durationSeconds * 1000;
  const overlapStartMs = Math.max(startTime.getTime(), recordingStartMs);
  const overlapEndMs = Math.min(endTime.getTime(), recordingEndMs);
  return Math.max(0, Math.round((overlapEndMs - overlapStartMs) / 1000));
}

export function createInterval(input: {
  interval: ParsedIntervalId;
  recordings: Recording[];
}): Interval {
  const recordings = input.recordings
    .slice()
    .sort((left, right) => {
      if (!left.startTime && !right.startTime) return left.id.localeCompare(right.id);
      if (!left.startTime) return 1;
      if (!right.startTime) return -1;
      return left.startTime.localeCompare(right.startTime) || left.id.localeCompare(right.id);
    });

  return {
    coverageSeconds: recordings.reduce(
      (sum, recording) => sum + getCoverageSeconds(recording, input.interval.startTime, input.interval.endTime),
      0,
    ),
    durationSeconds: getDurationSeconds(input.interval.startTime, input.interval.endTime),
    endTime: input.interval.endTime.toISOString(),
    id: input.interval.id,
    key: input.interval.key,
    length: input.interval.length,
    recordings,
    startTime: input.interval.startTime.toISOString(),
  };
}

export function checkInterval(interval: Interval): ResourceCheckIssue[] {
  const issues: ResourceCheckIssue[] = [];

  if (interval.key !== getIntervalBucketKey(interval.id)) {
    issues.push({
      field: "key",
      message: "key does not match the canonical interval path.",
    });
  }

  if (Number.isNaN(new Date(interval.startTime).getTime())) {
    issues.push({
      field: "startTime",
      message: "startTime is not a valid ISO timestamp.",
    });
  }

  if (Number.isNaN(new Date(interval.endTime).getTime())) {
    issues.push({
      field: "endTime",
      message: "endTime is not a valid ISO timestamp.",
    });
  }

  if (interval.durationSeconds < 0) {
    issues.push({
      field: "durationSeconds",
      message: "durationSeconds must be non-negative.",
    });
  }

  if (interval.coverageSeconds < 0) {
    issues.push({
      field: "coverageSeconds",
      message: "coverageSeconds must be non-negative.",
    });
  }

  const startTime = new Date(interval.startTime);
  const endTime = new Date(interval.endTime);
  for (const recording of interval.recordings) {
    if (!recordingOverlapsInterval(recording, startTime, endTime)) {
      issues.push({
        field: "recordings",
        message: `recording ${recording.id} does not overlap the interval range.`,
      });
      break;
    }
  }

  return issues;
}

export function isIntervalFuture(interval: ParsedIntervalId, now: Date): boolean {
  return interval.startTime > now;
}

// The interval ID is a length prefix of every chunk ID it contains:
// daily "020260517" prefixes chunk IDs "0202605170000"–"0202605172350".
// A single prefix scan covers the entire interval.
export async function getIntervalChunkKeys(intervalId: string, options: { bucket: Bucket }): Promise<string[]> {
  const { id } = parseIntervalId(intervalId);
  return await listAllBucketKeys(options.bucket, { prefix: `chunks/${id}` });
}

export function getRecordingIdsFromChunkKeys(chunkKeys: string[]): string[] {
  const ids = new Set<string>();
  for (const key of chunkKeys) {
    const recordingId = key.split("/").at(-1)?.replace(/\.ogg$/, "");
    if (recordingId) ids.add(recordingId);
  }
  return [...ids];
}

export async function getIntervalRecordings(chunkKeys: string[], options: { bucket: Bucket }): Promise<Recording[]> {
  const recordingIds = getRecordingIdsFromChunkKeys(chunkKeys);
  const results = await Promise.all(
    recordingIds.map(async (recordingId) => {
      try {
        const manifest = await options.bucket.readJson<RecordingManifest>(`${getRecordingPrefix(recordingId)}/manifest.json`);
        return createRecordingFromManifest(manifest);
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is Recording => r !== null);
}

export async function readInterval(intervalId: string, options: { bucket: Bucket }) {
  const bucket = options.bucket;
  const key = getIntervalBucketKey(normalizeIntervalIdInput(intervalId));
  if (!(await bucket.exists(key))) {
    return null;
  }

  return await bucket.readJson<Interval>(key);
}

export async function listIntervals(options: { bucket: Bucket }) {
  return (await listAllBucketKeys(options.bucket, { prefix: "intervals/" }))
    .filter((key) => key.endsWith(".json"))
    .map((key) => {
      const id = key.replace(/^intervals\//, "").replace(/\.json$/, "");
      return intervalsResource.ref({ id, key });
    })
    .sort((left, right) => right.id.localeCompare(left.id));
}
