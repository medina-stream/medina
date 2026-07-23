import { beforeEach, describe, expect, test } from "bun:test";

import { createMemoryBucket } from "../lib/bucket.test";
import { clearIngestHandlers, dispatchMembershipKey, dispatchTriageResult, registerIngestHandler } from "../lib/ingest-handlers";
import { triageKey } from "../lib/orchestration-keys";
import { getMaterializationFreshness, getMaterializationReceiptKey } from "../lib/resource";
import type { TriageResult } from "../lib/triage";
import { claimWork, completeWork, readWork, workQueuePointerKey } from "../lib/work-queue";
import { createGpsHour, getGpsHourId, getGpsHourKey, gpsHourDefinition, parseGpsHourId } from "./gps-hour";
import {
  ensureGpsHourWork,
  executeGpsHourWork,
  gpsHourDebounceMs,
  gpsHourMaxDelayMs,
  gpsHourWorkDefinition,
  reconcileGpsHourQueue,
} from "./gps-hour-work";
import { runResource } from "../lib/resource";

function point(ingestKey: string, eventTime: string, latitude = 37.1, longitude = -122.2): TriageResult {
  return {
    artifact: { createdAt: eventTime, key: ingestKey },
    classifiedAt: eventTime,
    content: {
      confidence: 1,
      contentType: "application/x-www-form-urlencoded",
      eventTime,
      facts: { eventTime, latitude, longitude, speed: 0 },
      kind: "location-point",
    },
    disposition: "dispatch",
    ingestKey,
    labels: ["gps", "location-point"],
    policy: { reasons: [], ruleIds: [] },
    version: 1,
  };
}

beforeEach(() => {
  clearIngestHandlers();
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
    schedule: { mode: "debounce", delayMs: gpsHourDebounceMs, maxDelayMs: gpsHourMaxDelayMs },
    work: gpsHourWorkDefinition,
  });
});

describe("GPS hour identity", () => {
  test("uses canonical UTC five-digit-year hour IDs", () => {
    expect(getGpsHourId(new Date("2026-07-16T21:34:56.000Z"))).toBe("02026071621");
    expect(parseGpsHourId("gps-hours/02026071621.json")).toMatchObject({
      dayId: "020260716",
      id: "02026071621",
      startTime: new Date("2026-07-16T21:00:00.000Z"),
      endTime: new Date("2026-07-16T22:00:00.000Z"),
    });
    expect(() => parseGpsHourId("02026023112")).toThrow("Invalid GPS hour id");
  });
});

