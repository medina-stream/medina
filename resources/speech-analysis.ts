#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { normalizeBucketKey, type Bucket } from "../lib/bucket";
import { createBucketFromEnv } from "../lib/bucket-bun";
import {
  bucketObject,
  defineResource,
  fetchBucketObjectToTempFile,
  parseResourceArgs,
  runResource,
  writeBucketJson,
} from "../lib/resource";
import { getFfmpegCommand, getFfprobeCommand } from "./media-tools";
import { parseChunkKey } from "./transcripts";

export type SilenceSpan = {
  durationSeconds: number;
  endSeconds: number;
  startSeconds: number;
};

export type SpeechSpan = {
  durationSeconds: number;
  endSeconds: number;
  startSeconds: number;
};

export type SpeechWindow = {
  durationSeconds: number;
  endSeconds: number;
  speechLikelihood: number;
  speechSeconds: number;
  startSeconds: number;
};

export type SpeechAnalysisModel = "ffmpeg-silencedetect" | "silero-vad";

export type SpeechAnalysis = {
  chunkKey: string;
  createdAt: string;
  durationSeconds: number;
  maxSilenceDurationSeconds?: number;
  method: "local-vad";
  model: SpeechAnalysisModel;
  modelParameters?: Record<string, number | string>;
  recordingId: string;
  silence?: SilenceSpan[];
  silenceThresholdDb?: number;
  speech?: SpeechSpan[];
  speechLikelihood: number;
  speechSeconds: number;
  windows: SpeechWindow[];
  windowSeconds: number;
  transcriptPolicy: {
    minSpeechSeconds: number;
    shouldTranscribe: boolean;
  };
};

type SileroVadResponse = {
  durationSeconds: number;
  model: "silero-vad";
  parameters: {
    minSilenceMs: number;
    minSpeechMs: number;
    samplingRate: number;
    speechPadMs: number;
    threshold: number;
  };
  speech: SpeechSpan[];
  speechLikelihood: number;
  speechSeconds: number;
};

type SpeechAnalysisState = {
  analysisKey: string;
  chunkKey: string;
  recordingId: string;
};

const silenceThresholdDb = Number(process.env.SPEECH_ANALYSIS_SILENCE_DB ?? "-45");
const minSilenceDurationSeconds = Number(process.env.SPEECH_ANALYSIS_MIN_SILENCE_SECONDS ?? "0.5");
const minSpeechSeconds = Number(process.env.TRANSCRIPT_MIN_SPEECH_SECONDS ?? "1.5");
const speechWindowSeconds = Number(process.env.SPEECH_ANALYSIS_WINDOW_SECONDS ?? "100");

function getSpeechAnalysisProvider(): SpeechAnalysisModel {
  const raw = (process.env.SPEECH_ANALYSIS_PROVIDER ?? process.env.VAD_PROVIDER ?? "silero").toLowerCase();
  return raw === "ffmpeg" || raw === "ffmpeg-silencedetect" ? "ffmpeg-silencedetect" : "silero-vad";
}

function getSileroCommand() {
  return process.env.SILERO_VAD_COMMAND ?? "uv";
}

function getSileroCommandArgs(inputPath: string) {
  const threshold = process.env.SILERO_VAD_THRESHOLD ?? "0.5";
  const minSpeechMs = process.env.SILERO_VAD_MIN_SPEECH_MS ?? "250";
  const minSilenceMs = process.env.SILERO_VAD_MIN_SILENCE_MS ?? "100";
  const speechPadMs = process.env.SILERO_VAD_SPEECH_PAD_MS ?? "30";
  const samplingRate = process.env.SILERO_VAD_SAMPLING_RATE ?? "16000";
  const script = process.env.SILERO_VAD_SCRIPT ?? "scripts/silero-vad.py";

  if (getSileroCommand() === "uv") {
    return [
      "run",
      "--with", "silero-vad",
      "--with", "onnxruntime",
      "--with", "soundfile",
      "--with", "torchcodec",
      "python", script,
      inputPath,
      "--threshold", threshold,
      "--min-speech-ms", minSpeechMs,
      "--min-silence-ms", minSilenceMs,
      "--speech-pad-ms", speechPadMs,
      "--sampling-rate", samplingRate,
    ];
  }

  return [
    script,
    inputPath,
    "--threshold", threshold,
    "--min-speech-ms", minSpeechMs,
    "--min-silence-ms", minSilenceMs,
    "--speech-pad-ms", speechPadMs,
    "--sampling-rate", samplingRate,
  ];
}

