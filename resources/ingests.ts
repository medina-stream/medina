#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { artifactRefFromBucket } from "../lib/artifact";
import { createBucketFromEnv } from "../lib/bucket-bun";
import { getIngestRequestKey, readIngestRequestInfo, type IngestRequestInfo } from "../lib/ingest";
import {
  bucketObject,
  defineResource,
  fetchBucketObjectToTempFile,
  parseResourceArgs,
  runResource,
  writeBucketJson,
} from "../lib/resource";
import { createIngestAnalysis, getIngestAnalysisKey, probeIngest } from "./ingest";

type IngestsState = {
  analysisKey: string;
  contentType: string | null;
  ingestKey: string;
  ingestRequest: IngestRequestInfo | null;
  ingestedAt: string;
  inputFileName: string;
  metadata: Record<string, string>;
  sizeBytes: number;
  type: string | null;
};

export const ingestsDefinition = defineResource<IngestsState>({
  async materialize({ artifacts, bucket, plan }) {
    const tempDir = artifacts ? null : await mkdtemp(join(tmpdir(), "medina-ingest-"));
    const lease = artifacts
      ? await artifacts.resolve(await artifactRefFromBucket(bucket, plan.state.ingestKey))
      : null;

    try {
      const inputPath = lease?.localPath ?? await fetchBucketObjectToTempFile(plan.state.ingestKey, plan.state.inputFileName, {
        bucket,
        tempDir: tempDir!,
      });
      const probe = await probeIngest(inputPath);
      const analysis = createIngestAnalysis({
        contentType: plan.state.contentType,
        ingestKey: plan.state.ingestKey,
        ingestedAt: plan.state.ingestedAt,
        metadata: plan.state.metadata,
        originalFileName: plan.state.inputFileName,
        probe,
        sizeBytes: plan.state.sizeBytes,
        type: plan.state.type,
      });

      await writeBucketJson(plan.state.analysisKey, analysis, bucket);
    } finally {
      await lease?.release();
      if (tempDir) await rm(tempDir, { force: true, recursive: true });
    }
  },
  name: "ingests",
  async plan({ bucket, inputKey: ingestKey }) {
    const dependencies = [
      bucketObject(ingestKey),
      bucketObject(getIngestRequestKey(ingestKey)),
    ];
    const ingestObject = await bucket.stat(ingestKey);
    const ingestRequest = await readIngestRequestInfo(bucket, ingestKey);
    const ingestedAt = ingestObject.lastModified.toISOString();
    const metadata = ingestRequest?.metadata ?? ingestObject.metadata ?? {};
    const inputFileName = ingestObject.metadata?.["original-filename"]
      ?? ingestRequest?.metadata?.["original-filename"]
      ?? ingestKey.split("/").at(-1)
      ?? "ingest";
    const analysisKey = getIngestAnalysisKey(ingestKey, ingestedAt);

    return {
      state: {
        analysisKey,
        contentType: ingestObject.type ?? ingestRequest?.type ?? null,
        ingestKey,
        ingestRequest,
        ingestedAt,
        inputFileName,
        metadata,
        sizeBytes: ingestObject.size,
        type: ingestRequest?.type ?? ingestObject.type ?? null,
      },
      dependencies,
      outputs: [analysisKey],
    };
  },
  version: "1",
});

if (import.meta.main) {
  const bucket = createBucketFromEnv();
  const { force, inputKey } = parseResourceArgs();
  const result = await runResource(ingestsDefinition, {
    bucket,
    force,
    inputKey,
  });

  console.log(JSON.stringify([result.plan.state.analysisKey]));
}
