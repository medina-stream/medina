import { listAllBucketKeys, normalizeBucketKey, type Bucket } from "../lib/bucket";
import { writeBucketJson } from "../lib/resource";

export type SpeakerSample = {
  contentType: string;
  createdAt: string;
  durationSeconds?: number;
  key: string;
  name: string;
  size: number;
};

export type SpeakerInfo = {
  createdAt: string;
  id: string;
  name: string;
  notes?: string;
  sampleCount: number;
  samples: SpeakerSample[];
  updatedAt: string;
};

export type SpeakerSummary = SpeakerInfo;

export function normalizeSpeakerId(id: string) {
  const value = id.trim();
  if (!/^\d+$/.test(value)) throw new Error(`Invalid speaker id: ${id}`);
  return value;
}

export function speakerInfoKey(id: string) {
  return `speakers/${normalizeSpeakerId(id)}/info.json`;
}

export function speakerSampleKey(id: string, sampleName: string) {
  const safeName = sampleName
    .trim()
    .replace(/^\/+/, "")
    .split("/")
    .at(-1)
    ?.replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "sample.ogg";
  return `speakers/${normalizeSpeakerId(id)}/${safeName}`;
}

function isSpeakerInfoKey(key: string) {
  return /^speakers\/\d+\/info\.json$/.test(normalizeBucketKey(key));
}

function sampleNameFromKey(key: string) {
  return key.split("/").at(-1) ?? "sample";
}

async function readSpeakerSamples(bucket: Bucket, id: string): Promise<SpeakerSample[]> {
  const prefix = `speakers/${normalizeSpeakerId(id)}/`;
  const keys = (await listAllBucketKeys(bucket, { prefix }))
    .filter((key) => key !== `${prefix}info.json` && !key.endsWith("/info.json") && !key.endsWith(".embedding.json"))
    .sort();
  return await Promise.all(keys.map(async (key) => {
    const stat = await bucket.stat(key);
    return {
      contentType: stat.type ?? stat.headers?.["content-type"] ?? "application/octet-stream",
      createdAt: stat.lastModified.toISOString(),
      key,
      name: sampleNameFromKey(key),
      size: stat.size,
    };
  }));
}

async function hydrateSpeakerInfo(bucket: Bucket, info: SpeakerInfo): Promise<SpeakerInfo> {
  const samples = await readSpeakerSamples(bucket, info.id);
  return {
    ...info,
    sampleCount: samples.length,
    samples,
  };
}

export async function listSpeakers(options: { bucket: Bucket }): Promise<SpeakerSummary[]> {
  const keys = (await listAllBucketKeys(options.bucket, { prefix: "speakers/" }))
    .filter(isSpeakerInfoKey)
    .sort((left, right) => Number(left.split("/")[1]) - Number(right.split("/")[1]));
  const speakers = await Promise.all(keys.map((key) => options.bucket.readJson<SpeakerInfo>(key).catch(() => null)));
  return await Promise.all(speakers.filter((speaker): speaker is SpeakerInfo => speaker !== null).map((speaker) => hydrateSpeakerInfo(options.bucket, speaker)));
}

export async function readSpeaker(options: { bucket: Bucket; id: string }): Promise<SpeakerInfo | null> {
  const id = normalizeSpeakerId(options.id);
  const key = speakerInfoKey(id);
  if (!(await options.bucket.exists(key))) return null;
  return await hydrateSpeakerInfo(options.bucket, await options.bucket.readJson<SpeakerInfo>(key));
}

async function nextSpeakerId(bucket: Bucket) {
  const keys = await listAllBucketKeys(bucket, { prefix: "speakers/" });
  const ids = keys
    .map((key) => key.match(/^speakers\/(\d+)\//)?.[1])
    .filter((value): value is string => !!value)
    .map(Number);
  return String((ids.length ? Math.max(...ids) : 0) + 1);
}

export async function createSpeaker(options: { bucket: Bucket; name: string; notes?: string; now?: Date }): Promise<SpeakerInfo> {
  const name = options.name.trim();
  if (!name) throw new Error("Speaker name is required.");
  const now = options.now ?? new Date();
  const info: SpeakerInfo = {
    createdAt: now.toISOString(),
    id: await nextSpeakerId(options.bucket),
    name,
    notes: options.notes?.trim() || undefined,
    sampleCount: 0,
    samples: [],
    updatedAt: now.toISOString(),
  };
  await writeBucketJson(speakerInfoKey(info.id), info, options.bucket);
  return info;
}

export async function updateSpeaker(options: { bucket: Bucket; id: string; name: string; notes?: string; now?: Date }): Promise<SpeakerInfo | null> {
  const existing = await readSpeaker({ bucket: options.bucket, id: options.id });
  if (!existing) return null;
  const name = options.name.trim();
  if (!name) throw new Error("Speaker name is required.");
  const next: SpeakerInfo = {
    ...existing,
    name,
    notes: options.notes?.trim() || undefined,
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
  await writeBucketJson(speakerInfoKey(existing.id), next, options.bucket);
  return await readSpeaker({ bucket: options.bucket, id: existing.id });
}

export async function deleteSpeaker(options: { bucket: Bucket; id: string }) {
  const id = normalizeSpeakerId(options.id);
  const prefix = `speakers/${id}/`;
  const keys = await listAllBucketKeys(options.bucket, { prefix });
  await Promise.all(keys.map((key) => options.bucket.delete(key)));
}

export async function writeSpeakerSample(options: {
  bucket: Bucket;
  contentType?: string;
  data: ArrayBuffer;
  filename: string;
  id: string;
}): Promise<SpeakerInfo | null> {
  const speaker = await readSpeaker({ bucket: options.bucket, id: options.id });
  if (!speaker) return null;
  const existingNames = new Set(speaker.samples.map((sample) => sample.name));
  const parsed = speakerSampleKey(speaker.id, options.filename);
  const base = parsed.split("/").at(-1) ?? "sample.ogg";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let name = base;
  for (let index = 2; existingNames.has(name); index += 1) {
    name = `${stem}-${index}${ext}`;
  }
  await options.bucket.write(`speakers/${speaker.id}/${name}`, options.data, {
    type: options.contentType ?? "application/octet-stream",
  });
  const next: SpeakerInfo = {
    ...speaker,
    updatedAt: new Date().toISOString(),
  };
  await writeBucketJson(speakerInfoKey(speaker.id), next, options.bucket);
  return await readSpeaker({ bucket: options.bucket, id: speaker.id });
}

export async function deleteSpeakerSample(options: { bucket: Bucket; id: string; sampleName: string }): Promise<SpeakerInfo | null> {
  const speaker = await readSpeaker({ bucket: options.bucket, id: options.id });
  if (!speaker) return null;
  const key = speakerSampleKey(speaker.id, options.sampleName);
  if (await options.bucket.exists(key)) await options.bucket.delete(key);
  const next: SpeakerInfo = {
    ...speaker,
    updatedAt: new Date().toISOString(),
  };
  await writeBucketJson(speakerInfoKey(speaker.id), next, options.bucket);
  return await readSpeaker({ bucket: options.bucket, id: speaker.id });
}
