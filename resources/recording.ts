import { listAllBucketKeys, type Bucket } from "../lib/bucket";
import { createDeterministicResourceUuid, Resource } from "../lib/resource";
import type { IngestAnalysis, IngestProbeResult, ResourceCheckIssue } from "./ingest";

export const defaultChunkDurationSeconds = 1800;
export const recordingsResource = new Resource<RecordingManifest>({
  kind: "recordings",
});

const MIN_REASONABLE_START_MS = Date.parse("2000-01-01T00:00:00.000Z");
const START_TIME_FUTURE_GRACE_MS = 5 * 60 * 1000;

export type RecordingChunk = {
  contentType: string;
  durationSeconds: number | null;
  format: string;
  key: string;
  ordinal: number;
  url?: string;
};

export type RecordingPlaylist = {
  chunks: RecordingChunk[];
  format: string;
};

export type RecordingStartTimePrecision = "second" | "day";

export type RecordingStartTimeSource =
  | "metadata:recording-started-at"
  | "metadata:created-at"
  | "metadata:fs-mtime"
  | "probe:creation_time"
  | "probe:date"
  | "filename:timestamp"
  | "filename:date"
  | "content-hash:first-seen"
  | "ingested-at";

export type RecordingStartTimeEvidenceKind = "start" | "end" | "fallback";

export type RecordingStartTimeEvidence = {
  deltaSeconds?: number;
  explanation: string;
  kind: RecordingStartTimeEvidenceKind;
  source: RecordingStartTimeSource;
  time: string;
};

export type RecordingStartTimeEstimate = {
  confidence: number;
  estimatedAt: string;
  evidence?: RecordingStartTimeEvidence[];
  explanation: string;
  precision: RecordingStartTimePrecision;
  source: RecordingStartTimeSource;
  upperBound: string;
};

export type RecordingManifest = {
  analysisKey: string;
  chunkDurationSeconds: number;
  chunkFormats: Record<string, RecordingPlaylist>;
  estimatedStart: string;
  ingestKey: string;
  metadata: Record<string, string>;
  probe: IngestProbeResult | null;
  recordedAt: string;
  recordingId: string;
  startTimeEstimate: RecordingStartTimeEstimate;
  type: string | null;
};

export type RecordingMeta = {
  analysisKey: string;
  ingestKey: string;
  ingestedAt: string;
  mediaInfo: IngestProbeResult | null;
  metadata?: Record<string, string>;
  recordedAt?: string | null;
  recordingId?: string;
  recordingKey?: string;
  startTimeEstimate?: RecordingStartTimeEstimate | null;
  type?: string | null;
};

export type Recording = {
  chunks: RecordingChunk[];
  durationSeconds: number | null;
  id: string;
  startTime: string | null;
  startTimeEstimate?: RecordingStartTimeEstimate | null;
};

export type RecordingBuildInput = {
  analysis: IngestAnalysis;
  chunkDurationSeconds?: number;
  chunkKeys?: string[];
  recordingId?: string;
  startTimeEstimate?: RecordingStartTimeEstimate;
};

export type RecordingBuildResult = {
  manifest: RecordingManifest;
  manifestKey: string;
  meta: RecordingMeta;
  metaKey: string;
};

function normalizeKey(key: string) {
  return key.replace(/^\/+/, "");
}

function getFilenameTimestampTimeZone() {
  return process.env.MEDINA_FILENAME_TIMEZONE?.trim()
    || process.env.TZ?.trim()
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || "UTC";
}

function parseBoundedDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const zonedUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return zonedUtcMs - date.getTime();
}

function instantFromZonedParts(parts: {
  year: string;
  month: string;
  day: string;
  hour?: string;
  minute?: string;
  second?: string;
  millisecond?: string;
}, timeZone: string): Date | null {
  const baseMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour ?? "0"),
    Number(parts.minute ?? "0"),
    Number(parts.second ?? "0"),
    Number(parts.millisecond ?? "0"),
  );

  if (!Number.isFinite(baseMs)) {
    return null;
  }

  let timestampMs = baseMs;
  for (let index = 0; index < 2; index += 1) {
    timestampMs = baseMs - getTimeZoneOffsetMs(new Date(timestampMs), timeZone);
  }

  const parsed = new Date(timestampMs);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parseIsoFilenameTimestamp(filename: string) {
  const match = filename.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}(?::|-)\d{2}(?::|-)\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::|-)?\d{2}))/
  );
  if (!match?.[1]) {
    return null;
  }

  const normalized = match[1]
    .replace(
      /T(\d{2})-(\d{2})-(\d{2})(?=(?:\.\d+)?(?:Z|[+-]\d{2}(?::|-)?\d{2})$)/,
      "T$1:$2:$3",
    )
    .replace(/([+-]\d{2})-(\d{2})$/, "$1:$2");

  return parseBoundedDate(normalized);
}

