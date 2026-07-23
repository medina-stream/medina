import type { Bucket } from "../lib/bucket";
import { Resource } from "../lib/resource";
import { getFfprobeCommand } from "./media-tools";

export const ingestsResource = new Resource<IngestAnalysis>({
  kind: "ingests",
});

export type IngestProbeResult = {
  format?: {
    bit_rate?: string;
    duration?: string;
    format_name?: string;
    tags?: Record<string, string>;
    [key: string]: unknown;
  };
  streams?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type IngestAudioAnalysis = {
  bitRate: number | null;
  channelLayout: string | null;
  channels: number | null;
  codecName: string | null;
  durationSeconds: number | null;
  sampleRate: number | null;
};

export type IngestMediaKind = "audio" | "video" | "image" | "pdf" | "other";

export type IngestStartTimeEstimate = {
  estimatedAt: string;
  source: "metadata:recording-started-at" | "metadata:created-at" | "probe:creation_time" | "ingested-at";
};

export type IngestAnalysis = {
  analysisKey: string;
  contentType: string | null;
  ingestKey: string;
  ingestedAt: string;
  media: {
    audio: IngestAudioAnalysis | null;
    durationSeconds: number | null;
    formatName: string | null;
    hasAudioStream: boolean;
    kind: IngestMediaKind;
    probe: IngestProbeResult | null;
    sizeBytes: number;
  };
  metadata: Record<string, string>;
  originalFileName: string | null;
  startTime: IngestStartTimeEstimate;
  type: string | null;
};

export type IngestAnalysisBuildInput = {
  contentType?: string | null;
  ingestKey: string;
  ingestedAt: string;
  metadata?: Record<string, string>;
  originalFileName?: string | null;
  probe?: IngestProbeResult | null;
  sizeBytes: number;
  type?: string | null;
};

export type ResourceCheckIssue = {
  field: string;
  message: string;
};

function normalizeKey(key: string) {
  return key.replace(/^\/+/, "");
}

function padDatePart(value: number, length: number) {
  return String(value).padStart(length, "0");
}

function parseOptionalNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numberValue) ? numberValue : null;
}

function getAudioStream(probe: IngestProbeResult | null | undefined) {
  return (probe?.streams ?? []).find((stream) => stream.codec_type === "audio") ?? null;
}

export function hasAudioStream(probe: IngestProbeResult | null | undefined) {
  return getAudioStream(probe) !== null;
}

export function getIngestMediaKind(options: {
  contentType?: string | null;
  probe?: IngestProbeResult | null;
}) {
  const contentType = (options.contentType ?? "").toLowerCase();
  if (hasAudioStream(options.probe) || contentType.startsWith("audio/")) {
    return "audio" satisfies IngestMediaKind;
  }

  if (contentType.startsWith("video/")) {
    return "video" satisfies IngestMediaKind;
  }

  if (contentType.startsWith("image/")) {
    return "image" satisfies IngestMediaKind;
  }

  if (contentType === "application/pdf") {
    return "pdf" satisfies IngestMediaKind;
  }

  return "other" satisfies IngestMediaKind;
}

export function getIngestDurationSeconds(probe: IngestProbeResult | null | undefined) {
  return parseOptionalNumber(probe?.format?.duration);
}

export function getIngestAudioAnalysis(probe: IngestProbeResult | null | undefined): IngestAudioAnalysis | null {
  const stream = getAudioStream(probe);
  if (!stream) {
    return null;
  }

  return {
    bitRate: parseOptionalNumber(stream.bit_rate ?? probe?.format?.bit_rate),
    channelLayout: typeof stream.channel_layout === "string" ? stream.channel_layout : null,
    channels: parseOptionalNumber(stream.channels),
    codecName: typeof stream.codec_name === "string" ? stream.codec_name : null,
    durationSeconds: parseOptionalNumber(stream.duration ?? probe?.format?.duration),
    sampleRate: parseOptionalNumber(stream.sample_rate),
  };
}

export function estimateIngestStartTime(options: {
  ingestedAt: string;
  metadata?: Record<string, string>;
  probe?: IngestProbeResult | null;
}): IngestStartTimeEstimate {
  const metadata = options.metadata ?? {};
  const candidates: Array<{ source: IngestStartTimeEstimate["source"]; value: string | undefined }> = [
    {
      source: "metadata:recording-started-at",
      value: metadata["recording-started-at"],
    },
    {
      source: "metadata:created-at",
      value: metadata["created-at"],
    },
    {
      source: "probe:creation_time",
      value: options.probe?.format?.tags?.creation_time,
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.value) {
      continue;
    }

    const parsed = new Date(candidate.value);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        estimatedAt: parsed.toISOString(),
        source: candidate.source,
      };
    }
  }

  return {
    estimatedAt: new Date(options.ingestedAt).toISOString(),
    source: "ingested-at",
  };
}

