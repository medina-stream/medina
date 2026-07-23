#!/usr/bin/env bun

import { hostname } from "node:os";

import { createArtifactResolver } from "../lib/artifact-bun";
import type { Bucket } from "../lib/bucket";
import { createBucketFromEnv } from "../lib/bucket-bun";
import { createEvent } from "../lib/event";
import { onResourceWarning } from "../lib/resource";
import { ensureSourcesMigrated } from "../lib/source";
import { listWorkExecutors, registerWorkExecutor } from "../lib/work-executors";
import { claimWork } from "../lib/work-queue";
import {
  executeIngestWork,
  getIngestWorkLeaseMs,
  ingestWorkDefinition,
  reconcileIngestWorkQueue,
} from "../resources/ingest-scheduler";
import { syncAllSources } from "../resources/source";
import {
  executeSourceFetchWork,
  reconcileSourceFetchQueue,
  sourceFetchWorkDefinition,
} from "../resources/source-fetch";
import {
  executeGpsHourWork,
  gpsHourWorkDefinition,
  reconcileGpsHourQueue,
} from "../resources/gps-hour-work";
import "../resources/source-filesystem";
import "../resources/source-gdrive";
import "../resources/triage-handler-audio";
import "../resources/triage-handler-gps-hour";
import {
  executeTranscriptWork,
  reconcileTranscriptQueue,
  reconcileTranscriptWork,
  transcriptWorkDefinition,
} from "../resources/transcript-work";
import {
  executeTriageWork,
  reconcileTriageQueue,
  reconcileTriageWork,
  triageWorkDefinition,
} from "../resources/triage-work";

function usage() {
  console.error(`Usage:
  bun scripts/ingest-worker.ts [--once] [--discover-only] [--limit <n>] [--concurrency <n>] [--max-attempts <n>]

Environment:
  INGEST_WORKER_LIMIT                Work items to process per pass. Default: 100
  INGEST_WORKER_INTERVAL_MS          Continuous loop sleep. Default: 30000
  INGEST_WORKER_CONCURRENCY          Parallel work limit. Default: nproc
  INGEST_WORKER_DISCOVERY_LIMIT      Triage work items created per pass. Default: 10
  INGEST_WORKER_DISCOVERY_SCAN_LIMIT Raw ingest objects scanned per pass. Default: 500
  TRANSCRIPT_DISCOVERY_LIMIT         Transcript work items created per pass. Default: 100
  TRANSCRIPT_DISCOVERY_SCAN_LIMIT    Recording objects scanned per pass. Default: 500
  TRANSCRIPT_MAX_AGE_DAYS            Skip transcribing chunks older than this. Default: 4 (0 disables)
  SOURCE_SYNC_INTERVAL_MS            Source polling interval. Default: 300000
`);
}