export function parseFilenameStartTime(filename: string): {
  estimatedAt: string;
  precision: RecordingStartTimePrecision;
} | null {
  const timeZone = getFilenameTimestampTimeZone();
  const exactIso = parseIsoFilenameTimestamp(filename);
  if (exactIso) {
    return {
      estimatedAt: exactIso.toISOString(),
      precision: "second",
    };
  }

  let match = filename.match(/(\d{4})-(\d{2})-(\d{2})[_\s]+(\d{2})-(\d{2})-(\d{2})/);
  if (match?.[1] && match?.[2] && match?.[3] && match?.[4] && match?.[5] && match?.[6]) {
    const parsed = instantFromZonedParts({
      year: match[1],
      month: match[2],
      day: match[3],
      hour: match[4],
      minute: match[5],
      second: match[6],
    }, timeZone);
    if (parsed) {
      return {
        estimatedAt: parsed.toISOString(),
        precision: "second",
      };
    }
  }

  match = filename.match(/(\d{4})(\d{2})(\d{2})[_\sT-]+(\d{2})(\d{2})(\d{2})/);
  if (match?.[1] && match?.[2] && match?.[3] && match?.[4] && match?.[5] && match?.[6]) {
    const parsed = instantFromZonedParts({
      year: match[1],
      month: match[2],
      day: match[3],
      hour: match[4],
      minute: match[5],
      second: match[6],
    }, timeZone);
    if (parsed) {
      return {
        estimatedAt: parsed.toISOString(),
        precision: "second",
      };
    }
  }

  match = filename.match(/(\d{5})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (match?.[1] && match?.[2] && match?.[3] && match?.[4] && match?.[5] && match?.[6]) {
    const parsed = instantFromZonedParts({
      year: String(parseInt(match[1], 10)),
      month: match[2],
      day: match[3],
      hour: match[4],
      minute: match[5],
      second: match[6],
    }, timeZone);
    if (parsed) {
      return {
        estimatedAt: parsed.toISOString(),
        precision: "second",
      };
    }
  }

  match = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match?.[1] && match?.[2] && match?.[3]) {
    const parsed = instantFromZonedParts({
      year: match[1],
      month: match[2],
      day: match[3],
    }, timeZone);
    if (parsed) {
      return {
        estimatedAt: parsed.toISOString(),
        precision: "day",
      };
    }
  }

  match = filename.match(/(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (match?.[1] && match?.[2] && match?.[3]) {
    const parsed = instantFromZonedParts({
      year: match[1],
      month: match[2],
      day: match[3],
    }, timeZone);
    if (parsed) {
      return {
        estimatedAt: parsed.toISOString(),
        precision: "day",
      };
    }
  }

  return null;
}

function getProbeCreationTime(probe: IngestProbeResult | null | undefined) {
  return parseBoundedDate(typeof probe?.format?.tags?.creation_time === "string"
    ? probe.format.tags.creation_time
    : undefined);
}

function getProbeDate(probe: IngestProbeResult | null | undefined) {
  const date = typeof probe?.format?.tags?.date === "string"
    ? probe.format.tags.date
    : undefined;
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? parseBoundedDate(`${date}T00:00:00.000Z`)
    : null;
}

function isMedinaManagedMetadata(metadata: Record<string, string>) {
  return /^medina-/i.test(metadata["sdk-version"] ?? "")
    || /medina/i.test(metadata.source ?? "");
}

function clampConfidence(value: number) {
  return Math.max(0, Math.min(1, value));
}

const END_CORROBORATION_TOLERANCE_SECONDS = 5 * 60;

function getContainerExtension(filename: string | null, probe: IngestProbeResult | null | undefined) {
  const extension = filename?.split(".").at(-1)?.toLowerCase() ?? "";
  if (extension) return extension;

  const formatName = typeof probe?.format?.format_name === "string" ? probe.format.format_name : "";
  return formatName.includes("mp4") || formatName.includes("mov") ? "mp4" : "";
}

function getSourceTime(metadata: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const parsed = parseBoundedDate(metadata[key]);
    if (parsed) return parsed;
  }
  return null;
}

function endCorroboration(options: {
  durationSeconds: number | null;
  endAt: Date | null;
  explanation: string;
  source: RecordingStartTimeSource;
  startAt: Date;
}): RecordingStartTimeEvidence | null {
  if (!options.endAt || options.durationSeconds === null) return null;

  const expectedEndMs = options.startAt.getTime() + options.durationSeconds * 1000;
  const deltaSeconds = (options.endAt.getTime() - expectedEndMs) / 1000;
  if (Math.abs(deltaSeconds) > END_CORROBORATION_TOLERANCE_SECONDS) return null;

  return {
    deltaSeconds: Math.round(deltaSeconds * 1000) / 1000,
    explanation: options.explanation,
    kind: "end",
    source: options.source,
    time: options.endAt.toISOString(),
  };
}

function withEvidence(
  estimate: RecordingStartTimeEstimate,
  evidence: RecordingStartTimeEvidence[],
): RecordingStartTimeEstimate {
  return evidence.length === 0 ? estimate : {
    ...estimate,
    confidence: clampConfidence(estimate.confidence + 0.08),
    evidence: [
      ...(estimate.evidence ?? []),
      ...evidence,
    ],
    explanation: `${estimate.explanation} ${evidence.map((item) => item.explanation).join(" ")}`,
  };
}

function applyStartUpperBound(options: {
  candidateAt: Date;
  confidence: number;
  explanation: string;
  precision: RecordingStartTimePrecision;
  source: RecordingStartTimeSource;
  trusted?: boolean;
  upperBound: Date;
}): RecordingStartTimeEstimate {
  const candidateMs = options.candidateAt.getTime();
  const upperBoundMs = options.upperBound.getTime();

  if (!Number.isFinite(candidateMs) || candidateMs < MIN_REASONABLE_START_MS) {
    return {
      confidence: 0.05,
      estimatedAt: options.upperBound.toISOString(),
      evidence: [{
        explanation: "Used Medina's first-seen time after rejecting an implausible start candidate.",
        kind: "fallback",
        source: "content-hash:first-seen",
        time: options.upperBound.toISOString(),
      }],
      explanation: `${options.explanation} The candidate timestamp was implausible, so it was clamped to Medina's first-seen upper bound.`,
      precision: "second",
      source: "content-hash:first-seen",
      upperBound: options.upperBound.toISOString(),
    };
  }

  if (!options.trusted && candidateMs > upperBoundMs + START_TIME_FUTURE_GRACE_MS) {
    return {
      confidence: 0.05,
      estimatedAt: options.upperBound.toISOString(),
      evidence: [{
        explanation: "Used Medina's first-seen time after rejecting a future start candidate.",
        kind: "fallback",
        source: "content-hash:first-seen",
        time: options.upperBound.toISOString(),
      }],
      explanation: `${options.explanation} The candidate timestamp was later than Medina first saw this content, so it was clamped to that upper bound.`,
      precision: "second",
      source: "content-hash:first-seen",
      upperBound: options.upperBound.toISOString(),
    };
  }

  return {
    confidence: clampConfidence(options.confidence),
    estimatedAt: options.candidateAt.toISOString(),
    evidence: [{
      explanation: options.explanation,
      kind: "start",
      source: options.source,
      time: options.candidateAt.toISOString(),
    }],
    explanation: options.explanation,
    precision: options.precision,
    source: options.source,
    upperBound: options.upperBound.toISOString(),
  };
}

async function getContentHashFirstSeenAt(bucketInstance: Bucket, ingestKey: string) {
  const current = await bucketInstance.stat(ingestKey).catch(() => null);
  if (!current?.contentHash) return null;
  return {
    contentHash: current.contentHash,
    firstSeenAt: current.lastModified,
  };
}

function buildRecordingStartFallback(upperBound: Date): RecordingStartTimeEstimate {
  return {
    confidence: 0.1,
    estimatedAt: upperBound.toISOString(),
    evidence: [{
      explanation: "No reliable start evidence was found.",
      kind: "fallback",
      source: "content-hash:first-seen",
      time: upperBound.toISOString(),
    }],
    explanation: "No reliable recording-time clues were available, so Medina used the first time it saw this content as an upper bound.",
    precision: "second",
    source: "content-hash:first-seen",
    upperBound: upperBound.toISOString(),
  };
}

function pickBetterStartEstimate(left: RecordingStartTimeEstimate, right: RecordingStartTimeEstimate) {
  if (right.confidence !== left.confidence) {
    return right.confidence > left.confidence ? right : left;
  }

  if (right.precision !== left.precision) {
    return right.precision === "second" ? right : left;
  }

  return right.estimatedAt < left.estimatedAt ? right : left;
}

export async function estimateRecordingStartTime(options: {
  analysis: IngestAnalysis;
  bucket: Bucket;
}): Promise<RecordingStartTimeEstimate> {
  const bucketInstance = options.bucket;
  const analysis = options.analysis;
  const metadata = analysis.metadata ?? {};
  const filename = analysis.originalFileName ?? metadata["original-filename"] ?? null;
  const firstSeen = await getContentHashFirstSeenAt(bucketInstance, analysis.ingestKey);
  const ingestedAt = parseBoundedDate(analysis.ingestedAt) ?? new Date();
  const upperBound = firstSeen?.firstSeenAt && firstSeen.firstSeenAt < ingestedAt
    ? firstSeen.firstSeenAt
    : ingestedAt;
  const upperBoundIso = upperBound.toISOString();

  let bestEstimate = buildRecordingStartFallback(upperBound);
  const replaceBest = (next: RecordingStartTimeEstimate) => {
    bestEstimate = pickBetterStartEstimate(bestEstimate, next);
  };

  const explicitStart = parseBoundedDate(metadata["recording-started-at"]);
  if (explicitStart) {
    replaceBest(applyStartUpperBound({
      candidateAt: explicitStart,
      confidence: 1,
      explanation: "The ingest metadata included an explicit recording-started-at timestamp.",
      precision: "second",
      source: "metadata:recording-started-at",
      trusted: true,
      upperBound,
    }));
  }

  const durationSeconds = getRecordingDurationSeconds(analysis.media.probe);
  const sourceMtime = getSourceTime(metadata, ["fs-mtime", "fs_mtime", "source-mtime", "source-modified-at", "last-modified"])
    ?? upperBound;
  const filenameEstimate = filename ? parseFilenameStartTime(filename) : null;
  if (filenameEstimate) {
    const filenameStart = new Date(filenameEstimate.estimatedAt);
    const extension = getContainerExtension(filename, analysis.media.probe);
    const corroboration = [
      extension === "wav" ? endCorroboration({
        durationSeconds,
        endAt: sourceMtime,
        explanation: "Source mtime matches filename start plus media duration, so it was treated as recording end evidence.",
        source: "metadata:fs-mtime",
        startAt: filenameStart,
      }) : null,
      extension === "mp4" || extension === "m4a" || extension === "mov" ? endCorroboration({
        durationSeconds,
        endAt: getProbeCreationTime(analysis.media.probe),
        explanation: "MP4 creation_time matches filename start plus media duration, so it was treated as recording end evidence.",
        source: "probe:creation_time",
        startAt: filenameStart,
      }) : null,
    ].filter((item): item is RecordingStartTimeEvidence => item !== null);

    replaceBest(withEvidence(applyStartUpperBound({
      candidateAt: filenameStart,
      confidence: filenameEstimate.precision === "second" ? 0.86 : 0.45,
      explanation: filenameEstimate.precision === "second"
        ? `The original filename "${filename}" includes a parseable start timestamp.`
        : `The original filename "${filename}" only encodes a calendar day, so the exact time remains uncertain.`,
      precision: filenameEstimate.precision,
      source: filenameEstimate.precision === "second" ? "filename:timestamp" : "filename:date",
      upperBound,
    }), corroboration));
  }

  const probeCreationTime = getProbeCreationTime(analysis.media.probe);
  if (probeCreationTime && !filenameEstimate) {
    replaceBest(applyStartUpperBound({
      candidateAt: probeCreationTime,
      confidence: 0.45,
      explanation: "The media container metadata includes creation_time, but without filename corroboration it may be recording end or file creation time.",
      precision: "second",
      source: "probe:creation_time",
      upperBound,
    }));
  }

  const probeDate = getProbeDate(analysis.media.probe);
  if (probeDate && !filenameEstimate) {
    replaceBest(applyStartUpperBound({
      candidateAt: probeDate,
      confidence: 0.3,
      explanation: "The media metadata includes only a calendar date, so the exact time remains uncertain.",
      precision: "day",
      source: "probe:date",
      upperBound,
    }));
  }

  const createdAt = parseBoundedDate(metadata["created-at"]);
  if (createdAt) {
    let confidence = isMedinaManagedMetadata(metadata) ? 0.96 : 0.55;
    let explanation = isMedinaManagedMetadata(metadata)
      ? "The ingest metadata came from a Medina-managed client and includes created-at."
      : "The ingest metadata includes created-at, but it may reflect import time rather than capture time.";

    if (filenameEstimate) {
      const createdDay = createdAt.toISOString().slice(0, 10);
      const filenameDay = filenameEstimate.estimatedAt.slice(0, 10);
      const deltaMs = Math.abs(createdAt.getTime() - new Date(filenameEstimate.estimatedAt).getTime());

      if (filenameEstimate.precision === "second" && deltaMs <= 60 * 1000) {
        confidence = Math.max(confidence, 0.98);
        explanation += " The filename timestamp corroborates it.";
      } else if (filenameEstimate.precision === "second" && deltaMs > 60 * 60 * 1000) {
        confidence = Math.min(confidence, 0.2);
        explanation += " The filename timestamp conflicts with it, so this looks more like import-time metadata.";
      } else if (filenameEstimate.precision === "day" && createdDay !== filenameDay) {
        confidence = Math.min(confidence, 0.15);
        explanation += " The filename day conflicts with it, so this looks more like import-time metadata.";
      }
    }

    replaceBest(applyStartUpperBound({
      candidateAt: createdAt,
      confidence,
      explanation,
      precision: "second",
      source: "metadata:created-at",
      upperBound,
    }));
  }

  if (bestEstimate.source === "content-hash:first-seen" && !firstSeen) {
    return {
      ...bestEstimate,
      explanation: "No reliable recording-time clues were available, so Medina fell back to the ingest timestamp.",
      source: "ingested-at",
      upperBound: upperBoundIso,
    };
  }

  return {
    ...bestEstimate,
    upperBound: upperBoundIso,
  };
}

export function getRecordingPrefix(recordingId: string) {
  return [
    "recordings",
    recordingId,
  ].join("/");
}

export function getRecordingChunkKey(recordingId: string, fileName: string) {
  return `${getRecordingPrefix(recordingId)}/${fileName}`;
}

export function getRecordingDurationSeconds(probe: IngestProbeResult | null | undefined) {
  const rawDuration = probe?.format?.duration;
  const duration = rawDuration === undefined ? Number.NaN : Number(rawDuration);

  return Number.isFinite(duration) ? duration : null;
}

export function getChunkFormatFromKey(key: string) {
  const extension = key.split(".").at(-1)?.toLowerCase();

  switch (extension) {
    case "ogg":
      return {
        contentType: "audio/ogg",
        format: "ogg",
      };
    case "opus":
      return {
        contentType: "audio/opus",
        format: "opus",
      };
    case "mp3":
      return {
        contentType: "audio/mpeg",
        format: "mp3",
      };
    case "wav":
      return {
        contentType: "audio/wav",
        format: "wav",
      };
    default:
      return {
        contentType: "application/octet-stream",
        format: extension ?? "unknown",
      };
  }
}

export function buildRecordingChunkIndex(chunkKeys: string[]): Record<string, RecordingPlaylist> {
  const chunkFormats = new Map<string, RecordingChunk[]>();
  const defaultChunkDuration = chunkKeys.length > 0 ? defaultChunkDurationSeconds : null;

  chunkKeys.forEach((chunkKey, index) => {
    const normalizedKey = normalizeKey(chunkKey);
    const chunkFormat = getChunkFormatFromKey(normalizedKey);
    const chunks = chunkFormats.get(chunkFormat.format) ?? [];
    chunks.push({
      contentType: chunkFormat.contentType,
      durationSeconds: defaultChunkDuration,
      format: chunkFormat.format,
      key: normalizedKey,
      ordinal: index,
    });
    chunkFormats.set(chunkFormat.format, chunks);
  });

  return Object.fromEntries(
    [...chunkFormats.entries()].map(([format, chunks]) => [
      format,
      {
        chunks,
        format,
      } satisfies RecordingPlaylist,
    ]),
  );
}

export function createRecordingFromManifest(manifest: RecordingManifest): Recording {
  const startTimeEstimate = manifest.startTimeEstimate ?? {
    confidence: 1,
    estimatedAt: manifest.recordedAt,
    explanation: "Legacy manifest without structured start-time estimate.",
    precision: "second" as const,
    source: "metadata:recording-started-at" as const,
    upperBound: manifest.recordedAt,
  };

  return {
    chunks: Object.values(manifest.chunkFormats)
      .flatMap((playlist) => playlist.chunks)
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal || a.format.localeCompare(b.format))
      .map((chunk) => ({
        ...chunk,
        url: `/${normalizeKey(chunk.key)}`,
      })),
    durationSeconds: getRecordingDurationSeconds(manifest.probe),
    id: manifest.recordingId,
    startTime: manifest.recordedAt,
    startTimeEstimate,
  };
}

