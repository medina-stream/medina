import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMemoryBucket } from "./bucket.test";
import {
  clearIngestHandlers,
  decodeOrchestrationKeySegment,
  dispatchMembershipKey,
  dispatchTriageResult,
  encodeOrchestrationKeySegment,
  registerIngestHandler,
  triageKey,
  type TriageContentKind,
  type TriageDisposition,
  type TriageResult,
} from "./ingest-handlers";
import { ensureWork, readWork, workItemKey } from "./work-queue";

const workDefinition = { name: "ingests", version: "1" } as const;

function createTriageResult(options?: {
  contentKind?: TriageContentKind;
  contentType?: string;
  disposition?: TriageDisposition;
  ingestKey?: string;
}): TriageResult {
  const ingestKey = options?.ingestKey ?? "in/audio-1";
  const contentKind = options?.contentKind ?? "audio";
  const contentType = options?.contentType ?? (contentKind === "audio" ? "audio/mpeg" : "application/octet-stream");
  return {
    artifact: {
      contentType,
      createdAt: "2026-07-17T12:00:00.000Z",
      key: ingestKey,
      sizeBytes: 123,
    },
    classifiedAt: "2026-07-17T12:00:00.000Z",
    content: {
      confidence: 0.95,
      contentType,
      kind: contentKind,
    },
    disposition: options?.disposition ?? "dispatch",
    ingestKey,
    labels: [],
    policy: {
      reasons: [],
      ruleIds: [],
    },
    version: 1,
  };
}

beforeEach(() => {
  clearIngestHandlers();
});

afterEach(() => {
  clearIngestHandlers();
});

describe("ingest handler orchestration keys", () => {
  test("round-trips encoded segments and builds deterministic keys", () => {
    const nested = "triage/in/source-123/clip:01?.m4a";
    const encoded = encodeOrchestrationKeySegment(nested);

    expect(decodeOrchestrationKeySegment(encoded)).toBe(nested);
    expect(triageKey("in/source-123/clip:01?.m4a")).toBe(`triage/${encodeOrchestrationKeySegment("in/source-123/clip:01?.m4a")}.json`);
    expect(dispatchMembershipKey("ingests", "group/clip:01?.m4a", triageKey("in/audio-1"))).toBe(
      `dispatch-index/ingests/${encodeOrchestrationKeySegment("group/clip:01?.m4a")}/${encodeOrchestrationKeySegment(triageKey("in/audio-1"))}.json`,
    );
  });
});

describe("ingest handler registry", () => {
  test("can be reset between tests", async () => {
    registerIngestHandler({
      accepts: () => true,
      async ensureWork() { return null; },
      groupKey: (result) => result.ingestKey,
      inputKey: (result) => result.ingestKey,
      name: "ingests",
      priority: () => 0,
      schedule: { mode: "immediate" },
      work: workDefinition,
    });

    clearIngestHandlers();

    await expect(dispatchTriageResult({
      bucket: createMemoryBucket(),
      result: createTriageResult(),
    })).resolves.toEqual({
      createdMembershipKeys: [],
      matchedHandlers: [],
      workKeys: [],
    });
  });

  test("short-circuits retain triage results before matching handlers", async () => {
    const bucket = createMemoryBucket();
    let matched = 0;
    registerIngestHandler({
      accepts: () => {
        matched += 1;
        return true;
      },
      async ensureWork() { return null; },
      groupKey: (result) => result.ingestKey,
      inputKey: (result) => result.ingestKey,
      name: "ingests",
      priority: () => 0,
      schedule: { mode: "immediate" },
      work: workDefinition,
    });

    const summary = await dispatchTriageResult({
      bucket,
      result: createTriageResult({ contentKind: "unknown", disposition: "retain" }),
    });

    expect(summary).toEqual({ createdMembershipKeys: [], matchedHandlers: [], workKeys: [] });
    expect(matched).toBe(0);
  });
});