export function getSpeechAnalysisKey(chunkKey: string) {
  const { chunkId, recordingId } = parseChunkKey(chunkKey);
  return `speech-analysis/${chunkId}/${recordingId}.json`;
}

export function parseSilencedetect(stderr: string, durationSeconds: number): SilenceSpan[] {
  const starts: number[] = [];
  const spans: SilenceSpan[] = [];

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch?.[1]) {
      starts.push(Number(startMatch[1]));
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (endMatch?.[1] && endMatch?.[2]) {
      const start = starts.shift() ?? Math.max(0, Number(endMatch[1]) - Number(endMatch[2]));
      const end = Number(endMatch[1]);
      const silenceDuration = Number(endMatch[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(silenceDuration)) {
        spans.push({
          durationSeconds: Math.max(0, silenceDuration),
          endSeconds: Math.max(0, Math.min(durationSeconds, end)),
          startSeconds: Math.max(0, Math.min(durationSeconds, start)),
        });
      }
    }
  }

  for (const start of starts) {
    if (Number.isFinite(start) && start < durationSeconds) {
      spans.push({
        durationSeconds: Math.max(0, durationSeconds - start),
        endSeconds: durationSeconds,
        startSeconds: Math.max(0, start),
      });
    }
  }

  return spans.sort((left, right) => left.startSeconds - right.startSeconds);
}

function overlapSeconds(left: { endSeconds: number; startSeconds: number }, right: { endSeconds: number; startSeconds: number }) {
  return Math.max(0, Math.min(left.endSeconds, right.endSeconds) - Math.max(left.startSeconds, right.startSeconds));
}

export function createSpeechWindows(options: {
  durationSeconds: number;
  speech?: SpeechSpan[];
  silence?: SilenceSpan[];
  windowSeconds?: number;
}): SpeechWindow[] {
  const durationSeconds = Math.max(0, options.durationSeconds);
  const windowSeconds = Math.max(1, options.windowSeconds ?? speechWindowSeconds);
  const windows: SpeechWindow[] = [];

  for (let startSeconds = 0; startSeconds < durationSeconds || (durationSeconds === 0 && windows.length === 0); startSeconds += windowSeconds) {
    const endSeconds = Math.min(durationSeconds, startSeconds + windowSeconds);
    const actualDurationSeconds = Math.max(0, endSeconds - startSeconds);
    const window = { startSeconds, endSeconds };
    let speechSeconds = 0;

    if (options.speech) {
      speechSeconds = options.speech.reduce((sum, span) => sum + overlapSeconds(span, window), 0);
    } else if (options.silence) {
      const silenceSeconds = options.silence.reduce((sum, span) => sum + overlapSeconds(span, window), 0);
      speechSeconds = Math.max(0, actualDurationSeconds - silenceSeconds);
    }

    speechSeconds = Math.min(actualDurationSeconds, Math.max(0, speechSeconds));
    windows.push({
      durationSeconds: actualDurationSeconds,
      endSeconds,
      speechLikelihood: actualDurationSeconds > 0 ? speechSeconds / actualDurationSeconds : 0,
      speechSeconds,
      startSeconds,
    });

    if (durationSeconds === 0) break;
  }

  return windows;
}

export function summarizeSpeech(options: {
  durationSeconds: number;
  silence: SilenceSpan[];
  minSpeechSeconds?: number;
}) {
  const durationSeconds = Math.max(0, options.durationSeconds);
  const silenceSeconds = Math.min(
    durationSeconds,
    options.silence.reduce((sum, span) => sum + Math.max(0, span.durationSeconds), 0),
  );
  const speechSeconds = Math.max(0, durationSeconds - silenceSeconds);
  const speechLikelihood = durationSeconds > 0 ? speechSeconds / durationSeconds : 0;
  const minimumSpeechSeconds = options.minSpeechSeconds ?? minSpeechSeconds;

  return {
    speechLikelihood,
    speechSeconds,
    shouldTranscribe: speechSeconds >= minimumSpeechSeconds,
  };
}

async function probeDurationSeconds(path: string) {
  const proc = Bun.spawn([
    getFfprobeCommand(),
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ], { stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`ffprobe failed: ${stderr.trim() || `exit ${exitCode}`}`);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration)) throw new Error(`ffprobe returned invalid duration: ${stdout.trim()}`);
  return duration;
}