function parseArgs(argv: string[]) {
  let once = false;
  let discoverOnly = false;
  let limit = Number(process.env.INGEST_WORKER_LIMIT ?? "100");
  let concurrency = Number(process.env.INGEST_WORKER_CONCURRENCY ?? "0");
  let maxAttempts = 5;
  const discoveryLimit = Number(process.env.INGEST_WORKER_DISCOVERY_LIMIT ?? "10");
  const discoveryScanLimit = Number(process.env.INGEST_WORKER_DISCOVERY_SCAN_LIMIT ?? "500");
  const transcriptDiscoveryLimit = Number(process.env.TRANSCRIPT_DISCOVERY_LIMIT ?? "100");
  const transcriptDiscoveryScanLimit = Number(process.env.TRANSCRIPT_DISCOVERY_SCAN_LIMIT ?? "500");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--once": once = true; break;
      case "--discover-only": discoverOnly = true; break;
      case "--limit": limit = Number(argv[++i] ?? ""); break;
      case "--concurrency": concurrency = Number(argv[++i] ?? ""); break;
      case "--max-attempts": maxAttempts = Number(argv[++i] ?? ""); break;
      case "-h":
      case "--help": usage(); process.exit(0);
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(limit) || limit < 1) throw new Error("--limit must be a positive number");
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) throw new Error("--max-attempts must be a positive number");
  if (!Number.isFinite(discoveryLimit) || discoveryLimit < 0) throw new Error("INGEST_WORKER_DISCOVERY_LIMIT must be non-negative");
  if (!Number.isFinite(discoveryScanLimit) || discoveryScanLimit < 1) throw new Error("INGEST_WORKER_DISCOVERY_SCAN_LIMIT must be positive");
  if (!Number.isFinite(transcriptDiscoveryLimit) || transcriptDiscoveryLimit < 0) throw new Error("TRANSCRIPT_DISCOVERY_LIMIT must be non-negative");
  if (!Number.isFinite(transcriptDiscoveryScanLimit) || transcriptDiscoveryScanLimit < 1) throw new Error("TRANSCRIPT_DISCOVERY_SCAN_LIMIT must be positive");
  if (!Number.isFinite(concurrency) || concurrency < 0) concurrency = 0;
  if (concurrency === 0) concurrency = typeof navigator?.hardwareConcurrency === "number" ? navigator.hardwareConcurrency : 2;

  return {
    concurrency: Math.max(1, Math.trunc(concurrency)),
    discoverOnly,
    discoveryLimit: Math.trunc(discoveryLimit),
    discoveryScanLimit: Math.trunc(discoveryScanLimit),
    limit: Math.trunc(limit),
    maxAttempts: Math.trunc(maxAttempts),
    once,
    transcriptDiscoveryLimit: Math.trunc(transcriptDiscoveryLimit),
    transcriptDiscoveryScanLimit: Math.trunc(transcriptDiscoveryScanLimit),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const workerId = process.env.MEDINA_WORKER_ID?.trim() || `${hostname()}:${process.pid}`;

onResourceWarning(({ definition, inputKey, warning }) => {
  void publishWorkerEvent({
    code: warning.code,
    inputKey,
    message: warning.message,
    resource: definition.name,
    type: "resource.degraded",
  });
});

function getMedinaBaseUrl() {
  return process.env.MEDINA_EVENT_BASE_URL
    || process.env.MEDINA_SYNC_BASE_URL
    || `http://127.0.0.1:${process.env.PORT || "3002"}`;
}

async function publishWorkerEvent(data: Record<string, unknown>) {
  const token = process.env.MEDINA_TOKEN;
  try {
    const response = await fetch(`${getMedinaBaseUrl()}/events`, {
      body: JSON.stringify(data),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      method: "POST",
    });
    if (response.ok) return;
    throw new Error(`HTTP ${response.status} ${await response.text()}`);
  } catch (error) {
    createEvent(data);
    console.warn(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      event: "worker-event-local-fallback",
    }));
  }
}

registerWorkExecutor({
  claimOrder: 0,
  execute: executeTriageWork,
  work: triageWorkDefinition,
});
registerWorkExecutor({
  claimOrder: 3,
  execute: executeSourceFetchWork,
  work: sourceFetchWorkDefinition,
});
registerWorkExecutor({
  claimOrder: 5,
  execute: executeGpsHourWork,
  work: gpsHourWorkDefinition,
});
registerWorkExecutor({
  claimOrder: 10,
  execute: executeIngestWork,
  work: ingestWorkDefinition,
});
registerWorkExecutor({
  claimOrder: 20,
  execute: executeTranscriptWork,
  work: transcriptWorkDefinition,
});

async function claimNextWork(bucket: Bucket, startIndex: number) {
  const executors = listWorkExecutors();
  for (let offset = 0; offset < executors.length; offset += 1) {
    const executor = executors[(startIndex + offset) % executors.length]!;
    const work = await claimWork({
      bucket,
      definitionName: executor.work.name,
      leaseMs: executor.work.name === ingestWorkDefinition.name ? getIngestWorkLeaseMs() : 60 * 60 * 1000,
      workerId,
    });
    if (work) return { executor, work };
  }
  return null;
}

