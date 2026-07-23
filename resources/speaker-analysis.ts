#!/usr/bin/env bun

import { normalizeBucketKey, type Bucket } from "../lib/bucket";
import { createBucketFromEnv } from "../lib/bucket-bun";
import {
  bucketObject,
  defineResource,
  parseResourceArgs,
  runResource,
  writeBucketJson,
} from "../lib/resource";
import { parseChunkId } from "./chunk";
import { analyzeChunkSpeech, getSpeechAnalysisKey, speechAnalysisDefinition, type SpeechWindow } from "./speech-analysis";
import { parseChunkKey } from "./transcripts";

export type RecognizedSpeakerScore = {
  confidence: number | null;
  speakerId: string;
};

export type SpeakerAnalysis = {
  chunkId: string;
  chunkKey: string;
  createdAt: string;
  endTime: string;
  method: "speech-vad-only";
  model: "none";
  recognizedSpeakers: RecognizedSpeakerScore[];
  recordingId: string;
  speechAnalysisKey: string;
  speechLikelihood: number;
  speechSeconds: number;
  startTime: string;
  windows: SpeechWindow[];
  windowSeconds: number;
  transcriptPolicy: {
    shouldTranscribe: boolean;
  };
};

type SpeakerAnalysisState = {
  analysisKey: string;
  chunkId: string;
  chunkKey: string;
  recordingId: string;
  speechAnalysisKey: string;
};

export function getSpeakerAnalysisKey(chunkKey: string) {
  const { chunkId, recordingId } = parseChunkKey(chunkKey);
  return `speaker-analysis/${chunkId}/${recordingId}.json`;
}

export const speakerAnalysisDefinition = defineResource<SpeakerAnalysisState>({
  async materialize({ bucket, inputKey, now, plan }) {
    const speech = await analyzeChunkSpeech(inputKey, { bucket });
    const { startTime, endTime } = parseChunkId(plan.state.chunkId);
    const analysis: SpeakerAnalysis = {
      chunkId: plan.state.chunkId,
      chunkKey: plan.state.chunkKey,
      createdAt: now.toISOString(),
      endTime: endTime.toISOString(),
      method: "speech-vad-only",
      model: "none",
      recognizedSpeakers: [],
      recordingId: plan.state.recordingId,
      speechAnalysisKey: plan.state.speechAnalysisKey,
      speechLikelihood: speech.speechLikelihood,
      speechSeconds: speech.speechSeconds,
      startTime: startTime.toISOString(),
      windows: speech.windows,
      windowSeconds: speech.windowSeconds,
      transcriptPolicy: {
        shouldTranscribe: speech.transcriptPolicy.shouldTranscribe,
      },
    };
    await writeBucketJson(plan.state.analysisKey, analysis, bucket);
  },
  name: "speaker-analysis",
  async plan({ inputKey }) {
    const chunkKey = normalizeBucketKey(inputKey);
    const { chunkId, recordingId } = parseChunkKey(chunkKey);
    const analysisKey = getSpeakerAnalysisKey(chunkKey);
    const speechAnalysisKey = getSpeechAnalysisKey(chunkKey);
    return {
      dependencies: [bucketObject(chunkKey)],
      outputs: [analysisKey],
      state: { analysisKey, chunkId, chunkKey, recordingId, speechAnalysisKey },
    };
  },
  version: `1:vad-only:${speechAnalysisDefinition.version}`,
});

export async function analyzeChunkSpeakers(chunkKey: string, options: { bucket: Bucket; force?: boolean }) {
  const normalizedChunkKey = normalizeBucketKey(chunkKey);
  const analysisKey = getSpeakerAnalysisKey(normalizedChunkKey);
  await runResource(speakerAnalysisDefinition, {
    bucket: options.bucket,
    force: options.force,
    inputKey: normalizedChunkKey,
  });
  return await options.bucket.readJson<SpeakerAnalysis>(analysisKey);
}

if (import.meta.main) {
  const { force, inputKey } = parseResourceArgs();
  const bucket = createBucketFromEnv();
  const result = await runResource(speakerAnalysisDefinition, { bucket, force, inputKey });
  console.log(JSON.stringify(result.outputs, null, 2));
}
