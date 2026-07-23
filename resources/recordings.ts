#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { artifactRefFromBucket, artifactRefKey, type ArtifactResolver } from "../lib/artifact";
import type { Bucket } from "../lib/bucket";
import { createBucketFromEnv } from "../lib/bucket-bun";
import { getFfmpegCommand } from "./media-tools";
import { bucketObject, defineResource, fetchBucketObjectToTempFile, getMaterializationReceiptKey, parseResourceArgs, runResource, writeBucketJson } from "../lib/resource";
import { deleteWork } from "../lib/work-queue";
import { readIngestAnalysis, type IngestAnalysis } from "./ingest";
import { createRecordingAsset, estimateRecordingStartTime, getRecordingId, type RecordingManifest } from "./recording";
import { CHUNK_DURATION_SECONDS, getChunkWindows, type ChunkWindow } from "./chunk";
import { transcriptWorkDefinition } from "./transcript-work";
import { getTranscriptKey } from "./transcripts";

type RecordingsState =
  | { analysisKey: string; materializable: false; reason: string }
  | {
    analysis: IngestAnalysis;
    analysisKey: string;
    chunkKeys: string[];
    inputFileName: string;
    manifestKey: string;
    materializable: true;
    recordingId: string;
    staleChunkKeys: string[];
    windows: ChunkWindow[];
  };

async function listSegmentIndexes(chunkDir: string) {
  const indexes: number[] = [];
  for await (const name of new Bun.Glob("chunk-*.ogg").scan({ cwd: chunkDir })) {
    const match = name.match(/^chunk-(\d+)\.ogg$/);
    if (match?.[1]) indexes.push(Number(match[1]));
  }
  return indexes.filter(Number.isFinite).sort((left, right) => left - right);
}

function getManifestChunkKeys(manifest: RecordingManifest) {
  return Object.values(manifest.chunkFormats).flatMap((playlist) => playlist.chunks.map((chunk) => chunk.key));
}

async function deleteStaleChunkArtifacts(bucket: Bucket, chunkKey: string) {
  const transcriptKey = getTranscriptKey(chunkKey);
  await Promise.all([
    deleteWork(bucket, transcriptWorkDefinition.name, chunkKey),
    bucket.delete(chunkKey),
    bucket.delete(artifactRefKey(chunkKey)),
    bucket.delete(getMaterializationReceiptKey(chunkKey)),
    bucket.delete(transcriptKey),
    bucket.delete(getMaterializationReceiptKey(transcriptKey)),
  ]);
}

async function uploadCompletedSegments(options: {
  artifacts?: ArtifactResolver;
  bucket: Bucket;
  chunkDir: string;
  final?: boolean;
  uploadedIndexes: Set<number>;
  windows: ChunkWindow[];
}) {
  const indexes = await listSegmentIndexes(options.chunkDir);
  const maxSeen = indexes.at(-1) ?? -1;
  const maxUploadIndex = options.final ? maxSeen : maxSeen - 1;

  for (const index of indexes) {
    if (index > maxUploadIndex || index >= options.windows.length || options.uploadedIndexes.has(index)) continue;
    const chunkFile = join(options.chunkDir, `chunk-${String(index).padStart(3, "0")}.ogg`);
    const outputKey = options.windows[index]!.outputKey;
    if (options.artifacts) {
      await options.artifacts.publish({
        contentType: "audio/ogg",
        key: outputKey,
        source: { kind: "local-path", path: chunkFile },
      });
    } else {
      await options.bucket.write(outputKey, Bun.file(chunkFile), { type: "audio/ogg" });
    }
    options.uploadedIndexes.add(index);
  }
}

