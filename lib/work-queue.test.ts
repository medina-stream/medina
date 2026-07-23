import { describe, expect, test } from "bun:test";

import { createMemoryBucket } from "./bucket.test";
import {
  claimWork,
  completeWork,
  decodeWorkKeySegment,
  encodeWorkKeySegment,
  ensureWork,
  failWork,
  readWork,
  rebuildWorkQueuePointers,
  workItemKey,
  workQueuePointerKey,
  type WorkItem,
} from "./work-queue";

function at(value: string) {
  return new Date(value);
}

describe("work queue keys", () => {
  test("encode/decode are deterministic and reversible under work prefixes", () => {
    const definitionName = "triage/audio";
    const inputKey = "in/source-1/clip:01?.m4a";
    const encoded = encodeWorkKeySegment(inputKey);

    expect(encoded).toBe(encodeWorkKeySegment(inputKey));
    expect(decodeWorkKeySegment(encoded)).toBe(inputKey);
    expect(workItemKey(definitionName, inputKey)).toBe(`work/${definitionName}/${encoded}.json`);

    const queueKey = workQueuePointerKey({
      attempts: 0,
      createdAt: "2026-07-17T12:00:00.000Z",
      definition: { name: definitionName, version: "v1" },
      generation: 1,
      inputKey,
      priority: -100,
      status: "pending",
      updatedAt: "2026-07-17T12:00:00.000Z",
      visibleAt: "2026-07-17T12:00:00.000Z",
    } satisfies WorkItem);

    expect(queueKey.startsWith(`work-queue/${definitionName}/`)).toBe(true);
    expect(queueKey.endsWith(`-${encoded}.json`)).toBe(true);
  });
});