describe("dispatchTriageResult", () => {
  test("uses handler accepts declaratively for audio-like triage", async () => {
    const bucket = createMemoryBucket();
    registerIngestHandler({
      accepts: (result) => result.disposition === "dispatch"
        && (result.content.kind === "audio" || result.content.kind === "av-candidate"),
      async ensureWork() { return null; },
      groupKey: (result) => result.ingestKey,
      inputKey: (result) => result.ingestKey,
      name: "ingests",
      priority: () => 0,
      schedule: { mode: "immediate" },
      work: workDefinition,
    });

    expect((await dispatchTriageResult({ bucket, result: createTriageResult({ contentKind: "audio" }) })).matchedHandlers).toEqual(["ingests"]);
    expect((await dispatchTriageResult({ bucket, result: createTriageResult({ contentKind: "av-candidate", ingestKey: "in/video-1" }) })).matchedHandlers).toEqual(["ingests"]);
    expect((await dispatchTriageResult({ bucket, result: createTriageResult({ contentKind: "image", ingestKey: "in/image-1" }) })).matchedHandlers).toEqual([]);
  });

  test("removes stale memberships when triage becomes retained", async () => {
    const bucket = createMemoryBucket();
    registerIngestHandler({
      accepts: (result) => result.content.kind === "audio",
      async ensureWork() { return null; },
      groupKey: (result) => result.ingestKey,
      inputKey: (result) => result.ingestKey,
      name: "ingests",
      priority: () => 0,
      schedule: { mode: "immediate" },
      work: workDefinition,
    });
    const dispatched = createTriageResult();
    const membershipKey = dispatchMembershipKey("ingests", dispatched.ingestKey, triageKey(dispatched.ingestKey));
    await dispatchTriageResult({ bucket, result: dispatched });
    await dispatchTriageResult({
      bucket,
      result: { ...dispatched, disposition: "retain", content: { ...dispatched.content, kind: "unknown" } },
    });

    expect(await bucket.exists(membershipKey)).toBe(false);
  });

  test("writes one deterministic membership and reuses one work item across duplicate dispatches", async () => {
    const bucket = createMemoryBucket();
    const ensureCalls: Array<{ createdAt: string; triageKey: string }> = [];
    registerIngestHandler({
      accepts: (result) => result.disposition === "dispatch"
        && (result.content.kind === "audio" || result.content.kind === "av-candidate"),
      async ensureWork({ bucket: workBucket, membership, now }) {
        ensureCalls.push({ createdAt: membership.createdAt, triageKey: membership.triageKey });
        return await ensureWork({
          bucket: workBucket,
          definition: workDefinition,
          inputKey: membership.inputKey,
          now,
          priority: membership.priority,
        });
      },
      groupKey: (result) => result.ingestKey,
      inputKey: (result) => result.ingestKey,
      name: "ingests",
      priority: () => -123,
      schedule: { mode: "immediate" },
      work: workDefinition,
    });

    const result = createTriageResult();
    const first = await dispatchTriageResult({
      bucket,
      now: new Date("2026-07-17T12:34:56.000Z"),
      result,
    });
    const second = await dispatchTriageResult({
      bucket,
      now: new Date("2026-07-17T12:35:30.000Z"),
      result,
    });

    const expectedTriageKey = triageKey(result.ingestKey);
    const expectedMembershipKey = dispatchMembershipKey("ingests", result.ingestKey, expectedTriageKey);
    const expectedWorkKey = workItemKey(workDefinition.name, result.ingestKey);
    const membership = await bucket.readJson<Record<string, unknown>>(expectedMembershipKey);

    expect(first).toEqual({
      createdMembershipKeys: [expectedMembershipKey],
      matchedHandlers: ["ingests"],
      workKeys: [expectedWorkKey],
    });
    expect(second).toEqual({
      createdMembershipKeys: [],
      matchedHandlers: ["ingests"],
      workKeys: [expectedWorkKey],
    });
    expect(membership).toMatchObject({
      createdAt: "2026-07-17T12:34:56.000Z",
      groupKey: result.ingestKey,
      handler: { name: "ingests", work: workDefinition },
      ingestKey: result.ingestKey,
      inputKey: result.ingestKey,
      priority: -123,
      triageKey: expectedTriageKey,
      version: 1,
    });
    expect(await readWork(bucket, workDefinition.name, result.ingestKey)).toMatchObject({
      definition: workDefinition,
      inputKey: result.ingestKey,
      priority: -123,
      status: "pending",
    });
    expect((await bucket.list({ prefix: "dispatch-index/" })).contents?.map((item) => item.key)).toEqual([expectedMembershipKey]);
    expect(ensureCalls).toEqual([
      { createdAt: "2026-07-17T12:34:56.000Z", triageKey: expectedTriageKey },
      { createdAt: "2026-07-17T12:34:56.000Z", triageKey: expectedTriageKey },
    ]);
  });
});


describe("handler disposition and membership change policy", () => {
  test("membership removal wakes old work before deleting the retry source", async () => {
    const bucket = createMemoryBucket();
    let removalAttempts = 0;
    registerIngestHandler({
      accepts: (result) => result.content.kind === "audio",
      async ensureWork({ result }) {
        if (result.content.kind !== "audio" && ++removalAttempts === 1) throw new Error("temporary wake failure");
        return null;
      },
      groupKey: (result) => result.ingestKey,
      inputKey: (result) => result.ingestKey,
      name: "ingests",
      priority: () => 0,
      schedule: { mode: "immediate" },
      work: workDefinition,
    });
    const audio = createTriageResult();
    const membershipKey = dispatchMembershipKey("ingests", audio.ingestKey, triageKey(audio.ingestKey));
    await dispatchTriageResult({ bucket, result: audio });
    const retained = { ...audio, disposition: "retain" as const, content: { ...audio.content, kind: "unknown" as const } };

    await expect(dispatchTriageResult({ bucket, result: retained })).rejects.toThrow("temporary wake failure");
    expect(await bucket.exists(membershipKey)).toBe(true);
    await dispatchTriageResult({ bucket, result: retained });
    expect(await bucket.exists(membershipKey)).toBe(false);
    expect(removalAttempts).toBe(2);
  });

  test("retained results only reach opted-in handlers and report durable membership changes", async () => {
    const bucket = createMemoryBucket();
    const membershipChanges: boolean[] = [];
    registerIngestHandler({
      accepts: (result) => result.content.kind === "location-point",
      dispositions: ["retain"],
      async ensureWork({ membershipChanged }) {
        membershipChanges.push(membershipChanged);
        return null;
      },
      groupKey: () => "02026071712",
      inputKey: () => "02026071712",
      name: "gps-hour",
      priority: () => 0,
      schedule: { mode: "debounce", delayMs: 60_000, maxDelayMs: 600_000 },
      work: { name: "gps-hour", version: "1" },
    });
    const retained = createTriageResult({ contentKind: "location-point", disposition: "retain", ingestKey: "in/gps" });

    expect((await dispatchTriageResult({ bucket, result: retained })).matchedHandlers).toEqual(["gps-hour"]);
    expect((await dispatchTriageResult({ bucket, result: retained })).matchedHandlers).toEqual(["gps-hour"]);
    expect(membershipChanges).toEqual([true, false]);
  });
});