async function runSilencedetect(path: string) {
  const proc = Bun.spawn([
    getFfmpegCommand(),
    "-hide_banner",
    "-nostats",
    "-i", path,
    "-af", `silencedetect=n=${silenceThresholdDb}dB:d=${minSilenceDurationSeconds}`,
    "-f", "null",
    "-",
  ], { stderr: "pipe", stdout: "ignore" });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`ffmpeg silencedetect failed: ${stderr.trim() || `exit ${exitCode}`}`);
  return stderr;
}

async function runSileroVad(path: string): Promise<SileroVadResponse> {
  const command = getSileroCommand();
  const args = getSileroCommandArgs(path);
  const proc = Bun.spawn([command, ...args], { stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Silero VAD failed: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`);
  try {
    return JSON.parse(stdout) as SileroVadResponse;
  } catch (error) {
    throw new Error(`Silero VAD returned invalid JSON: ${(error as Error).message}`);
  }
}

export const speechAnalysisDefinition = defineResource<SpeechAnalysisState>({
  async materialize({ bucket, inputKey, now, plan }) {
    const tempDir = await mkdtemp(join(tmpdir(), "medina-speech-analysis-"));
    try {
      const inputPath = await fetchBucketObjectToTempFile(inputKey, inputKey.split("/").at(-1) ?? "chunk.ogg", { bucket, tempDir });
      const durationSeconds = await probeDurationSeconds(inputPath);
      const model = getSpeechAnalysisProvider();
      let analysis: SpeechAnalysis;

      if (model === "silero-vad") {
        const vad = await runSileroVad(inputPath);
        analysis = {
          chunkKey: plan.state.chunkKey,
          createdAt: now.toISOString(),
          durationSeconds,
          method: "local-vad",
          model,
          modelParameters: vad.parameters,
          recordingId: plan.state.recordingId,
          speech: vad.speech,
          speechLikelihood: durationSeconds > 0 ? vad.speechSeconds / durationSeconds : 0,
          speechSeconds: vad.speechSeconds,
          windows: createSpeechWindows({ durationSeconds, speech: vad.speech }),
          windowSeconds: speechWindowSeconds,
          transcriptPolicy: {
            minSpeechSeconds,
            shouldTranscribe: vad.speechSeconds >= minSpeechSeconds,
          },
        };
      } else {
        const stderr = await runSilencedetect(inputPath);
        const silence = parseSilencedetect(stderr, durationSeconds);
        const summary = summarizeSpeech({ durationSeconds, silence });
        analysis = {
          chunkKey: plan.state.chunkKey,
          createdAt: now.toISOString(),
          durationSeconds,
          maxSilenceDurationSeconds: minSilenceDurationSeconds,
          method: "local-vad",
          model,
          recordingId: plan.state.recordingId,
          silence,
          silenceThresholdDb,
          speechLikelihood: summary.speechLikelihood,
          speechSeconds: summary.speechSeconds,
          windows: createSpeechWindows({ durationSeconds, silence }),
          windowSeconds: speechWindowSeconds,
          transcriptPolicy: {
            minSpeechSeconds,
            shouldTranscribe: summary.shouldTranscribe,
          },
        };
      }

      await writeBucketJson(plan.state.analysisKey, analysis, bucket);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  },
  name: "speech-analysis",
  async plan({ inputKey }) {
    const chunkKey = normalizeBucketKey(inputKey);
    const { recordingId } = parseChunkKey(chunkKey);
    const analysisKey = getSpeechAnalysisKey(chunkKey);
    return {
      dependencies: [bucketObject(chunkKey)],
      outputs: [analysisKey],
      state: { analysisKey, chunkKey, recordingId },
    };
  },
  version: `3:${getSpeechAnalysisProvider()}:window-${speechWindowSeconds}`,
});

export async function analyzeChunkSpeech(chunkKey: string, options: { bucket: Bucket; force?: boolean }) {
  const normalizedChunkKey = normalizeBucketKey(chunkKey);
  const analysisKey = getSpeechAnalysisKey(normalizedChunkKey);
  await runResource(speechAnalysisDefinition, {
    bucket: options.bucket,
    force: options.force,
    inputKey: normalizedChunkKey,
  });
  return await options.bucket.readJson<SpeechAnalysis>(analysisKey);
}

if (import.meta.main) {
  const { force, inputKey } = parseResourceArgs();
  const bucket = createBucketFromEnv();
  const result = await runResource(speechAnalysisDefinition, { bucket, force, inputKey });
  console.log(JSON.stringify(result.outputs, null, 2));
}
