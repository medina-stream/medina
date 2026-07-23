import { describe, expect, test } from "bun:test";

import { createMemoryBucket } from "../lib/bucket.test";
import { triageKey } from "../lib/orchestration-keys";
import type { TriageResult } from "../lib/triage";
import { claimWork, ensureWork, readWork, workQueuePrefix } from "../lib/work-queue";
import {
  ensureIngestWorkFromTriage,
  executeIngestWork,
  ingestWorkDefinition,
  ingestWorkItemKey,
} from "./ingest-scheduler";

function triage(kind: TriageResult["content"]["kind"], ingestKey: string, disposition: TriageResult["disposition"] = "dispatch"): TriageResult {
  return {
    artifact: { createdAt: "2026-07-17T12:00:00.000Z", key: ingestKey, sizeBytes: 10 },
    classifiedAt: "2026-07-17T12:00:01.000Z",
    content: { confidence: 0.9, eventTime: "2026-07-17T12:00:00.000Z", kind },
    disposition,
    ingestKey,
    labels: [],
    policy: { reasons: [], ruleIds: [] },
    version: 1,
  };
}

describe("audio ingest work routing", () => {
  test("accepts audio and av candidates but rejects retained kinds", async () => {
    const bucket = createMemoryBucket();

    expect(await ensureIngestWorkFromTriage({ bucket, triage: triage("location-point", "in/gps", "retain") })).toBeNull();
    expect(await ensureIngestWorkFromTriage({ bucket, triage: triage("unknown", "in/unknown", "retain") })).toBeNull();
    expect(await ensureIngestWorkFromTriage({ bucket, triage: triage("audio", "in/audio") })).toMatchObject({ inputKey: "in/audio" });
    expect(await ensureIngestWorkFromTriage({ bucket, triage: triage("av-candidate", "in/video") })).toMatchObject({ inputKey: "in/video" });

    expect(await bucket.exists(ingestWorkItemKey("in/gps"))).toBe(false);
    expect(await bucket.exists(ingestWorkItemKey("in/unknown"))).toBe(false);
  });

  test("is deterministic and preserves newest-first ordering", async () => {
    const bucket = createMemoryBucket();
    const recent = triage("audio", "in/recent");
    recent.content.eventTime = "2026-07-17T12:00:00.000Z";
    const newest = triage("audio", "in/newest");
    newest.content.eventTime = "2026-07-17T12:00:01.000Z";

    await ensureIngestWorkFromTriage({ bucket, triage: recent });
    await ensureIngestWorkFromTriage({ bucket, triage: newest });
    await ensureIngestWorkFromTriage({ bucket, triage: newest });

    expect((await bucket.list({ prefix: "work/ingests/" })).contents).toHaveLength(2);
    expect((await claimWork({ bucket, definitionName: ingestWorkDefinition.name, workerId: "test" }))?.inputKey).toBe("in/newest");
    expect((await claimWork({ bucket, definitionName: ingestWorkDefinition.name, workerId: "test" }))?.inputKey).toBe("in/recent");
  });

  test("stale audio work is skipped when durable triage no longer accepts it", async () => {
    const bucket = createMemoryBucket();
    const retained = triage("unknown", "in/reclassified", "retain");
    await bucket.write(triageKey(retained.ingestKey), JSON.stringify(retained), { type: "application/json" });
    await ensureWork({ bucket, definition: ingestWorkDefinition, inputKey: retained.ingestKey });
    const work = await claimWork({ bucket, definitionName: ingestWorkDefinition.name, workerId: "test" });

    await executeIngestWork({
      backend: bucket,
      maxAttempts: 3,
      publishEvent: async () => {},
      work: work!,
    });

    expect(await readWork(bucket, ingestWorkDefinition.name, retained.ingestKey)).toMatchObject({
      result: { skipped: "triage-no-longer-accepts" },
      status: "complete",
    });
  });

  test("duplicate dispatch keeps one pending generation", async () => {
    const bucket = createMemoryBucket();
    const result = triage("audio", "in/audio");
    await ensureIngestWorkFromTriage({ bucket, triage: result });
    await ensureIngestWorkFromTriage({ bucket, triage: result });

    expect(await readWork(bucket, ingestWorkDefinition.name, "in/audio")).toMatchObject({ generation: 1, status: "pending" });
    expect((await bucket.list({ prefix: workQueuePrefix(ingestWorkDefinition.name) })).contents).toHaveLength(1);
  });
});