describe("ensureWork and claimWork", () => {
  test("ensureWork creates pending work and claimWork returns highest priority visible work", async () => {
    const bucket = createMemoryBucket();
    const definition = { name: "triage/audio", version: "v1" };
    const now = at("2026-07-17T12:00:00.000Z");

    await ensureWork({ bucket, definition, inputKey: "in/lower", now, priority: 20 });
    await ensureWork({ bucket, definition, inputKey: "in/higher", now, priority: -20 });

    const claimed = await claimWork({
      bucket,
      definitionName: definition.name,
      now,
      tokenFactory: () => "lease-1",
      workerId: "worker-1",
    });

    expect(claimed).toMatchObject({
      attempts: 1,
      inputKey: "in/higher",
      leaseToken: "lease-1",
      priority: -20,
      status: "running",
      workerId: "worker-1",
    });
    expect(claimed?.leaseExpiresAt).toBe("2026-07-17T13:00:00.000Z");
  });

  test("deferred and leased work do not hide ready work", async () => {
    const bucket = createMemoryBucket();
    const definition = { name: "triage/audio", version: "v1" };
    const now = at("2026-07-17T12:00:00.000Z");

    await ensureWork({
      bucket,
      definition,
      inputKey: "in/deferred",
      now,
      priority: -100,
      visibleAt: "2026-07-17T13:00:00.000Z",
    });
    await ensureWork({ bucket, definition, inputKey: "in/leased", now, priority: -50 });
    await claimWork({
      bucket,
      definitionName: definition.name,
      now,
      tokenFactory: () => "leased-token",
      workerId: "worker-1",
    });
    await ensureWork({ bucket, definition, inputKey: "in/ready", now, priority: 10 });

    expect((await claimWork({
      bucket,
      definitionName: definition.name,
      now,
      tokenFactory: () => "ready-token",
      workerId: "worker-1",
    }))?.inputKey).toBe("in/ready");
  });

  test("running work reopens after completion when a rerun is requested", async () => {
    const bucket = createMemoryBucket();
    const definition = { name: "gps-hour", version: "v1" };
    await ensureWork({ bucket, definition, inputKey: "02026071712", now: at("2026-07-17T12:00:00.000Z") });
    const claimed = await claimWork({
      bucket,
      definitionName: definition.name,
      now: at("2026-07-17T12:00:00.000Z"),
      tokenFactory: () => "running-rerun",
      workerId: "worker",
    });
    await ensureWork({
      bucket,
      definition,
      inputKey: "02026071712",
      now: at("2026-07-17T12:00:30.000Z"),
      rerunRunning: true,
      visibleAt: "2026-07-17T12:01:30.000Z",
    });

    const completed = await completeWork({ bucket, now: at("2026-07-17T12:00:45.000Z"), work: claimed! });
    expect(completed).toMatchObject({ generation: 2, status: "pending", visibleAt: "2026-07-17T12:01:30.000Z" });
    expect(completed.history).toEqual([expect.objectContaining({ generation: 1, status: "complete" })]);
  });

  test("ensureWork tightens live work and reopens completed work with a new generation", async () => {
    const bucket = createMemoryBucket();
    const definition = { name: "triage/audio", version: "v1" };

    const first = await ensureWork({
      bucket,
      definition,
      inputKey: "in/example",
      now: at("2026-07-17T12:00:00.000Z"),
      priority: 10,
      visibleAt: "2026-07-17T12:10:00.000Z",
    });
    const tightened = await ensureWork({
      bucket,
      definition,
      inputKey: "in/example",
      now: at("2026-07-17T12:01:00.000Z"),
      priority: -5,
      visibleAt: "2026-07-17T12:05:00.000Z",
    });

    expect(first.generation).toBe(1);
    expect(tightened.generation).toBe(1);
    expect(tightened.priority).toBe(-5);
    expect(tightened.visibleAt).toBe("2026-07-17T12:05:00.000Z");

    const claimed = await claimWork({
      bucket,
      definitionName: definition.name,
      now: at("2026-07-17T12:05:00.000Z"),
      tokenFactory: () => "lease-2",
      workerId: "worker-2",
    });
    const completed = await completeWork({ bucket, now: at("2026-07-17T12:06:00.000Z"), work: claimed! });
    const unchanged = await ensureWork({
      bucket,
      definition,
      inputKey: "in/example",
      now: at("2026-07-17T12:06:30.000Z"),
      priority: 0,
    });
    const reopened = await ensureWork({
      bucket,
      definition,
      inputKey: "in/example",
      now: at("2026-07-17T12:07:00.000Z"),
      priority: 0,
      reopenComplete: true,
    });

    expect(completed.status).toBe("complete");
    expect(unchanged).toMatchObject({ generation: 1, status: "complete" });
    expect(reopened.status).toBe("pending");
    expect(reopened.generation).toBe(2);
    expect(reopened.attempts).toBe(0);
    expect(reopened.history).toEqual([expect.objectContaining({
      attempts: 1,
      generation: 1,
      status: "complete",
    })]);
  });
});