export async function getRecordingId(analysisKey: string) {
  return await createDeterministicResourceUuid(`medina:recordings:v1:${normalizeKey(analysisKey)}`);
}

export function createRecordingAsset(input: RecordingBuildInput): RecordingBuildResult {
  const analysis = input.analysis;
  const metadata = analysis.metadata ?? {};
  const probe = analysis.media.probe;
  const recordingId = input.recordingId;
  if (!recordingId) {
    throw new Error("recordingId is required for createRecordingAsset");
  }
  const startTimeEstimate = input.startTimeEstimate ?? {
    confidence: 0.2,
    estimatedAt: analysis.startTime.estimatedAt,
    explanation: `Fallback estimate inherited from ingest analysis (${analysis.startTime.source}).`,
    precision: "second" as const,
    source: analysis.startTime.source === "probe:creation_time"
      ? "probe:creation_time"
      : analysis.startTime.source === "metadata:recording-started-at"
        ? "metadata:recording-started-at"
        : analysis.startTime.source === "metadata:created-at"
          ? "metadata:created-at"
          : "ingested-at",
    upperBound: analysis.ingestedAt,
  };
  const recordedAt = startTimeEstimate.estimatedAt;
  const recordingPrefix = getRecordingPrefix(recordingId);
  const metaKey = `${recordingPrefix}/meta.json`;
  const manifestKey = `${recordingPrefix}/manifest.json`;
  const manifestRef = recordingsResource.ref({ id: recordingId, key: manifestKey });
  const chunkFormats = buildRecordingChunkIndex(input.chunkKeys ?? []);

  return {
    manifest: {
      analysisKey: analysis.analysisKey,
      chunkDurationSeconds: input.chunkDurationSeconds ?? defaultChunkDurationSeconds,
      chunkFormats,
      estimatedStart: recordedAt,
      ingestKey: normalizeKey(analysis.ingestKey),
      metadata,
      probe,
      recordedAt,
      recordingId,
      startTimeEstimate,
      type: analysis.type ?? null,
    },
    manifestKey: manifestRef.key,
    meta: {
      analysisKey: analysis.analysisKey,
      ingestKey: normalizeKey(analysis.ingestKey),
      ingestedAt: analysis.ingestedAt,
      mediaInfo: probe,
      metadata,
      recordedAt,
      recordingId,
      recordingKey: manifestRef.key,
      startTimeEstimate,
      type: analysis.type ?? null,
    },
    metaKey,
  };
}

