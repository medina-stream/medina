/**
 * Domain-port tests for transcript-search (src/search.ts): the
 * query construction and the document rule must agree with the
 * medina-dev implementation they mirror
 * (lib/lifelog/TranscriptSearch.ts) — a drift in either shows up
 * here. The live parity evidence is the rehearsal battery itself:
 * the Worker's index built from the server's exact basis answering
 * a battery of queries identically to the server's SQLite file.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ftsQuery,
  parseDaySnapshot,
  parseTranscript,
  passagesFor,
  searchInputHash,
  searchLimit,
  type SnapshotEntry,
} from "./search.ts";

describe("ftsQuery", () => {
  test("plain words become quoted AND terms", () => {
    expect(ftsQuery("hello world")).toBe('"hello" AND "world"');
  });

  test("a quoted phrase stays one term", () => {
    expect(ftsQuery('"quoted phrase" rest')).toBe(
      '"quoted phrase" AND "rest"',
    );
  });

  test("punctuation-only input yields no terms", () => {
    expect(ftsQuery("!!! …")).toBe("");
    expect(ftsQuery("")).toBe("");
  });

  test("apostrophes and hyphens stay inside terms", () => {
    expect(ftsQuery("don't stop believin'")).toBe(
      '"don\'t" AND "stop" AND "believin\'"',
    );
    expect(ftsQuery("well-known")).toBe('"well-known"');
  });

  test("unicode letters and digits are terms", () => {
    expect(ftsQuery("café 42")).toBe('"café" AND "42"');
  });
});

describe("searchLimit", () => {
  test("defaults to 20 and clamps to [1, 50]", () => {
    expect(searchLimit()).toBe(20);
    expect(searchLimit(0)).toBe(1);
    expect(searchLimit(500)).toBe(50);
    expect(searchLimit(7.9)).toBe(7);
  });
});

describe("searchInputHash", () => {
  test("matches the server's sha256 over version + day-index hash", async () => {
    const expected = createHash("sha256")
      .update("transcript-search-v1\nabc123", "utf8")
      .digest("hex");
    expect(await searchInputHash("abc123")).toBe(expected);
  });
});

const entry: SnapshotEntry = {
  day: "2026-11-01",
  captureId: "cap-1",
  startTime: "2026-11-01T15:00:00.000Z",
  timeZone: "America/Los_Angeles",
  transcriptKey: "transcript/assemblyai-u35p-v1/cap-1.json",
};

describe("passagesFor", () => {
  test("one passage per non-blank utterance", () => {
    const transcript = parseTranscript({
      text: "whole text",
      utterances: [
        { speaker: "A", startMs: 0, endMs: 100, text: "first" },
        { speaker: null, startMs: 100, endMs: 200, text: "   " },
        { speaker: "B", startMs: 200, endMs: 300, text: " third " },
      ],
    });
    expect(transcript).not.toBeNull();
    const passages = passagesFor(entry, transcript!);
    expect(passages).toHaveLength(2);
    expect(passages[0]).toMatchObject({
      day: "2026-11-01",
      captureId: "cap-1",
      speaker: "A",
      startMs: 0,
      text: "first",
    });
    // The stored text is the utterance's own, untrimmed.
    expect(passages[1]?.text).toBe(" third ");
  });

  test("no utterances falls back to the whole text", () => {
    const transcript = parseTranscript({ text: "only text", utterances: [] });
    const passages = passagesFor(entry, transcript!);
    expect(passages).toHaveLength(1);
    expect(passages[0]).toMatchObject({ speaker: null, startMs: 0, endMs: 0 });
  });

  test("blank everything yields no passages", () => {
    expect(
      passagesFor(entry, parseTranscript({ text: " ", utterances: [] })!),
    ).toEqual([]);
    expect(
      passagesFor(entry, parseTranscript({ text: null, utterances: [] })!),
    ).toEqual([]);
  });
});

describe("parseTranscript", () => {
  test("rejects malformed utterances wholesale", () => {
    expect(
      parseTranscript({ text: "x", utterances: [{ text: 1 }] }),
    ).toBeNull();
    expect(parseTranscript("nope")).toBeNull();
    expect(parseTranscript(null)).toBeNull();
  });
});

describe("parseDaySnapshot", () => {
  test("reads entries across days and skips incomplete ones", () => {
    const snapshot = parseDaySnapshot("index/days-v1/HASH.json", {
      version: 1,
      inputHash: "HASH",
      builtAt: "2026-11-09T00:00:00.000Z",
      days: {
        "2026-11-01": [
          {
            captureId: "cap-1",
            transcriptKey: "k1",
            startTime: "t",
            timeZone: "UTC",
            channel: "main",
            correctionHash: "c",
          },
          { captureId: "cap-2" },
        ],
      },
    });
    expect(snapshot?.inputHash).toBe("HASH");
    expect(snapshot?.entries).toHaveLength(1);
    expect(snapshot?.entries[0]?.day).toBe("2026-11-01");
  });

  test("rejects non-snapshots", () => {
    expect(parseDaySnapshot("k", { days: {} })).toBeNull();
    expect(parseDaySnapshot("k", null)).toBeNull();
  });
});
