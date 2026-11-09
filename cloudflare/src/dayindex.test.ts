import { describe, expect, test } from "bun:test";
import {
  decideStart as libDecideStart,
  defaultStartTimeRules as libDefaults,
  startTimeRulesDigest as libDigest,
} from "../../lib/lifelog/StartTime.ts";
import {
  computeAttribution,
  dayInZone,
  decideStart,
  defaultStartTimeRules,
  deriveCaptureIds,
  pairLine,
  startTimeRulesDigest,
  usableTranscript,
  wallClockInZone,
  wallToUtc,
  type StartEvidence,
} from "./dayindex.ts";

describe("deriveCaptureIds", () => {
  test("mirrors transcribedCaptures: skips bookkeeping, strips suffixes, keeps order", () => {
    const entries = [
      "aaa.assemblyai.json",
      "aaa.jobs.json",
      "aaa.json",
      "aaa.ondevice.json",
      "bbb.json",
      "ccc.promoted.json",
      "live/install-1/123e4567-e89b-42d3-a456-426614174000.json",
      "not-a-transcript.txt",
    ];
    expect(deriveCaptureIds(entries)).toEqual([
      "aaa",
      "bbb",
      "live/install-1/123e4567-e89b-42d3-a456-426614174000",
    ]);
  });
});

describe("usableTranscript", () => {
  test("completed with text only", () => {
    expect(usableTranscript({ status: "completed", text: " hello " })).toBe(true);
    expect(usableTranscript({ status: "completed", text: "  " })).toBe(false);
    expect(usableTranscript({ status: "completed", text: null })).toBe(false);
    expect(usableTranscript({ status: "error", text: "hello" })).toBe(false);
    expect(usableTranscript(null)).toBe(false);
  });
});

describe("zone math", () => {
  test("wallToUtc interprets a wall clock in the zone", () => {
    // PDT is UTC-7, PST is UTC-8.
    expect(wallToUtc("2026-09-03T14:04:36", "America/Los_Angeles")).toBe(
      "2026-09-03T21:04:36.000Z",
    );
    expect(wallToUtc("2026-01-15T08:00:00", "America/Los_Angeles")).toBe(
      "2026-01-15T16:00:00.000Z",
    );
    expect(wallToUtc("2026-09-03T14:04:36", "UTC")).toBe(
      "2026-09-03T14:04:36.000Z",
    );
    expect(wallToUtc("not a date", "America/Los_Angeles")).toBeNull();
    expect(wallToUtc("2026-09-03T14:04:36", "Not/AZone")).toBeNull();
  });

  test("dayInZone and wallClockInZone place instants on civil days", () => {
    // 06:30Z is 22:30 the previous day in Los Angeles (PST).
    expect(dayInZone("2026-11-09T06:30:00.000Z", "America/Los_Angeles")).toBe(
      "2026-11-08",
    );
    expect(dayInZone("2026-11-09T06:30:00.000Z", "UTC")).toBe("2026-11-09");
    expect(
      wallClockInZone("2026-11-09T06:30:00.000Z", "America/Los_Angeles"),
    ).toEqual({ day: "2026-11-08", startTime: "2026-11-08T22:30:00" });
  });
});

describe("decideStart port vs lib/lifelog/StartTime.ts", () => {
  const evidence = (over: Partial<StartEvidence>): StartEvidence => ({
    source: "drive",
    filename: null,
    containerCreatedAt: null,
    containerDurationSeconds: null,
    legacyWallClock: null,
    modifiedAt: null,
    zone: "America/Los_Angeles",
    toUtc: wallToUtc,
    ...over,
  });

  test("the rules digest is byte-identical for the default rules", () => {
    expect(startTimeRulesDigest(defaultStartTimeRules)).toBe(
      libDigest(libDefaults),
    );
  });

  test("decisions agree across the evidence shapes", () => {
    const cases: Array<Partial<StartEvidence>> = [
      // filename + container in agreement
      {
        filename: "sco-lifelog-020260903T140436.m4a",
        containerCreatedAt: "2026-09-03T21:05:36.000Z",
        containerDurationSeconds: 60,
      },
      // filename + container disagreeing (paused recording): earlier wins
      {
        filename: "sco-lifelog-020260903T140436.m4a",
        containerCreatedAt: "2026-09-03T21:20:36.000Z",
        containerDurationSeconds: 60,
      },
      // container only
      {
        containerCreatedAt: "2026-09-03T21:05:36.000Z",
        containerDurationSeconds: 3600,
      },
      // filename only, dated-separators shape
      { filename: "Recording_2026-09-03 14.04.36.m4a" },
      // legacy wall clock only
      { legacyWallClock: "2026-09-03T14:04:36" },
      // modified time only
      { modifiedAt: "2026-09-04T10:00:00.000Z" },
      // nothing
      {},
    ];
    for (const over of cases) {
      const mine = decideStart(evidence(over));
      const theirs = libDecideStart(
        evidence(over) as never,
        libDefaults as never,
      );
      expect(mine).toEqual(theirs as never);
    }
  });
});

describe("computeAttribution", () => {
  test("a filename-stamped capture lands on its local day", () => {
    const shape = computeAttribution(
      "cap1",
      {
        provenanceSource: "drive",
        provenanceFilename: "sco-lifelog-020260903T140436.m4a",
        provenanceModifiedTime: "2026-09-04T10:00:00.000Z",
        triageFilename: null,
        triageReceivedAt: null,
        legacyCapturedAt: null,
        mediaCreatedAt: null,
        mediaDurationSeconds: null,
      },
      null,
      "America/Los_Angeles",
    );
    expect(shape.estimatedStartTime).toBe("2026-09-03T21:04:36.000Z");
    expect(shape.day).toBe("2026-09-03");
    expect(shape.timeZone).toBe("America/Los_Angeles");
    expect(shape.method).toBe("filename-stamp");
    expect(shape.channel).toBe("main");
  });

  test("a correction overrides start, zone, and channel", () => {
    const shape = computeAttribution(
      "cap1",
      {
        provenanceSource: null,
        provenanceFilename: null,
        provenanceModifiedTime: null,
        triageFilename: null,
        triageReceivedAt: null,
        legacyCapturedAt: null,
        mediaCreatedAt: null,
        mediaDurationSeconds: null,
      },
      {
        estimatedStartTime: "2026-06-14T10:00:00.000Z",
        timeZone: "Europe/Berlin",
        channel: "field",
      },
      "America/Los_Angeles",
    );
    expect(shape.day).toBe("2026-06-14");
    expect(shape.timeZone).toBe("Europe/Berlin");
    expect(shape.channel).toBe("field");
    expect(shape.confidence).toBe("corrected");
  });
});

describe("pairLine", () => {
  test("matches the basis construction (empty for nulls)", () => {
    expect(pairLine("cap", null, null)).toBe("cap::");
    expect(pairLine("cap", "hash", "transcript/x.json")).toBe(
      "cap:hash:transcript/x.json",
    );
  });
});