export function checkRecordingManifest(manifest: RecordingManifest): ResourceCheckIssue[] {
  const issues: ResourceCheckIssue[] = [];

  if (!manifest.analysisKey) {
    issues.push({
      field: "analysisKey",
      message: "analysisKey is required.",
    });
  }

  if (!manifest.recordingId) {
    issues.push({
      field: "recordingId",
      message: "recordingId is required.",
    });
  }

  if (Number.isNaN(new Date(manifest.recordedAt).getTime())) {
    issues.push({
      field: "recordedAt",
      message: "recordedAt is not a valid ISO timestamp.",
    });
  }

  if (Number.isNaN(new Date(manifest.estimatedStart).getTime())) {
    issues.push({
      field: "estimatedStart",
      message: "estimatedStart is not a valid ISO timestamp.",
    });
  }

  if (Number.isNaN(new Date(manifest.startTimeEstimate?.estimatedAt ?? "").getTime())) {
    issues.push({
      field: "startTimeEstimate.estimatedAt",
      message: "startTimeEstimate.estimatedAt is not a valid ISO timestamp.",
    });
  }

  if (
    typeof manifest.startTimeEstimate?.confidence !== "number"
    || manifest.startTimeEstimate.confidence < 0
    || manifest.startTimeEstimate.confidence > 1
  ) {
    issues.push({
      field: "startTimeEstimate.confidence",
      message: "startTimeEstimate.confidence must be a number between 0 and 1.",
    });
  }

  const chunks = Object.values(manifest.chunkFormats).flatMap((playlist) => playlist.chunks);
  const ordinals = chunks.map((chunk) => chunk.ordinal).sort((a, b) => a - b);
  for (let index = 0; index < ordinals.length; index += 1) {
    if (ordinals[index] !== index) {
      issues.push({
        field: "chunkFormats",
        message: "chunk ordinals must form a contiguous zero-based sequence.",
      });
      break;
    }
  }

  return issues;
}