describe("GPS hour dispatch and debounce", () => {
  test("many points in one hour share work while two hours create two work items", async () => {
    const bucket = createMemoryBucket();
    const firstNow = new Date("2026-07-17T12:00:00.000Z");
    await dispatchTriageResult({ bucket, now: firstNow, result: point("in/a", "2026-07-17T12:00:00.000Z") });
    await dispatchTriageResult({ bucket, now: new Date("2026-07-17T12:00:30.000Z"), result: point("in/b", "2026-07-17T12:01:00.000Z") });
    await dispatchTriageResult({ bucket, now: new Date("2026-07-17T12:00:40.000Z"), result: point("in/c", "2026-07-17T13:00:00.000Z") });

    expect((await bucket.list({ prefix: "work/gps-hour/" })).contents).toHaveLength(2);
    expect(await readWork(bucket, gpsHourWorkDefinition.name, "02026071712")).toMatchObject({
      generation: 1,
      status: "pending",
      visibleAt: "2026-07-17T12:01:30.000Z",
    });
  });

  test("queue reconciliation restores a missing GPS-hour pointer", async () => {
    const bucket = createMemoryBucket();
    await dispatchTriageResult({
      bucket,
      now: new Date("2026-07-17T12:00:00.000Z"),
      result: point("in/reconcile", "2026-07-17T12:00:00.000Z"),
    });
    const work = await readWork(bucket, gpsHourWorkDefinition.name, "02026071712");
    await bucket.delete(workQueuePointerKey(work!));

    expect(await reconcileGpsHourQueue(bucket)).toMatchObject({ created: 1 });
    expect(await bucket.exists(workQueuePointerKey(work!))).toBe(true);
  });

  test("duplicate dispatch is idempotent and sustained updates stop at maximum delay", async () => {
    const bucket = createMemoryBucket();
    const first = point("in/a", "2026-07-17T12:00:00.000Z");
    await dispatchTriageResult({ bucket, now: new Date("2026-07-17T12:00:00.000Z"), result: first });
    await dispatchTriageResult({ bucket, now: new Date("2026-07-17T12:00:30.000Z"), result: first });
    expect((await readWork(bucket, gpsHourWorkDefinition.name, "02026071712"))?.visibleAt).toBe("2026-07-17T12:01:00.000Z");

    await dispatchTriageResult({
      bucket,
      now: new Date("2026-07-17T12:09:30.000Z"),
      result: point("in/late-in-burst", "2026-07-17T12:09:30.000Z"),
    });
    expect((await readWork(bucket, gpsHourWorkDefinition.name, "02026071712"))?.visibleAt).toBe("2026-07-17T12:10:00.000Z");
  });

  test("moving a point to another hour wakes both old and new groups", async () => {
    const bucket = createMemoryBucket();
    await dispatchTriageResult({
      bucket,
      now: new Date("2026-07-17T12:00:00.000Z"),
      result: point("in/moved", "2026-07-17T12:00:00.000Z"),
    });
    const claimed = await claimWork({
      bucket,
      definitionName: gpsHourWorkDefinition.name,
      now: new Date("2026-07-17T12:01:00.000Z"),
      tokenFactory: () => "old-hour-lease",
      workerId: "test",
    });
    await completeWork({ bucket, now: new Date("2026-07-17T12:01:10.000Z"), work: claimed! });

    await dispatchTriageResult({
      bucket,
      now: new Date("2026-07-17T13:00:00.000Z"),
      result: point("in/moved", "2026-07-17T13:00:00.000Z"),
    });

    expect(await readWork(bucket, gpsHourWorkDefinition.name, "02026071712")).toMatchObject({ generation: 2, status: "pending" });
    expect(await readWork(bucket, gpsHourWorkDefinition.name, "02026071713")).toMatchObject({ generation: 1, status: "pending" });
    expect(await bucket.exists(dispatchMembershipKey("gps-hour", "02026071712", triageKey("in/moved")))).toBe(false);
  });

  test("updates during execution request a rerun without extending the maximum delay", async () => {
    const bucket = createMemoryBucket();
    await dispatchTriageResult({
      bucket,
      now: new Date("2026-07-17T12:00:00.000Z"),
      result: point("in/a", "2026-07-17T12:00:00.000Z"),
    });
    const claimed = await claimWork({
      bucket,
      definitionName: gpsHourWorkDefinition.name,
      now: new Date("2026-07-17T12:01:00.000Z"),
      tokenFactory: () => "running-gps-lease",
      workerId: "test",
    });
    await dispatchTriageResult({
      bucket,
      now: new Date("2026-07-17T12:09:30.000Z"),
      result: point("in/during-run", "2026-07-17T12:09:30.000Z"),
    });

    const completed = await completeWork({ bucket, now: new Date("2026-07-17T12:09:40.000Z"), work: claimed! });
    expect(completed).toMatchObject({
      generation: 2,
      status: "pending",
      visibleAt: "2026-07-17T12:10:00.000Z",
    });
  });

  test("a late point reopens a completed hour generation", async () => {
    const bucket = createMemoryBucket();
    await dispatchTriageResult({
      bucket,
      now: new Date("2026-07-17T12:00:00.000Z"),
      result: point("in/a", "2026-07-17T12:00:00.000Z"),
    });
    const claimed = await claimWork({
      bucket,
      definitionName: gpsHourWorkDefinition.name,
      now: new Date("2026-07-17T12:01:00.000Z"),
      tokenFactory: () => "gps-lease",
      workerId: "test",
    });
    await completeWork({ bucket, now: new Date("2026-07-17T12:01:10.000Z"), work: claimed! });

    await dispatchTriageResult({
      bucket,
      now: new Date("2026-07-17T12:15:00.000Z"),
      result: point("in/late", "2026-07-17T12:30:00.000Z"),
    });
    expect(await readWork(bucket, gpsHourWorkDefinition.name, "02026071712")).toMatchObject({
      generation: 2,
      status: "pending",
      visibleAt: "2026-07-17T12:16:00.000Z",
    });
  });
});