describe("failWork", () => {
  test("failWork applies retry backoff and eventually marks work failed", async () => {
    const bucket = createMemoryBucket();
    const definition = { name: "triage/audio", version: "v1" };

    await ensureWork({ bucket, definition, inputKey: "in/retry", now: at("2026-07-17T12:00:00.000Z"), priority: 0 });

    const firstClaim = await claimWork({
      bucket,
      definitionName: definition.name,
      now: at("2026-07-17T12:00:00.000Z"),
      tokenFactory: () => "lease-3",
      workerId: "worker-3",
    });
    const firstFailure = await failWork({
      bucket,
      error: new Error("boom"),
      maxAttempts: 2,
      now: at("2026-07-17T12:00:00.000Z"),
      work: firstClaim!,
    });

    expect(firstFailure.status).toBe("pending");
    expect(firstFailure.attempts).toBe(1);
    expect(firstFailure.lastError).toBe("boom");
    expect(firstFailure.visibleAt).toBe("2026-07-17T12:01:00.000Z");
    expect(await claimWork({ bucket, definitionName: definition.name, now: at("2026-07-17T12:00:59.000Z"), workerId: "worker-3" })).toBeNull();

    const secondClaim = await claimWork({
      bucket,
      definitionName: definition.name,
      now: at("2026-07-17T12:01:00.000Z"),
      tokenFactory: () => "lease-4",
      workerId: "worker-3",
    });
    const secondFailure = await failWork({
      bucket,
      error: "still broken",
      maxAttempts: 2,
      now: at("2026-07-17T12:01:00.000Z"),
      work: secondClaim!,
    });

    expect(secondClaim?.attempts).toBe(2);
    expect(secondFailure.status).toBe("failed");
    expect(secondFailure.lastError).toBe("still broken");
    expect(await bucket.exists(workQueuePointerKey(secondFailure))).toBe(false);
  });

  test("failed work stays terminal unless explicitly reopened", async () => {
    const bucket = createMemoryBucket();
    const definition = { name: "triage/audio", version: "v1" };

    await ensureWork({ bucket, definition, inputKey: "in/terminal", now: at("2026-07-17T12:00:00.000Z") });
    const claim = await claimWork({
      bucket,
      definitionName: definition.name,
      now: at("2026-07-17T12:00:00.000Z"),
      tokenFactory: () => "lease-5",
      workerId: "worker-4",
    });
    await failWork({
      bucket,
      error: "done",
      maxAttempts: 1,
      now: at("2026-07-17T12:00:00.000Z"),
      work: claim!,
    });

    const unchanged = await ensureWork({
      bucket,
      definition,
      inputKey: "in/terminal",
      now: at("2026-07-17T12:01:00.000Z"),
      priority: -10,
    });
    const reopened = await ensureWork({
      bucket,
      definition,
      inputKey: "in/terminal",
      now: at("2026-07-17T12:02:00.000Z"),
      priority: -10,
      reopenFailed: true,
    });

    expect(unchanged.status).toBe("failed");
    expect(reopened.status).toBe("pending");
    expect(reopened.generation).toBe(2);
  });
});

describe("lease validation and reconciliation", () => {
  test("completeWork and failWork validate lease token and generation", async () => {
    const bucket = createMemoryBucket();
    const definition = { name: "triage/audio", version: "v1" };

    await ensureWork({ bucket, definition, inputKey: "in/validate", now: at("2026-07-17T12:00:00.000Z") });
    const claim = await claimWork({
      bucket,
      definitionName: definition.name,
      now: at("2026-07-17T12:00:00.000Z"),
      tokenFactory: () => "lease-6",
      workerId: "worker-6",
    });

    await expect(completeWork({
      bucket,
      now: at("2026-07-17T12:00:30.000Z"),
      work: { ...claim!, leaseToken: "wrong-token" },
    })).rejects.toThrow("lease token mismatch");
    await expect(failWork({
      bucket,
      error: "wrong generation",
      now: at("2026-07-17T12:00:30.000Z"),
      work: { ...claim!, generation: claim!.generation + 1 },
    })).rejects.toThrow("generation mismatch");
  });

  test("rebuildWorkQueuePointers restores missing pointers and removes stale ones", async () => {
    const bucket = createMemoryBucket();
    const definition = { name: "triage/audio", version: "v1" };

    const pending = await ensureWork({ bucket, definition, inputKey: "in/rebuild", now: at("2026-07-17T12:00:00.000Z") });
    await bucket.delete(workQueuePointerKey(pending));

    expect(await claimWork({ bucket, definitionName: definition.name, now: at("2026-07-17T12:00:00.000Z"), workerId: "worker-7" })).toBeNull();

    const rebuilt = await rebuildWorkQueuePointers({ bucket, definitionName: definition.name });
    expect(rebuilt).toEqual({ active: 1, created: 1, deleted: 0 });

    const claimed = await claimWork({
      bucket,
      definitionName: definition.name,
      now: at("2026-07-17T12:00:00.000Z"),
      tokenFactory: () => "lease-7",
      workerId: "worker-7",
    });
    const completed = await completeWork({ bucket, now: at("2026-07-17T12:01:00.000Z"), work: claimed! });

    await bucket.write(workQueuePointerKey(completed), JSON.stringify({ workKey: workItemKey(definition.name, completed.inputKey) }));
    const cleaned = await rebuildWorkQueuePointers({ bucket, definitionName: definition.name });

    expect(cleaned).toEqual({ active: 0, created: 0, deleted: 1 });
    expect(await readWork(bucket, definition.name, completed.inputKey)).toMatchObject({ status: "complete" });
  });
});
