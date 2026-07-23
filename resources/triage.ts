#!/usr/bin/env bun

import { basename } from "node:path";

import { artifactRefFromBucket, type ArtifactRef } from "../lib/artifact";
import { normalizeBucketKey, readBucketPrefix, type Bucket } from "../lib/bucket";
import { createBucketFromEnv } from "../lib/bucket-bun";
import { classifyIngest, type TriageContentKind } from "../lib/ingest-classification";
import { getIngestRequestKey, readIngestRequestInfo } from "../lib/ingest";
import { triageKey } from "../lib/orchestration-keys";
import { bucketObject, defineResource, parseResourceArgs, runResource, writeBucketJson } from "../lib/resource";
import type { TriageDisposition, TriageResult } from "../lib/triage";

export type { TriageDisposition, TriageResult } from "../lib/triage";

export type TriageState = {
  outputKey: string;
  result: TriageResult;
};

function normalizeContentType(value: string | null | undefined) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function normalizeIsoTimestamp(value: string | Date | null | undefined) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function policyForKind(kind: TriageContentKind): {
  disposition: TriageDisposition;
  labels: string[];
  reasons: string[];
  ruleIds: string[];
} {
  if (kind === "audio" || kind === "av-candidate") {
    return {
      disposition: "dispatch",
      labels: [kind],
      reasons: [`phase2-${kind}-dispatch`],
      ruleIds: [`triage:phase2:${kind}-dispatch`],
    };
  }
  if (kind === "location-point") {
    return {
      disposition: "dispatch",
      labels: ["gps", "location-point"],
      reasons: ["gps-hour-dispatch"],
      ruleIds: ["triage:gps-hour-dispatch"],
    };
  }
  return {
    disposition: "retain",
    labels: [kind],
    reasons: [`phase2-${kind}-retain`],
    ruleIds: [`triage:phase2:${kind}-retain`],
  };
}

export function getTriageResultKey(ingestKey: string) {
  return triageKey(ingestKey);
}

export async function readTriageResult(bucket: Bucket, ingestKeyOrTriageKey: string): Promise<TriageResult | null> {
  const key = ingestKeyOrTriageKey.startsWith("triage/")
    ? normalizeBucketKey(ingestKeyOrTriageKey)
    : triageKey(ingestKeyOrTriageKey);
  if (!(await bucket.exists(key))) return null;
  return await bucket.readJson<TriageResult>(key);
}

export function createTriageResult(input: {
  artifact: ArtifactRef;
  classifiedAt?: Date | string;
  content: TriageResult["content"];
  duplicateOf?: ArtifactRef;
  ingestKey: string;
}): TriageResult {
  const kindPolicy = policyForKind(input.content.kind);
  const contentType = normalizeContentType(input.content.contentType);
  const eventTime = normalizeIsoTimestamp(input.content.eventTime);
  return {
    artifact: { ...input.artifact, key: normalizeBucketKey(input.artifact.key) },
    classifiedAt: normalizeIsoTimestamp(input.classifiedAt) ?? new Date().toISOString(),
    content: {
      confidence: input.content.confidence,
      ...(contentType ? { contentType } : {}),
      ...(eventTime ? { eventTime } : {}),
      ...(input.content.facts ? { facts: input.content.facts } : {}),
      kind: input.content.kind,
    },
    disposition: kindPolicy.disposition,
    ...(input.duplicateOf ? { duplicateOf: input.duplicateOf } : {}),
    ingestKey: normalizeBucketKey(input.ingestKey),
    labels: kindPolicy.labels,
    policy: { reasons: kindPolicy.reasons, ruleIds: kindPolicy.ruleIds },
    version: 1,
  };
}

export const triageDefinition = defineResource<TriageState>({
  async materialize({ bucket, plan }) {
    await writeBucketJson(plan.state.outputKey, plan.state.result, bucket);
  },
  name: "triage",
  async plan({ artifacts, bucket, inputKey, now }) {
    const ingestKey = normalizeBucketKey(inputKey);
    const [request, stat] = await Promise.all([
      readIngestRequestInfo(bucket, ingestKey),
      bucket.stat(ingestKey),
    ]);
    const contentType = normalizeContentType(request?.type ?? stat.type ?? stat.headers?.["content-type"]);
    const fileName = basename(
      request?.metadata["original-filename"]
        ?? stat.metadata?.["original-filename"]
        ?? ingestKey.split("/").at(-1)
        ?? "ingest",
    );
    const durableArtifact = await artifactRefFromBucket(bucket, ingestKey, { contentType, stat });
    const lease = artifacts ? await artifacts.resolve(durableArtifact) : null;
    let body: ArrayBuffer | undefined;
    try {
      body = lease
        ? await Bun.file(lease.localPath).slice(0, 64 * 1024).arrayBuffer()
        : await readBucketPrefix(bucket, ingestKey, 64 * 1024);
    } finally {
      await lease?.release();
    }
    const classification = classifyIngest({ body, contentType, fileName });
    const resolvedArtifact = lease?.artifact ?? durableArtifact;
    const createdAt = normalizeIsoTimestamp(request?.requestedAt) ?? resolvedArtifact.createdAt ?? stat.lastModified.toISOString();
    const artifact = { ...resolvedArtifact, ...(createdAt ? { createdAt } : {}) };
    const eventTime = classification.kind === "location-point"
      ? classification.facts.eventTime
      : normalizeIsoTimestamp(request?.metadata["created-at"]) ?? normalizeIsoTimestamp(request?.requestedAt);
    const facts = classification.kind === "location-point" ? { ...classification.facts } : undefined;
    const outputKey = triageKey(ingestKey);

    return {
      dependencies: [
        bucketObject(ingestKey),
        bucketObject(getIngestRequestKey(ingestKey)),
      ],
      outputs: [outputKey],
      state: {
        outputKey,
        result: createTriageResult({
          artifact,
          classifiedAt: now,
          content: {
            confidence: classification.confidence,
            ...(contentType ? { contentType } : {}),
            ...(eventTime ? { eventTime } : {}),
            ...(facts ? { facts } : {}),
            kind: classification.kind,
          },
          ingestKey,
        }),
      },
    };
  },
  version: "2",
});

if (import.meta.main) {
  const bucket = createBucketFromEnv();
  const { force, inputKey } = parseResourceArgs();
  const result = await runResource(triageDefinition, { bucket, force, inputKey });
  console.log(JSON.stringify(result.outputs));
}
