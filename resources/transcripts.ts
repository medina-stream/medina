import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactRefFromBucket, type ArtifactResolver } from "../lib/artifact";
import { listAllBucketKeys, normalizeBucketKey, type Bucket } from "../lib/bucket";
import { createBucketFromEnv } from "../lib/bucket-bun";
import { getDefaultTimeZone, localDateFromDayId, localDateOf } from "../lib/timezone";
import { bucketObject, defineResource, fetchBucketObjectToTempFile, runResource, writeBucketJson } from "../lib/resource";
import { parseChunkId } from "./chunk";
import { getGpsHourId, getGpsHourKey, type GpsHour } from "./gps-hour";
import { identifyDiarizedSpeakers, type SpeakerMatch } from "./speaker-embeddings";

export type TranscriptProvenance = "me" | "to-me" | "ambient";

export type TranscriptUtterance = {
  confidence: number;
  end: number;
  provenance?: TranscriptProvenance;
  speaker: number;
  speakerId?: string | null;
  start: number;
  text: string;
};

export type TranscriptionResponse = {
  duration?: number;
  requestId?: string;
};

export type ChunkTranscript = {
  chunkId: string;
  chunkKey: string;
  createdAt: string;
  endTime: string;
  model: string;
  provider: string;
  recordingId: string;
  response: TranscriptionResponse | Record<string, unknown>;
  speakers?: SpeakerMatch[];
  startTime: string;
  text: string;
  timeZone?: string;
  timeZoneSource?: "gps" | "carry-forward" | "default";
  transcriptKey: string;
  utterances?: TranscriptUtterance[];
};

type TranscriptionResult = {
  model: string;
  provider: "deepgram";
  response: TranscriptionResponse;
  text: string;
  utterances: TranscriptUtterance[];
};

type DeepgramUtterance = {
  confidence: number;
  end: number;
  speaker?: number;
  start: number;
  transcript: string;
};

type DeepgramResponse = {
  metadata?: { duration?: number; request_id?: string };
  results?: {
    channels?: { alternatives?: { transcript?: string }[] }[];
    utterances?: DeepgramUtterance[];
  };
};

export function parseChunkKey(chunkKey: string) {
  const normalized = normalizeBucketKey(chunkKey);
  const match = normalized.match(/^chunks\/(\d{13})\/([^/]+)\.ogg$/);
  if (!match) {
    throw new Error(`Invalid chunk key: ${chunkKey}`);
  }

  return {
    chunkId: match[1]!,
    recordingId: match[2]!,
  };
}

export function getTranscriptKey(chunkKey: string) {
  const { chunkId, recordingId } = parseChunkKey(chunkKey);
  return `chunks/${chunkId}/${recordingId}/transcript.json`;
}

function isChunkTranscriptKey(key: string) {
  return /^chunks\/\d{13}\/[^/]+\/transcript\.json$/.test(normalizeBucketKey(key));
}

export function isDayTranscriptId(value: string) {
  return /^\d{9}$/.test(value);
}

export function getTranscriptMaxAgeDays() {
  const raw = Number(process.env.TRANSCRIPT_MAX_AGE_DAYS ?? "4");
  return Number.isFinite(raw) ? raw : 4;
}