export function getIngestAnalysisKey(ingestKey: string, ingestedAt: string | Date) {
  const date = typeof ingestedAt === "string" ? new Date(ingestedAt) : ingestedAt;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ingestedAt for ingest analysis: ${ingestedAt}`);
  }

  return [
    padDatePart(date.getUTCFullYear(), 5),
    padDatePart(date.getUTCMonth() + 1, 2),
    padDatePart(date.getUTCDate(), 2),
    "ingests",
    `${normalizeKey(ingestKey)}.json`,
  ].join("/");
}

export function createIngestAnalysis(input: IngestAnalysisBuildInput): IngestAnalysis {
  const metadata = input.metadata ?? {};
  const probe = input.probe ?? null;
  const ingestedAt = new Date(input.ingestedAt).toISOString();
  const analysisKey = getIngestAnalysisKey(input.ingestKey, ingestedAt);

  return {
    analysisKey,
    contentType: input.contentType ?? input.type ?? null,
    ingestKey: normalizeKey(input.ingestKey),
    ingestedAt,
    media: {
      audio: getIngestAudioAnalysis(probe),
      durationSeconds: getIngestDurationSeconds(probe),
      formatName: typeof probe?.format?.format_name === "string" ? probe.format.format_name : null,
      hasAudioStream: hasAudioStream(probe),
      kind: getIngestMediaKind({
        contentType: input.contentType ?? input.type ?? null,
        probe,
      }),
      probe,
      sizeBytes: input.sizeBytes,
    },
    metadata,
    originalFileName: input.originalFileName ?? metadata["original-filename"] ?? null,
    startTime: estimateIngestStartTime({
      ingestedAt,
      metadata,
      probe,
    }),
    type: input.type ?? null,
  };
}

export function checkIngestAnalysis(analysis: IngestAnalysis): ResourceCheckIssue[] {
  const issues: ResourceCheckIssue[] = [];

  if (analysis.analysisKey !== getIngestAnalysisKey(analysis.ingestKey, analysis.ingestedAt)) {
    issues.push({
      field: "analysisKey",
      message: "analysisKey does not match ingestKey + ingestedAt.",
    });
  }

  if (Number.isNaN(new Date(analysis.ingestedAt).getTime())) {
    issues.push({
      field: "ingestedAt",
      message: "ingestedAt is not a valid ISO timestamp.",
    });
  }

  if (Number.isNaN(new Date(analysis.startTime.estimatedAt).getTime())) {
    issues.push({
      field: "startTime.estimatedAt",
      message: "estimated start time is not a valid ISO timestamp.",
    });
  }

  if (analysis.media.sizeBytes < 0) {
    issues.push({
      field: "media.sizeBytes",
      message: "sizeBytes must be non-negative.",
    });
  }

  if (analysis.media.hasAudioStream && analysis.media.kind !== "audio") {
    issues.push({
      field: "media.kind",
      message: "media kind must be audio when an audio stream is present.",
    });
  }

  if (analysis.media.hasAudioStream && !analysis.media.audio) {
    issues.push({
      field: "media.audio",
      message: "audio analysis is missing for an audio ingest.",
    });
  }

  if (!analysis.media.hasAudioStream && analysis.media.audio) {
    issues.push({
      field: "media.audio",
      message: "audio analysis must be null when no audio stream is present.",
    });
  }

  if (analysis.startTime.source === "metadata:recording-started-at" && !analysis.metadata["recording-started-at"]) {
    issues.push({
      field: "startTime.source",
      message: "start time claims recording-started-at metadata, but the metadata is missing.",
    });
  }

  if (analysis.startTime.source === "metadata:created-at" && !analysis.metadata["created-at"]) {
    issues.push({
      field: "startTime.source",
      message: "start time claims created-at metadata, but the metadata is missing.",
    });
  }

  return issues;
}

export async function readIngestAnalysis(bucket: Bucket, analysisKey: string) {
  const normalizedKey = normalizeKey(analysisKey);
  if (!(await bucket.exists(normalizedKey))) {
    return null;
  }

  return await bucket.readJson<IngestAnalysis>(normalizedKey);
}

export class IngestProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestProbeError";
  }
}

export async function probeIngest(inputPath: string): Promise<IngestProbeResult | null> {
  const command = getFfprobeCommand();
  const proc = Bun.spawn([
    command,
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    if (stderr.includes("Invalid data found when processing input")) {
      return null;
    }
    throw new IngestProbeError(`ffprobe failed for ${inputPath}: ${stderr.trim() || `exit ${exitCode}`}`);
  }

  try {
    const parsed = JSON.parse(stdout || "{}") as IngestProbeResult;
    if (Object.keys(parsed).length === 0) {
      return null;
    }

    return parsed;
  } catch (error) {
    throw new IngestProbeError(`ffprobe returned invalid JSON for ${inputPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
