/**
 * Domain-port tests for the star detector (src/stars.ts): the
 * command parser must agree with the medina-dev implementation it
 * mirrors (lib/lifelog/StarDetector.ts) — these vectors are the
 * server's own StarDetector.test.ts cases, carried over so a drift
 * in either implementation shows up here. The plan tests pin the
 * filing/sweep shapes (lib/lifelog/Stars.ts). The live parity
 * evidence is the shadow pass itself.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import type { Star, Transcript } from "../../lib/lifelog/Resources.ts";
import {
  detectStarCommands,
  forgetReceiptFor,
  planStars,
  starExpiresAt,
  starRecordFor,
  type TranscriptFile,
} from "./stars.ts";

const CAPTURE_START = "2026-01-01T12:00:00.000Z";

interface Utt {
  speaker: string | null;
  startMs: number;
  endMs: number;
  text: string;
  confidence: null;
}

const utt = (
  speaker: string | null,
  startSec: number,
  endSec: number,
  text: string,
): Utt => ({
  speaker,
  startMs: startSec * 1000,
  endMs: endSec * 1000,
  text,
  confidence: null,
});

const fileOf = (
  captureId: string,
  utterances: ReadonlyArray<Utt>,
  startTime: string = CAPTURE_START,
): TranscriptFile => ({
  captureId,
  startTime,
  transcript: {
    provider: "ondevice",
    version: "v1",
    ingestId: captureId,
    inputKey: `capture/${captureId}.m4a`,
    transcriptId: null,
    vendorKey: null,
    status: "completed",
    completedAt: "2026-01-01T13:10:00.000Z",
    text: utterances.map((u) => u.text).join(" "),
    utterances,
    error: null,
  } as unknown as Transcript,
});

const detect = (file: TranscriptFile) =>
  Effect.runPromise(detectStarCommands(file));

describe("detectStarCommands (server vectors)", () => {
  test("a bare star takes the default window up to the utterance end", async () => {
    const [command] = await detect(
      fileOf("cap-bare", [utt(null, 600, 603, "Star.")]),
    );
    expect(command?.startUtc).toBe("2026-01-01T12:08:00.000Z");
    expect(command?.endUtc).toBe("2026-01-01T12:10:03.000Z");
    expect(command?.name).toBeNull();
  });

  test("star that / star it take the default window too", async () => {
    for (const text of ["star that", "star it", "star please"]) {
      const [command] = await detect(
        fileOf("cap-pronoun", [utt(null, 600, 602, text)]),
      );
      expect(command?.startUtc).toBe("2026-01-01T12:08:00.000Z");
      expect(command?.endUtc).toBe("2026-01-01T12:10:02.000Z");
    }
  });

  test("star the last 5 minutes reaches back from the utterance end", async () => {
    const [command] = await detect(
      fileOf("cap-five", [utt(null, 600, 604, "star the last 5 minutes")]),
    );
    expect(command?.startUtc).toBe("2026-01-01T12:05:04.000Z");
    expect(command?.endUtc).toBe("2026-01-01T12:10:04.000Z");
    expect(command?.utteranceText).toBe("star the last 5 minutes");
  });

  test("star the last 30 seconds and the last 2 hours", async () => {
    const [seconds] = await detect(
      fileOf("cap-secs", [utt(null, 600, 602, "star the last 30 seconds")]),
    );
    expect(seconds?.startUtc).toBe("2026-01-01T12:09:32.000Z");
    const [hours] = await detect(
      fileOf("cap-hours", [utt(null, 600, 602, "star the last 2 hours")]),
    );
    expect(hours?.startUtc).toBe("2026-01-01T10:10:02.000Z");
  });

  test("star the last half hour is 30 minutes; the last minute is 60 seconds", async () => {
    const [half] = await detect(
      fileOf("cap-half", [utt(null, 3600, 3603, "star the last half hour")]),
    );
    expect(half?.startUtc).toBe("2026-01-01T12:30:03.000Z");
    expect(half?.endUtc).toBe("2026-01-01T13:00:03.000Z");
    const [minute] = await detect(
      fileOf("cap-minute", [utt(null, 600, 602, "star the last minute")]),
    );
    expect(minute?.startUtc).toBe("2026-01-01T12:09:02.000Z");
  });

  test("a zero-length span is unparseable and falls back to the default window", async () => {
    const [command] = await detect(
      fileOf("cap-zero", [utt(null, 600, 602, "star the last 0 minutes")]),
    );
    expect(command?.startUtc).toBe("2026-01-01T12:08:00.000Z");
  });

  test("star mid-sentence is speech, not a command", async () => {
    expect(
      await detect(
        fileOf("cap-mid", [utt(null, 0, 3, "the star of the show was great")]),
      ),
    ).toEqual([]);
    expect(
      await detect(
        fileOf("cap-mid2", [utt(null, 0, 3, "I said star the last 5 minutes")]),
      ),
    ).toEqual([]);
    expect(
      await detect(fileOf("cap-mid3", [utt(null, 0, 3, "a star is born")])),
    ).toEqual([]);
  });

  test("another speaker's star is not a command", async () => {
    expect(
      await detect(
        fileOf("cap-other", [utt("speaker_B", 600, 604, "star the last 5 minutes")]),
      ),
    ).toEqual([]);
    expect(
      await detect(
        fileOf("cap-other2", [utt("A", 600, 604, "star the last 5 minutes")]),
      ),
    ).toEqual([]);
  });

  test("one filler token may precede the command", async () => {
    for (const [text, expectedStart] of [
      ["Ok, star the last 2 minutes", "2026-01-01T12:08:02.000Z"],
      ["okay star that", "2026-01-01T12:08:00.000Z"],
      ["Hey star", "2026-01-01T12:08:00.000Z"],
    ] as const) {
      const [command] = await detect(
        fileOf("cap-filler", [utt(null, 600, 602, text)]),
      );
      expect(command?.startUtc).toBe(expectedStart);
      expect(command?.endUtc).toBe("2026-01-01T12:10:02.000Z");
    }
    expect(
      await detect(
        fileOf("cap-filler2", [utt(null, 600, 602, "ok ok star that")]),
      ),
    ).toEqual([]);
  });

  test("names come from 'as …' or a quoted phrase", async () => {
    const [as] = await detect(
      fileOf("cap-name", [utt(null, 600, 604, "Star the last 5 minutes as vet call.")]),
    );
    expect(as?.name).toBe("vet call");
    expect(as?.startUtc).toBe("2026-01-01T12:05:04.000Z");
    const [quoted] = await detect(
      fileOf("cap-name2", [utt(null, 600, 603, "star \"morning pages\"")]),
    );
    expect(quoted?.name).toBe("morning pages");
  });

  test("ids are the server's sha256 derivation over capture, start, text", async () => {
    const utterances = [utt(null, 600, 604, "star the last 5 minutes")];
    const [a] = await detect(fileOf("cap-det", utterances));
    const [b] = await detect(fileOf("cap-det", utterances));
    expect(a?.starId).toBe(b?.starId);
    expect(a?.starId).toMatch(/^[0-9a-f]{32}$/);
    // The exact derivation, cross-checked against node's sha256.
    const expected = createHash("sha256")
      .update("cap-det:2026-01-01T12:10:00.000Z:star the last 5 minutes")
      .digest("hex")
      .slice(0, 32);
    expect(a?.starId).toBe(expected);
    const [otherText] = await detect(
      fileOf("cap-det", [utt(null, 600, 604, "star the last 6 minutes")]),
    );
    expect(otherText?.starId).not.toBe(a?.starId);
    const [otherCapture] = await detect(fileOf("cap-det-2", utterances));
    expect(otherCapture?.starId).not.toBe(a?.starId);
  });

  test("a capture whose start cannot be parsed yields nothing", async () => {
    expect(
      await detect(fileOf("cap-nostart", [utt(null, 0, 2, "star")], "not-a-time")),
    ).toEqual([]);
  });
});

const starOf = (partial: Partial<Star> & { id: string }): Star =>
  ({
    startUtc: "2026-01-01T12:55:03.000Z",
    endUtc: "2026-01-01T13:00:03.000Z",
    name: null,
    note: "star the last 5 minutes",
    visibility: "private",
    retentionSeconds: 3600,
    createdAt: "2026-01-01T13:00:03.000Z",
    createdVia: "voice",
    ...partial,
  }) as Star;

describe("planStars", () => {
  test("a live command files with the detector's record shape", async () => {
    const file = fileOf("cap-voice", [
      utt(null, 3600, 3603, "star the last 5 minutes"),
    ]);
    const plan = await Effect.runPromise(
      planStars([file], [], new Date("2026-01-01T13:10:00.000Z")),
    );
    expect(plan.bornExpired).toEqual([]);
    expect(plan.filings).toHaveLength(1);
    const [command] = await detect(file);
    expect(plan.filings[0]?.star.id).toBe(command?.starId);
    expect(plan.filings[0]?.key).toBe(`star/${command?.starId}.json`);
    const record = JSON.parse(plan.filings[0]?.json ?? "{}") as Record<string, unknown>;
    expect(record).toEqual({
      id: command?.starId,
      startUtc: "2026-01-01T12:55:03.000Z",
      endUtc: "2026-01-01T13:00:03.000Z",
      name: null,
      note: "star the last 5 minutes",
      visibility: "private",
      retentionSeconds: 3600,
      createdAt: "2026-01-01T13:00:03.000Z",
      createdVia: "voice",
    });
    // The stored bytes are the server's writeJson formatting.
    expect(plan.filings[0]?.json.startsWith('{\n  "id":')).toBe(true);
  });

  test("a command whose retention already ran out is born expired", async () => {
    const file = fileOf(
      "cap-stale",
      [utt(null, 3, 6, "star the last 5 minutes")],
      "2026-01-01T01:00:00.000Z",
    );
    const plan = await Effect.runPromise(
      planStars([file], [], new Date("2026-01-02T00:30:00.000Z")),
    );
    expect(plan.filings).toEqual([]);
    expect(plan.bornExpired).toHaveLength(1);
  });

  test("the same plan sweeps a lapsed record and leaves a live one", async () => {
    const lapsed = starOf({
      id: "lapsed",
      retentionSeconds: 60,
      createdAt: "2026-01-01T11:00:00.000Z",
    });
    const live = starOf({ id: "live" });
    const now = new Date("2026-01-01T13:10:00.000Z");
    const plan = await Effect.runPromise(planStars([], [lapsed, live], now));
    expect(plan.sweeps.map((s) => s.star.id)).toEqual(["lapsed"]);
    expect(plan.liveRecords).toBe(1);
    expect(starExpiresAt(lapsed)).toBe(Date.parse("2026-01-01T11:01:00.000Z"));
  });

  test("starRecordFor carries the utterance as the note", async () => {
    const [command] = await detect(
      fileOf("cap-x", [utt(null, 600, 604, "star the last 5 minutes")]),
    );
    const record = starRecordFor(command!);
    expect(record.note).toBe("star the last 5 minutes");
    expect(record.createdAt).toBe(command?.endUtc);
  });
});

describe("forgetReceiptFor", () => {
  test("the receipt names the empty-evidence content hash and stays content-free", async () => {
    const star = starOf({ id: "doomed", name: "a name", note: "a note" });
    const receipt = await Effect.runPromise(
      forgetReceiptFor(star, "2026-01-01T14:00:00.000Z"),
    );
    const canonical = JSON.stringify({
      id: "doomed",
      startUtc: star.startUtc,
      endUtc: star.endUtc,
      name: "a name",
      note: "a note",
      createdAt: star.createdAt,
      transcriptKeys: [],
      excerpt: null,
    });
    const hash = createHash("sha256").update(canonical).digest("hex");
    expect(receipt.key).toBe(`provenance/star/${hash}.json`);
    const body = JSON.parse(receipt.json) as Record<string, unknown>;
    expect(body).toEqual({
      contentHash: hash,
      createdAt: star.createdAt,
      deletedAt: "2026-01-01T14:00:00.000Z",
      retentionSeconds: 3600,
      reason: "expired",
    });
    expect(receipt.json).not.toContain("a name");
    expect(receipt.json).not.toContain("a note");
  });
});