export function isDayTranscriptFinal(dayId: string, now: Date) {
  if (!isDayTranscriptId(dayId)) return false;
  const maxAgeDays = getTranscriptMaxAgeDays();
  if (maxAgeDays <= 0) return false;
  const dayEndMs = Date.UTC(
    Number(dayId.slice(0, 5)),
    Number(dayId.slice(5, 7)) - 1,
    Number(dayId.slice(7, 9)) + 1,
  ) + 14 * 60 * 60 * 1000;
  return now.getTime() - dayEndMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

export function getDayTranscriptKey(dayId: string) {
  if (!isDayTranscriptId(dayId)) throw new Error(`Invalid transcript day id: ${dayId}`);
  return `transcripts/${dayId}.json`;
}

export function dayIdFromTranscript(transcript: Pick<ChunkTranscript, "startTime" | "timeZone">) {
  const start = new Date(transcript.startTime);
  if (Number.isNaN(start.getTime())) return null;
  const timeZone = transcript.timeZone ?? getDefaultTimeZone();
  return `0${localDateOf(start.toISOString(), timeZone).replaceAll("-", "")}`;
}

function padDatePart(value: number, length: number) {
  return String(value).padStart(length, "0");
}

function chunkDigitsForDate(date: Date): string {
  const minute = Math.floor(date.getUTCMinutes() / 10) * 10;
  return [
    padDatePart(date.getUTCFullYear(), 5),
    padDatePart(date.getUTCMonth() + 1, 2),
    padDatePart(date.getUTCDate(), 2),
    padDatePart(date.getUTCHours(), 2),
    padDatePart(minute, 2),
  ].join("");
}

function getChunkPrefixForRange(from?: Date, to?: Date): string {
  if (!from || !to) return "chunks/";
  const lastIncludedMs = to.getTime() - 1;
  if (!Number.isFinite(lastIncludedMs) || from.getTime() > lastIncludedMs) return "chunks/";
  const fromDigits = chunkDigitsForDate(from);
  const toDigits = chunkDigitsForDate(new Date(lastIncludedMs));
  const commonLength = [...fromDigits].findIndex((char, index) => char !== toDigits[index]);
  const digits = fromDigits.slice(0, commonLength === -1 ? fromDigits.length : commonLength);
  return digits.length >= 5 ? `chunks/${digits}` : "chunks/";
}

const gpsJoinWindowMs = 30 * 60 * 1000;
const gpsCarryForwardWindowHours = 36;
const transcriptLocalDayScanMarginDays = 1;

type ChunkTimeZoneResolution = {
  timeZone: string;
  timeZoneSource: "gps" | "carry-forward" | "default";
};

type GpsPointForZone = {
  time: string;
  timeZone?: string;
};

function addUtcHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addUtcDaysToDayId(dayId: string, days: number) {
  const year = Number(dayId.slice(0, 5));
  const month = Number(dayId.slice(5, 7));
  const day = Number(dayId.slice(7, 9));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return [
    padDatePart(date.getUTCFullYear(), 5),
    padDatePart(date.getUTCMonth() + 1, 2),
    padDatePart(date.getUTCDate(), 2),
  ].join("");
}

type GpsHourReader = (hourId: string) => Promise<GpsHour | null>;

function createGpsHourReader(bucket: Bucket): GpsHourReader {
  const cache = new Map<string, Promise<GpsHour | null>>();
  return (hourId) => {
    let pending = cache.get(hourId);
    if (!pending) {
      pending = bucket.readJson<GpsHour>(getGpsHourKey(hourId)).catch((error) => {
        if (isMissingKeyError(error)) return null;
        throw error;
      });
      cache.set(hourId, pending);
    }
    return pending;
  };
}

function getGpsPointsForZone(hour: GpsHour | null): GpsPointForZone[] {
  if (!hour) return [];
  return hour.deduplicatedPoints;
}

function resolvePointTimeZone(point: GpsPointForZone) {
  return point.timeZone ?? getDefaultTimeZone();
}

export async function resolveChunkTimeZone(
  bucket: Bucket | GpsHourReader,
  startTimeIso: string,
): Promise<ChunkTimeZoneResolution> {
  const readGpsHour = typeof bucket === "function" ? bucket : createGpsHourReader(bucket);
  const start = new Date(startTimeIso);
  const startMs = start.getTime();
  if (Number.isNaN(startMs)) {
    return { timeZone: getDefaultTimeZone(), timeZoneSource: "default" };
  }

  const centerHour = addUtcHours(start, 0);
  centerHour.setUTCMinutes(0, 0, 0);
  const nearbyHourIds = [-1, 0, 1].map((offset) => getGpsHourId(addUtcHours(centerHour, offset)));
  const nearbyHours = await Promise.all(nearbyHourIds.map((hourId) => readGpsHour(hourId)));
  const nearestPoint = nearbyHours
    .flatMap(getGpsPointsForZone)
    .map((point) => ({ distanceMs: Math.abs(new Date(point.time).getTime() - startMs), point }))
    .filter(({ distanceMs }) => Number.isFinite(distanceMs))
    .sort((left, right) => left.distanceMs - right.distanceMs)[0];

  if (nearestPoint && nearestPoint.distanceMs <= gpsJoinWindowMs) {
    return {
      timeZone: resolvePointTimeZone(nearestPoint.point),
      timeZoneSource: "gps",
    };
  }

  for (let hourOffset = 0; hourOffset <= gpsCarryForwardWindowHours; hourOffset += 1) {
    const hour = await readGpsHour(getGpsHourId(addUtcHours(centerHour, -hourOffset)));
    const priorPoint = getGpsPointsForZone(hour)
      .filter((point) => {
        const pointMs = new Date(point.time).getTime();
        return Number.isFinite(pointMs) && pointMs <= startMs;
      })
      .sort((left, right) => right.time.localeCompare(left.time))[0];
    if (!priorPoint) continue;
    if (startMs - new Date(priorPoint.time).getTime() > gpsCarryForwardWindowHours * 60 * 60 * 1000) break;
    return {
      timeZone: resolvePointTimeZone(priorPoint),
      timeZoneSource: "carry-forward",
    };
  }

  return { timeZone: getDefaultTimeZone(), timeZoneSource: "default" };
}

function getDeepgramModel() {
  return process.env.DEEPGRAM_MODEL ?? "nova-3";
}

function getDeepgramBaseUrl() {
  return process.env.DEEPGRAM_BASE_URL ?? "https://api.deepgram.com";
}

function getDeepgramApiKey() {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY is not set");
  return key;
}

function contentTypeForAudio(path: string) {
  if (path.endsWith(".ogg")) return "audio/ogg";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".webm")) return "audio/webm";
  return "application/octet-stream";
}