describe("GPS hour resource", () => {
  test("the work executor commits an hourly resource and completes work", async () => {
    const bucket = createMemoryBucket();
    await dispatchTriageResult({
      bucket,
      now: new Date("2026-07-17T12:00:00.000Z"),
      result: point("in/executor", "2026-07-17T12:00:00.000Z"),
    });
    const work = await claimWork({
      bucket,
      definitionName: gpsHourWorkDefinition.name,
      now: new Date("2026-07-17T12:01:00.000Z"),
      tokenFactory: () => "executor-lease",
      workerId: "test",
    });
    const events: Record<string, unknown>[] = [];

    await executeGpsHourWork({
      backend: bucket,
      maxAttempts: 3,
      publishEvent: async (event) => { events.push(event); },
      work: work!,
    });

    expect(await bucket.exists(getGpsHourKey("02026071712"))).toBe(true);
    expect(await readWork(bucket, gpsHourWorkDefinition.name, "02026071712")).toMatchObject({ status: "complete" });
    expect(events).toEqual([expect.objectContaining({ hourId: "02026071712", rawCount: 1, type: "gps-hour.completed" })]);
  });

  test("materializes stable counts, bounds, and collapsed points from bounded memberships", async () => {
    const bucket = createMemoryBucket();
    const points = [
      point("in/a", "2026-07-17T12:00:00.000Z"),
      point("in/duplicate", "2026-07-17T12:00:00.000Z"),
      point("in/jitter", "2026-07-17T12:01:00.000Z", 37.10001, -122.20001),
      point("in/far", "2026-07-17T12:02:00.000Z", 37.2, -122.2),
    ];
    for (const [index, result] of points.entries()) {
      await dispatchTriageResult({ bucket, now: new Date(`2026-07-17T12:00:0${index}.000Z`), result });
    }

    const run = await runResource(gpsHourDefinition, {
      bucket,
      inputKey: "02026071712",
      now: new Date("2026-07-17T12:10:00.000Z"),
    });
    const hour = await bucket.readJson(getGpsHourKey("02026071712"));

    expect(run.plan.dependencies).toHaveLength(4);
    expect(hour).toEqual(createGpsHour("02026071712", [
      { ingestKey: "in/a", latitude: 37.1, longitude: -122.2, speed: 0, time: "2026-07-17T12:00:00.000Z" },
      { ingestKey: "in/duplicate", latitude: 37.1, longitude: -122.2, speed: 0, time: "2026-07-17T12:00:00.000Z" },
      { ingestKey: "in/jitter", latitude: 37.10001, longitude: -122.20001, speed: 0, time: "2026-07-17T12:01:00.000Z" },
      { ingestKey: "in/far", latitude: 37.2, longitude: -122.2, speed: 0, time: "2026-07-17T12:02:00.000Z" },
    ]));
    expect(hour).toMatchObject({ rawCount: 4, deduplicatedCount: 3, duplicateCount: 1, collapsedCount: 2 });
  });

  test("annotates each point with its own timezone across mixed-zone travel", () => {
    const hour = createGpsHour("02026071712", [
      { ingestKey: "in/sf", latitude: 37.7749, longitude: -122.4194, speed: 0, time: "2026-07-17T12:00:00.000Z" },
      { ingestKey: "in/nyc", latitude: 40.7128, longitude: -74.006, speed: 250, time: "2026-07-17T12:40:00.000Z" },
    ]);

    expect(hour.deduplicatedPoints).toMatchObject([
      { ingestKey: "in/sf", timeZone: "America/Los_Angeles", timeZoneSource: "gps" },
      { ingestKey: "in/nyc", timeZone: "America/New_York", timeZoneSource: "gps" },
    ]);
    expect(hour.collapsedPoints).toMatchObject([
      { ingestKey: "in/sf", timeZone: "America/Los_Angeles", timeZoneSource: "gps" },
      { ingestKey: "in/nyc", timeZone: "America/New_York", timeZoneSource: "gps" },
    ]);
  });

  test("carries forward the previous timezone when lookup fails", () => {
    const hour = createGpsHour("02026071712", [
      { ingestKey: "in/sf", latitude: 37.7749, longitude: -122.4194, speed: 0, time: "2026-07-17T12:00:00.000Z" },
      { ingestKey: "in/invalid", latitude: 999, longitude: -122.4194, speed: 0, time: "2026-07-17T12:10:00.000Z" },
    ]);

    expect(hour.deduplicatedPoints).toMatchObject([
      { ingestKey: "in/sf", timeZone: "America/Los_Angeles", timeZoneSource: "gps" },
      { ingestKey: "in/invalid", timeZone: "America/Los_Angeles", timeZoneSource: "carry-forward" },
    ]);
  });

  test("uses version 3 and older receipts become stale", async () => {
    const bucket = createMemoryBucket();
    const outputKey = getGpsHourKey("02026071712");
    const run = await runResource(gpsHourDefinition, {
      bucket,
      inputKey: "02026071712",
      now: new Date("2026-07-17T12:10:00.000Z"),
    });
    const receipt = await bucket.readJson<{
      definition: { name: string; version: string };
      dependencies: [];
      dependencySetHash: string;
      materializedAt: string;
    }>(getMaterializationReceiptKey(outputKey));

    expect(run.plan.state.hour.version).toBe(3);
    expect(gpsHourDefinition.version).toBe("3");
    expect(getMaterializationFreshness({
      currentDependencies: run.dependencies,
      currentDependencySetHash: receipt.dependencySetHash,
      definition: { name: gpsHourDefinition.name, version: "2" },
      outputExists: true,
      receipt,
    })).toEqual({ fresh: false, reason: "definition-changed" });
  });


});
