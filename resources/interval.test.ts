import { describe, expect, test } from "bun:test";

import { checkInterval, createInterval, getDailyIntervalId, getIntervalBucketKey, parseIntervalId } from "./interval";
import { intervalsDefinition } from "./intervals";
import { createMemoryBucket } from "../lib/bucket.test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runResource } from "../lib/resource";
import type { Recording } from "./recording";

describe("intervals", () => {
  test("parses canonical day interval ids", () => {
    expect(parseIntervalId("020260505")).toEqual({
      endTime: new Date("2026-05-06T00:00:00.000Z"),
      id: "020260505",
      key: "intervals/020260505.json",
      length: "P1D",
      startTime: new Date("2026-05-05T00:00:00.000Z"),
    });
  });

  test("supports month-shaped interval ids without changing the resource name", () => {
    expect(parseIntervalId("0202605")).toEqual({
      endTime: new Date("2026-06-01T00:00:00.000Z"),
      id: "0202605",
      key: "intervals/0202605.json",
      length: "P1M",
      startTime: new Date("2026-05-01T00:00:00.000Z"),
    });
  });

  test("builds a daily interval from overlapping recordings", () => {
    const recordings: Recording[] = [
      {
        chunks: [],
        durationSeconds: 600,
        id: "recording-a",
        startTime: "2026-05-05T13:55:00.000Z",
      },
      {
        chunks: [],
        durationSeconds: 1200,
        id: "recording-b",
        startTime: "2026-05-05T23:50:00.000Z",
      },
    ];
    const interval = createInterval({
      interval: parseIntervalId(getDailyIntervalId(new Date("2026-05-05T20:00:00.000Z"))),
      recordings,
    });

    expect(interval).toMatchObject({
      coverageSeconds: 1200,
      durationSeconds: 86400,
      endTime: "2026-05-06T00:00:00.000Z",
      id: "020260505",
      key: getIntervalBucketKey("020260505"),
      length: "P1D",
      startTime: "2026-05-05T00:00:00.000Z",
    });
    expect(interval.recordings.map((recording) => recording.id)).toEqual([
      "recording-a",
      "recording-b",
    ]);
    expect(checkInterval(interval)).toEqual([]);
  });

  test("formats canonical day interval ids from UTC dates", () => {
    expect(getDailyIntervalId(new Date("2026-05-05T23:59:59.000Z"))).toBe("020260505");
  });

  test("materializes future intervals as empty resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "medina-future-interval-"));
    const bucket = createMemoryBucket();
    try {
      const result = await runResource(intervalsDefinition, {
        bucket,
        inputKey: "020990101",
        now: new Date("2026-05-15T00:00:00.000Z"),
      });

      expect(result.outputs).toEqual(["intervals/020990101.json"]);
      expect(result.materialized).toBe(true);
      expect(await bucket.readJson("intervals/020990101.json")).toMatchObject({
        coverageSeconds: 0,
        id: "020990101",
        recordings: [],
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