export async function callDeepgramTranscription(inputPath: string): Promise<TranscriptionResult> {
  const model = getDeepgramModel();
  const params = new URLSearchParams({
    diarize: "true",
    model,
    punctuate: "true",
    smart_format: "true",
    utterances: "true",
  });
  const audio = await Bun.file(inputPath).arrayBuffer();
  const response = await fetch(`${getDeepgramBaseUrl()}/v1/listen?${params}`, {
    body: audio,
    headers: {
      authorization: `Token ${getDeepgramApiKey()}`,
      "content-type": contentTypeForAudio(inputPath),
    },
    method: "POST",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Deepgram transcription failed (${response.status}): ${body.slice(0, 500)}`);

  const parsed = JSON.parse(body) as DeepgramResponse;
  const utterances = (parsed.results?.utterances ?? []).map((utterance) => ({
    confidence: utterance.confidence,
    end: utterance.end,
    speaker: utterance.speaker ?? 0,
    start: utterance.start,
    text: utterance.transcript,
  }));
  return {
    model: `deepgram/${model}`,
    provider: "deepgram",
    response: {
      duration: parsed.metadata?.duration,
      requestId: parsed.metadata?.request_id,
    },
    text: parsed.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "",
    utterances,
  };
}

export function getSelfSpeakerId() {
  return process.env.MEDINA_SELF_SPEAKER_ID?.trim() || null;
}

const CONVERSATION_WINDOW_SECONDS = Number(process.env.TRANSCRIPT_CONVERSATION_WINDOW_SECONDS ?? "30");

export function classifyUtteranceProvenance(options: {
  selfSpeakerId: string | null;
  speakers: SpeakerMatch[];
  utterances: TranscriptUtterance[];
}): TranscriptUtterance[] {
  const selfSpeakers = new Set(
    options.selfSpeakerId
      ? options.speakers.filter((match) => match.speakerId === options.selfSpeakerId).map((match) => match.diarizedSpeaker)
      : [],
  );
  const speakerIdByDiarized = new Map(options.speakers.map((match) => [match.diarizedSpeaker, match.speakerId]));
  const selfSpans = options.utterances.filter((utterance) => selfSpeakers.has(utterance.speaker));

  return options.utterances.map((utterance) => {
    const speakerId = speakerIdByDiarized.get(utterance.speaker) ?? null;
    if (selfSpeakers.has(utterance.speaker)) {
      return { ...utterance, provenance: "me" as const, speakerId };
    }
    const nearSelf = selfSpans.some((span) =>
      utterance.start < span.end + CONVERSATION_WINDOW_SECONDS
      && span.start < utterance.end + CONVERSATION_WINDOW_SECONDS);
    return { ...utterance, provenance: nearSelf ? "to-me" as const : "ambient" as const, speakerId };
  });
}

async function withChunkAudio<T>(options: {
  artifacts?: ArtifactResolver;
  bucket: Bucket;
  filename: string;
  inputKey: string;
}, run: (inputPath: string) => Promise<T>): Promise<T> {
  const tempDir = options.artifacts ? null : await mkdtemp(join(tmpdir(), "medina-transcript-"));
  const lease = options.artifacts
    ? await options.artifacts.resolve(await artifactRefFromBucket(options.bucket, options.inputKey))
    : null;
  try {
    const inputPath = lease?.localPath
      ?? await fetchBucketObjectToTempFile(options.inputKey, options.filename, { bucket: options.bucket, tempDir: tempDir! });
    return await run(inputPath);
  } finally {
    await lease?.release();
    if (tempDir) await rm(tempDir, { force: true, recursive: true });
  }
}

type ChunkTranscriptState = {
  chunkId: string;
  chunkKey: string;
  recordingId: string;
  transcriptKey: string;
};

function getTranscriptDefinitionVersion() {
  return `5:deepgram:${getDeepgramModel()}:diarize:speaker-id`;
}

export const transcriptChunksDefinition = defineResource<ChunkTranscriptState>({
  async materialize({ artifacts, bucket, inputKey, now, plan }) {
    const { result, speakers } = await withChunkAudio({
      artifacts,
      bucket,
      filename: `${plan.state.recordingId}-${plan.state.chunkId}.ogg`,
      inputKey,
    }, async (inputPath) => {
      const result = await callDeepgramTranscription(inputPath);
      const speakers = await identifyDiarizedSpeakers({
        audioPath: inputPath,
        bucket,
        now,
        spans: result.utterances.map((utterance) => ({
          end: utterance.end,
          speaker: utterance.speaker,
          start: utterance.start,
        })),
      });
      return { result, speakers };
    });
    const utterances = classifyUtteranceProvenance({
      selfSpeakerId: getSelfSpeakerId(),
      speakers,
      utterances: result.utterances,
    });
    const { startTime, endTime } = parseChunkId(plan.state.chunkId);
    const transcript: ChunkTranscript = {
      chunkId: plan.state.chunkId,
      chunkKey: plan.state.chunkKey,
      createdAt: now.toISOString(),
      endTime: endTime.toISOString(),
      model: result.model,
      provider: result.provider,
      recordingId: plan.state.recordingId,
      response: result.response,
      speakers,
      startTime: startTime.toISOString(),
      text: result.text,
      transcriptKey: plan.state.transcriptKey,
      utterances,
    };

    await writeBucketJson(plan.state.transcriptKey, transcript, bucket);
  },
  name: "transcript-chunks",
  async plan({ inputKey }) {
    const chunkKey = normalizeBucketKey(inputKey);
    const { chunkId, recordingId } = parseChunkKey(chunkKey);
    const transcriptKey = getTranscriptKey(chunkKey);

    return {
      dependencies: [bucketObject(chunkKey)],
      outputs: [transcriptKey],
      state: {
        chunkId,
        chunkKey,
        recordingId,
        transcriptKey,
      },
    };
  },
  version: getTranscriptDefinitionVersion(),
});

export async function transcribeChunk(chunkKey: string, options: {
  bucket: Bucket;
  force?: boolean;
}) {
  const bucket = options.bucket;
  const normalizedChunkKey = normalizeBucketKey(chunkKey);
  const transcriptKey = getTranscriptKey(normalizedChunkKey);

  if (!options.force && await bucket.exists(transcriptKey)) {
    return await bucket.readJson<ChunkTranscript>(transcriptKey);
  }

  await runResource(transcriptChunksDefinition, {
    bucket,
    force: options.force,
    inputKey: normalizedChunkKey,
  });

  return await bucket.readJson<ChunkTranscript>(transcriptKey);
}

export async function listTranscripts(options: {
  bucket: Bucket;
  from?: Date;
  to?: Date;
}): Promise<ChunkTranscript[]> {
  const keys = await listAllBucketKeys(options.bucket, { prefix: getChunkPrefixForRange(options.from, options.to) });
  const transcripts = await Promise.all(
    keys
      .filter(isChunkTranscriptKey)
      .map((key) => options.bucket.readJson<ChunkTranscript>(key)),
  );

  return transcripts
    .filter((transcript) => {
      const startMs = new Date(transcript.startTime).getTime();
      const endMs = new Date(transcript.endTime).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false;
      if (options.from && endMs <= options.from.getTime()) return false;
      if (options.to && startMs >= options.to.getTime()) return false;
      return true;
    })
    .sort((left, right) => left.startTime.localeCompare(right.startTime) || left.chunkKey.localeCompare(right.chunkKey));
}

function isMissingKeyError(error: unknown) {
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT" || code === "NoSuchKey" || code === "NotFound") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not found|no such file|nosuchkey|does not exist/i.test(message);
}

export async function readDayTranscripts(dayId: string, options: { bucket: Bucket }): Promise<ChunkTranscript[] | null> {
  try {
    return await options.bucket.readJson<ChunkTranscript[]>(getDayTranscriptKey(dayId));
  } catch (error) {
    if (isMissingKeyError(error)) return null;
    throw error;
  }
}

export async function materializeDayTranscripts(dayId: string, options: { bucket: Bucket }): Promise<ChunkTranscript[]> {
  const key = getDayTranscriptKey(dayId);
  const candidatePrefixes = Array.from(
    { length: transcriptLocalDayScanMarginDays * 2 + 1 },
    (_, index) => `chunks/${addUtcDaysToDayId(dayId, index - transcriptLocalDayScanMarginDays)}`,
  );
  const candidateKeys = (await Promise.all(
    candidatePrefixes.map((prefix) => listAllBucketKeys(options.bucket, { prefix })),
  ))
    .flat()
    .filter(isChunkTranscriptKey);
  const localDate = localDateFromDayId(dayId);
  const readGpsHour = createGpsHourReader(options.bucket);
  const transcripts = (await Promise.all(
    candidateKeys.map(async (transcriptKey) => {
      const transcript = await options.bucket.readJson<ChunkTranscript>(transcriptKey).catch(() => null);
      if (!transcript) return null;
      const resolved = await resolveChunkTimeZone(readGpsHour, transcript.startTime);
      return { ...transcript, ...resolved };
    }),
  ))
    .filter((transcript): transcript is ChunkTranscript => transcript !== null)
    .filter((transcript) => localDateOf(transcript.startTime, transcript.timeZone ?? getDefaultTimeZone()) === localDate)
    .sort((left, right) => left.startTime.localeCompare(right.startTime) || left.chunkKey.localeCompare(right.chunkKey));

  await options.bucket.write(key, `${JSON.stringify(transcripts, null, 2)}\n`, {
    type: "application/json; charset=utf-8",
  });
  return transcripts;
}

function parseArgs(argv: string[]) {
  const chunkKeys: string[] = [];
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--force") {
      force = true;
      continue;
    }
    chunkKeys.push(arg);
  }
  if (chunkKeys.length === 0) {
    throw new Error("usage: bun resources/transcripts.ts <chunks/<chunk-id>/<recording-id>.ogg>... [--force]");
  }
  return { chunkKeys, force };
}

if (import.meta.main) {
  const { chunkKeys, force } = parseArgs(process.argv.slice(2));
  const bucket = createBucketFromEnv();
  const results = [];
  for (const chunkKey of chunkKeys) {
    results.push(await transcribeChunk(chunkKey, { bucket, force }));
  }
  console.log(JSON.stringify(results, null, 2));
}
