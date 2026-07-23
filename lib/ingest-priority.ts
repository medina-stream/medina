import { normalizeBucketKey } from "./bucket";

export function priorityForIngestKey(ingestKey: string, createdAt?: string) {
  const id = normalizeBucketKey(ingestKey).replace(/^in\//, "");
  const timestamp = Number(id);
  if (Number.isFinite(timestamp) && timestamp > 1e12) return -timestamp;

  const createdMs = createdAt ? new Date(createdAt).getTime() : Number.NaN;
  return Number.isFinite(createdMs) ? -createdMs : 0;
}
