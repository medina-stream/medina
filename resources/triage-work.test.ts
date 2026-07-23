import { beforeEach, describe, expect, test } from "bun:test";

import { createMemoryBucket } from "../lib/bucket.test";
import { clearIngestHandlers, dispatchMembershipKey, registerIngestHandler } from "../lib/ingest-handlers";
import { triageKey } from "../lib/orchestration-keys";
import { claimWork } from "../lib/work-queue";
import { ensureIngestWorkFromTriage, ingestWorkDefinition, ingestWorkItemKey } from "./ingest-scheduler";
import { getGpsHourId } from "./gps-hour";
import { ensureGpsHourWork, gpsHourWorkDefinition, gpsHourWorkItemKey } from "./gps-hour-work";
import { readTriageResult } from "./triage";
import {
  ensureTriageWork,
  executeTriageWork,
  reconcileTriageWork,
  triageWorkDefinition,
  triageWorkItemKey,
} from "./triage-work";

beforeEach(() => {
  clearIngestHandlers();
  registerIngestHandler({
    accepts: (result) => result.content.kind === "audio" || result.content.kind === "av-candidate",
    ensureWork: async ({ bucket, membership, now, result }) => await ensureIngestWorkFromTriage({
      bucket,
      now,
      priority: membership.priority,
      triage: result,
    }),
    groupKey: (result) => result.ingestKey,
    inputKey: (result) => result.ingestKey,
    name: "ingests",
    priority: (result) => -new Date(result.content.eventTime ?? result.classifiedAt).getTime(),
    schedule: { mode: "immediate" },
    work: ingestWorkDefinition,
  });
  registerIngestHandler({
    accepts: (result) => result.content.kind === "location-point",
    ensureWork: async ({ bucket, membership, membershipChanged, now }) => await ensureGpsHourWork({
      bucket,
      hourId: membership.groupKey,
      membershipChanged,
      now,
      priority: membership.priority,
    }),
    groupKey: (result) => getGpsHourId(new Date(result.content.eventTime!)),
    inputKey: (result) => getGpsHourId(new Date(result.content.eventTime!)),
    name: "gps-hour",
    priority: (result) => -new Date(result.content.eventTime!).getTime(),
    schedule: { mode: "debounce", delayMs: 60_000, maxDelayMs: 600_000 },
    work: gpsHourWorkDefinition,
  });
});

async function processTriage(bucket: ReturnType<typeof createMemoryBucket>, ingestKey: string) {
  await ensureTriageWork({ bucket, ingestKey });
  const work = await claimWork({ bucket, definitionName: triageWorkDefinition.name, workerId: "test" });
  expect(work?.inputKey).toBe(ingestKey);
  await executeTriageWork({
    backend: bucket,
    maxAttempts: 3,
    publishEvent: async () => {},
    work: work!,
  });
}

describe("triage work orchestration", () => {
  test("retains unknown inputs and routes GPS only to hourly work", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/unknown", "hello=world", { type: "text/plain" });
    await bucket.write("in/gps", "lat=37.1&lon=-122.2&time=2026-07-17T12%3A00%3A00Z", {
      type: "application/x-www-form-urlencoded",
    });

    await processTriage(bucket, "in/unknown");
    await processTriage(bucket, "in/gps");

    expect(await readTriageResult(bucket, "in/unknown")).toMatchObject({ content: { kind: "text" }, disposition: "retain" });
    expect(await readTriageResult(bucket, "in/gps")).toMatchObject({ content: { kind: "location-point" }, disposition: "dispatch" });
    expect((await bucket.list({ prefix: "work/ingests/" })).contents).toHaveLength(0);
    expect(await bucket.exists(gpsHourWorkItemKey("02026071712"))).toBe(true);
    expect((await bucket.list({ prefix: "dispatch-index/gps-hour/" })).contents).toHaveLength(1);
  });

  test("audio writes durable triage, dispatch membership, and ingest work", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/audio", new Uint8Array([0x49, 0x44, 0x33, 0x04]), { type: "application/octet-stream" });

    await processTriage(bucket, "in/audio");

    const result = await readTriageResult(bucket, "in/audio");
    expect(result).toMatchObject({ content: { kind: "audio" }, disposition: "dispatch" });
    const membershipKey = dispatchMembershipKey("ingests", "in/audio", triageKey("in/audio"));
    expect(await bucket.exists(membershipKey)).toBe(true);
    expect(await bucket.exists(ingestWorkItemKey("in/audio"))).toBe(true);
  });

  test("duplicate upload signals repair missing dispatch membership", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/audio", new Uint8Array([0x49, 0x44, 0x33]), { type: "audio/mpeg" });
    await processTriage(bucket, "in/audio");
    const membershipKey = dispatchMembershipKey("ingests", "in/audio", triageKey("in/audio"));
    await bucket.delete(membershipKey);

    await ensureTriageWork({ bucket, ingestKey: "in/audio" });
    expect(await bucket.exists(membershipKey)).toBe(true);
  });

  test("reconciliation repairs missing dispatch membership", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/audio", new Uint8Array([0x49, 0x44, 0x33]), { type: "audio/mpeg" });
    await processTriage(bucket, "in/audio");
    const membershipKey = dispatchMembershipKey("ingests", "in/audio", triageKey("in/audio"));
    await bucket.delete(membershipKey);

    expect(await reconcileTriageWork({ bucket, limit: 10 })).toMatchObject({ dispatchedHandlers: 1, skippedFresh: 1 });
    expect(await bucket.exists(membershipKey)).toBe(true);
  });

  test("duplicate events create one deterministic triage generation", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/audio", new Uint8Array([0x49, 0x44, 0x33]), { type: "audio/mpeg" });

    await ensureTriageWork({ bucket, ingestKey: "in/audio" });
    await ensureTriageWork({ bucket, ingestKey: "in/audio" });

    expect((await bucket.list({ prefix: "work/triage/" })).contents).toHaveLength(1);
    expect(await bucket.readJson(triageWorkItemKey("in/audio"))).toMatchObject({ generation: 1, status: "pending" });
  });

  test("raw reconciliation repairs a lost upload event", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("in/missed", new Uint8Array([0x49, 0x44, 0x33]), { type: "audio/mpeg" });

    expect(await reconcileTriageWork({ bucket, limit: 10 })).toMatchObject({ created: 1, ingestKeys: 1 });
    expect(await bucket.exists(triageWorkItemKey("in/missed"))).toBe(true);
  });
});