async function runPass(options: ReturnType<typeof parseArgs>) {
  const bucket = createBucketFromEnv();
  const artifacts = createArtifactResolver({ bucket, workerId });
  const discovered = await reconcileTriageWork({
    bucket,
    limit: options.discoveryLimit,
    scanLimit: options.discoveryScanLimit,
  });
  console.log(JSON.stringify({ event: "triage-discovery", ...discovered }));
  const transcripts = await reconcileTranscriptWork({
    bucket,
    limit: options.transcriptDiscoveryLimit,
    scanLimit: options.transcriptDiscoveryScanLimit,
  });
  console.log(JSON.stringify({ event: "transcript-discovery", ...transcripts }));
  if (options.discoverOnly) return { processed: 0 };

  let claimIndex = 0;
  let processed = 0;
  let reconciled = false;
  const active = new Set<Promise<boolean>>();
  while (processed < options.limit) {
    while (active.size < options.concurrency) {
      const claimed = await claimNextWork(bucket, claimIndex);
      if (!claimed) break;
      claimIndex = (claimIndex + 1) % Math.max(1, listWorkExecutors().length);
      const promise = claimed.executor.execute({
        artifacts,
        backend: bucket,
        maxAttempts: options.maxAttempts,
        publishEvent: publishWorkerEvent,
        work: claimed.work,
      }).catch((error) => {
        console.error(JSON.stringify({
          definition: claimed.work.definition.name,
          error: error instanceof Error ? error.message : String(error),
          event: "work-executor-error",
          inputKey: claimed.work.inputKey,
        }));
        return true;
      }).then((didProcess) => {
        active.delete(promise);
        return didProcess;
      });
      active.add(promise);
    }

    if (active.size === 0) {
      if (!reconciled) {
        const [triage, gpsHours, ingests, transcripts, sourceFetches] = await Promise.all([
          reconcileTriageQueue(bucket),
          reconcileGpsHourQueue(bucket),
          reconcileIngestWorkQueue(bucket),
          reconcileTranscriptQueue(bucket),
          reconcileSourceFetchQueue(bucket),
        ]);
        console.log(JSON.stringify({ event: "work-reconciliation", gpsHours, ingests, sourceFetches, transcripts, triage }));
        reconciled = true;
        if (triage.created > 0 || gpsHours.created > 0 || ingests.created > 0 || transcripts.created > 0 || sourceFetches.created > 0) continue;
      }
      break;
    }

    const didProcess = await Promise.race([...active]);
    if (didProcess) processed += 1;
  }

  if (active.size > 0) await Promise.all([...active]);
  return { processed };
}

async function runSourcePass() {
  const bucket = createBucketFromEnv();
  await ensureSourcesMigrated(bucket);
  try {
    const results = await syncAllSources({ bucket });
    for (const result of results) {
      if (!result.summary) continue;
      console.log(JSON.stringify({ event: "source-sync", ...result, summary: result.summary }));
      await publishWorkerEvent({
        sourceId: result.sourceId,
        sourceType: result.type,
        summary: result.summary,
        type: "source.sync.completed",
      });
    }
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      event: "source-sync-error",
    }));
  }
}

const options = parseArgs(process.argv.slice(2));
const intervalMs = Number(process.env.INGEST_WORKER_INTERVAL_MS ?? "30000");
const sourceIntervalMs = Number(process.env.SOURCE_SYNC_INTERVAL_MS ?? "300000");

if (options.once) {
  await runSourcePass();
  console.log(JSON.stringify({ event: "ingest-worker-once", ...await runPass(options) }));
} else {
  void (async () => {
    while (true) {
      await runSourcePass();
      await sleep(Number.isFinite(sourceIntervalMs) && sourceIntervalMs > 0 ? sourceIntervalMs : 300000);
    }
  })();
  while (true) {
    console.log(JSON.stringify({ event: "ingest-worker-pass", ...await runPass(options) }));
    await sleep(Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30000);
  }
}