export function checkRecordingMeta(meta: RecordingMeta): ResourceCheckIssue[] {
  const issues: ResourceCheckIssue[] = [];

  if (!meta.analysisKey) {
    issues.push({
      field: "analysisKey",
      message: "analysisKey is required.",
    });
  }

  if (!meta.recordingKey) {
    issues.push({
      field: "recordingKey",
      message: "recordingKey is required.",
    });
  }

  if (Number.isNaN(new Date(meta.ingestedAt).getTime())) {
    issues.push({
      field: "ingestedAt",
      message: "ingestedAt is not a valid ISO timestamp.",
    });
  }

  if (meta.startTimeEstimate && Number.isNaN(new Date(meta.startTimeEstimate.estimatedAt).getTime())) {
    issues.push({
      field: "startTimeEstimate.estimatedAt",
      message: "meta.startTimeEstimate.estimatedAt is not a valid ISO timestamp.",
    });
  }

  return issues;
}

export function checkRecordingAsset(asset: RecordingBuildResult): ResourceCheckIssue[] {
  const issues = [
    ...checkRecordingManifest(asset.manifest),
    ...checkRecordingMeta(asset.meta),
  ];

  if (asset.meta.recordingId !== asset.manifest.recordingId) {
    issues.push({
      field: "recordingId",
      message: "meta and manifest recordingId must match.",
    });
  }

  if (asset.meta.analysisKey !== asset.manifest.analysisKey) {
    issues.push({
      field: "analysisKey",
      message: "meta and manifest analysisKey must match.",
    });
  }

  if (asset.meta.recordingKey !== asset.manifestKey) {
    issues.push({
      field: "recordingKey",
      message: "meta.recordingKey must match manifestKey.",
    });
  }

  if (asset.metaKey !== `${getRecordingPrefix(asset.manifest.recordingId)}/meta.json`) {
    issues.push({
      field: "metaKey",
      message: "metaKey does not match the canonical recording path.",
    });
  }

  return issues;
}

export async function getRecordings(options: { bucket: Bucket }): Promise<Recording[]> {
  const bucket = options.bucket;
  const manifestKeys = (await listAllBucketKeys(bucket, { prefix: "recordings/" }))
    .filter((key) => key.endsWith("/manifest.json"));

  const recordings = await Promise.all(
    manifestKeys.map(async (key): Promise<Recording | null> => {
      try {
        const manifest = await bucket.readJson<RecordingManifest>(key);
        return createRecordingFromManifest(manifest);
      } catch {
        return null;
      }
    }),
  );

  return recordings
    .filter((r): r is Recording => r !== null)
    .sort((a, b) => {
      if (!a.startTime && !b.startTime) return 0;
      if (!a.startTime) return 1;
      if (!b.startTime) return -1;
      return b.startTime.localeCompare(a.startTime);
    });
}