export const recordingsDefinition = defineResource<RecordingsState>({
  async materialize({ artifacts, bucket, plan, progress }) {
    if (!plan.state.materializable) return [];
    const state = plan.state;

    const tempDir = await mkdtemp(join(tmpdir(), "medina-recording-"));
    const lease = artifacts
      ? await artifacts.resolve(await artifactRefFromBucket(bucket, state.analysis.ingestKey))
      : null;
    try {
      await progress?.({ stage: lease ? "resolving-recording" : "downloading-recording" });
      const inputPath = lease?.localPath
        ?? await fetchBucketObjectToTempFile(state.analysis.ingestKey, state.inputFileName, { bucket, tempDir });
      await progress?.({ stage: "transcoding-recording", totalChunks: state.windows.length });
      const chunkDir = join(tempDir, "chunks");
      await Bun.$`mkdir -p ${chunkDir}`;

      const ffmpeg = getFfmpegCommand();
      const segmentPattern = join(chunkDir, "chunk-%03d.ogg");
      const totalOutputSeconds = state.windows.length * CHUNK_DURATION_SECONDS;
      const leadingDelayMs = Math.round((state.windows[0]?.leadingSilenceSeconds ?? 0) * 1000);
      const filter = leadingDelayMs > 0 ? `adelay=${leadingDelayMs}:all=1,apad` : "apad";
      let lastProgressLog = 0;
      const proc = Bun.spawn([
        ffmpeg,
        "-i", inputPath,
        "-map", "0:a:0",
        "-vn",
        "-af", filter,
        "-ac", "1",
        "-c:a", "libopus",
        "-b:a", "32k",
        "-vbr", "on",
        "-application", "voip",
        "-compression_level", "0",
        "-frame_duration", "60",
        "-t", String(totalOutputSeconds),
        "-f", "segment",
        "-segment_time", String(CHUNK_DURATION_SECONDS),
        "-reset_timestamps", "1",
        "-progress", "pipe:2",
        segmentPattern,
      ], { stderr: "pipe", stdout: "ignore" });

      let stderr = "";
      const uploadedIndexes = new Set<number>();
      let uploadsDone = false;
      const uploadSegments = (async () => {
        while (!uploadsDone) {
          await uploadCompletedSegments({ artifacts, bucket, chunkDir, uploadedIndexes, windows: state.windows });
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        await uploadCompletedSegments({ artifacts, bucket, chunkDir, final: true, uploadedIndexes, windows: state.windows });
      })();
      const progressReader = (async () => {
        if (!proc.stderr) return;
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split(/\r?\n/);
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            stderr += `${line}\n`;
            const match = line.match(/^out_time_ms=(\d+)/);
            if (!match) continue;
            const processedSeconds = Number(match[1]) / 1_000_000;
            const now = Date.now();
            if (now - lastProgressLog >= 30_000) {
              lastProgressLog = now;
              const percent = Math.min(100, Math.max(0, processedSeconds / totalOutputSeconds * 100));
              console.log(`[recordings] ${state.analysis.ingestKey} ffmpeg ${processedSeconds.toFixed(0)}s/${totalOutputSeconds.toFixed(0)}s ${percent.toFixed(1)}% uploaded=${uploadedIndexes.size}/${state.windows.length}`);
              await progress?.({
                percent: Number(percent.toFixed(1)),
                processedSeconds: Math.round(processedSeconds),
                stage: "transcoding-recording",
                totalChunks: state.windows.length,
                totalSeconds: totalOutputSeconds,
                uploadedChunks: uploadedIndexes.size,
              });
            }
          }
        }
        if (buffered) stderr += buffered;
      })();

      const exitCode = await proc.exited;
      uploadsDone = true;
      await progressReader;
      await uploadSegments;
      if (exitCode !== 0) throw new Error(`ffmpeg recording segment failed for ${state.analysis.ingestKey}: ${stderr.trim() || `exit ${exitCode}`}`);
      if (uploadedIndexes.size !== state.chunkKeys.length) throw new Error(`Recording materialization uploaded ${uploadedIndexes.size}/${state.chunkKeys.length} chunks for ${state.analysis.ingestKey}`);
      await progress?.({
        percent: 100,
        stage: "recording-uploaded",
        totalChunks: state.windows.length,
        uploadedChunks: uploadedIndexes.size,
      });

      const startTimeEstimate = await estimateRecordingStartTime({ analysis: state.analysis, bucket });
      const asset = createRecordingAsset({
        analysis: state.analysis,
        chunkDurationSeconds: CHUNK_DURATION_SECONDS,
        chunkKeys: state.chunkKeys,
        recordingId: state.recordingId,
        startTimeEstimate,
      });
      await writeBucketJson(asset.metaKey, asset.meta, bucket);
      await writeBucketJson(asset.manifestKey, asset.manifest, bucket);
      for (const staleChunkKey of state.staleChunkKeys) {
        await deleteStaleChunkArtifacts(bucket, staleChunkKey);
      }
    } finally {
      await lease?.release();
      await rm(tempDir, { force: true, recursive: true });
    }
  },
  name: "recordings",
  async plan({ bucket, inputKey: analysisKey }) {
    const analysis = await readIngestAnalysis(bucket, analysisKey);
    if (!analysis) throw new Error(`Ingest analysis not found: ${analysisKey}`);

    const dependencies = [bucketObject(analysisKey), bucketObject(analysis.ingestKey)];
    if (analysis.media.kind !== "audio" || !analysis.media.hasAudioStream) {
      return { dependencies, outputs: [], state: { analysisKey, materializable: false, reason: `Ingest is ${analysis.media.kind} and hasAudioStream=${analysis.media.hasAudioStream}.` } };
    }

    const durationSeconds = analysis.media.durationSeconds;
    if (durationSeconds === null) {
      return { dependencies, outputs: [], state: { analysisKey, materializable: false, reason: `Ingest has no usable duration: ${analysis.ingestKey}.` } };
    }

    const inputFileName = analysis.originalFileName ?? analysis.ingestKey.split("/").at(-1) ?? "ingest";
    const recordingId = await getRecordingId(analysis.analysisKey);
    const startTimeEstimate = await estimateRecordingStartTime({ analysis, bucket });
    const windows = getChunkWindows(recordingId, new Date(startTimeEstimate.estimatedAt), durationSeconds);
    const chunkKeys = windows.map((window) => window.outputKey);
    const plannedRecordingAsset = createRecordingAsset({ analysis, chunkDurationSeconds: CHUNK_DURATION_SECONDS, chunkKeys, recordingId, startTimeEstimate });
    const previousChunkKeys = await bucket.exists(plannedRecordingAsset.manifestKey)
      ? getManifestChunkKeys(await bucket.readJson<RecordingManifest>(plannedRecordingAsset.manifestKey).catch(() => plannedRecordingAsset.manifest))
      : [];
    const plannedChunkKeys = new Set(chunkKeys);
    const staleChunkKeys = previousChunkKeys.filter((key) => !plannedChunkKeys.has(key));

    return {
      dependencies,
      outputs: [...chunkKeys, plannedRecordingAsset.manifestKey, plannedRecordingAsset.metaKey],
      state: { analysis, analysisKey, chunkKeys, inputFileName, manifestKey: plannedRecordingAsset.manifestKey, materializable: true, recordingId, staleChunkKeys, windows },
    };
  },
  version: "4",
});

if (import.meta.main && Bun.argv[1] === import.meta.path) {
  const bucket = createBucketFromEnv();
  const { force, inputKey } = parseResourceArgs();
  const result = await runResource(recordingsDefinition, { bucket, force, inputKey });
  console.log(JSON.stringify(result.plan.state.materializable ? [result.plan.state.manifestKey] : []));
}
