/**
 * Domain-port tests for journaling (src/journaling.ts): the
 * input-hash compositions, evidence rendering, batching, and the
 * movement timeline must agree with the medina-dev implementation
 * they mirror (lib/lifelog/Journal.ts, lib/lifelog/Movement.ts) —
 * the hash vectors are sha256 digests of the server's composed
 * strings, computed outside both implementations, so a drift in
 * either composition shows up here. The live parity evidence is
 * the shadow pass itself.
 */
import { describe, expect, test } from "bun:test";
import {
  DayEntry,
  Journal,
  Transcript,
  Utterance,
} from "../../lib/lifelog/Resources.ts";
import { sha256Hex } from "./capture.ts";
import type { MovementShape } from "./movement.ts";
import {
  batches,
  hasJournalInputs,
  journalCurrentJson,
  journalInputHash,
  journalIsPresent,
  notesInputHash,
  recordingSpan,
  renderMovementTimeline,
  transcriptEvidence,
  utteranceClock,
} from "./journaling.ts";

const entry = (
  transcriptKey: string,
  correctionHash: string | null = null,
): DayEntry =>
  new DayEntry({
    captureId: "capture-1",
    transcriptKey,
    startTime: "2026-11-09T18:05:00.000Z",
    timeZone: "America/Los_Angeles",
    channel: "main",
    correctionHash,
  });

describe("journalInputHash", () => {
  test("transcript-only composition keeps the pre-movement hash", async () => {
    const hash = await journalInputHash([
      entry("transcript/transcript-v3/aaa.json"),
    ]);
    expect(hash).toBe(
      "1fd02705ee9bd2699b347294c158c52d5261d11f7552f22923de37a98aaa3b5c",
    );
  });

  test("a correction hash joins its transcript line", async () => {
    const hash = await journalInputHash([
      entry("transcript/transcript-v3/aaa.json", "corr123"),
    ]);
    expect(hash).toBe(
      "efb55f374ef95149139150e6d4c1d7c06e4179135831d73e7a7a0537aadb7c89",
    );
  });

  test("movement and note bases append in server order", async () => {
    const hash = await journalInputHash(
      [entry("transcript/transcript-v3/aaa.json")],
      "mvhash",
      "notehash",
    );
    expect(hash).toBe(
      "2fad22da550b227e2a31b370c79107e4a2054f875a0e664d3af0e7c2f8c446d9",
    );
  });
});

describe("notesInputHash", () => {
  test("is the transcript lines only, and the key hashes them", async () => {
    const entries = [
      entry("transcript/transcript-v3/aaa.json"),
      entry("transcript/transcript-v3/bbb.json"),
    ];
    expect(notesInputHash(entries)).toBe(
      "transcript/transcript-v3/aaa.json\ntranscript/transcript-v3/bbb.json",
    );
    expect(await sha256Hex(notesInputHash(entries))).toBe(
      "0b5de8b1526124d2d8e2eb92f5798779745c01e02fa065215f7f92e328321223",
    );
  });
});

const diarized = new Transcript({
  provider: "assemblyai",
  version: "transcript-v3",
  ingestId: "capture-1",
  inputKey: "capture/capture-1/audio.ogg",
  transcriptId: "t-1",
  vendorKey: "transcript/transcript-v3/capture-1.assemblyai.json",
  status: "completed",
  completedAt: "2026-11-09T19:00:00.000Z",
  text: "hello world",
  utterances: [
    new Utterance({
      speaker: "speaker_A",
      startMs: 0,
      endMs: 30_000,
      text: "hello",
      confidence: 0.9,
    }),
    new Utterance({
      speaker: null,
      startMs: 60_000,
      endMs: 90_000,
      text: "world",
      confidence: null,
    }),
  ],
  error: null,
});

describe("evidence rendering", () => {
  test("utteranceClock renders absolute local clock times", () => {
    expect(
      utteranceClock("2026-11-09T18:05:00.000Z", "America/Los_Angeles", 0),
    ).toBe("10:05");
    expect(
      utteranceClock(
        "2026-11-09T18:05:00.000Z",
        "America/Los_Angeles",
        3_600_000,
      ),
    ).toBe("11:05");
    expect(utteranceClock("not-a-date", "America/Los_Angeles", 0)).toBe("");
  });

  test("turns carry their absolute local clock and speaker label", () => {
    const evidence = transcriptEvidence(
      diarized,
      "2026-11-09T18:05:00.000Z",
      "America/Los_Angeles",
    );
    expect(evidence).toBe(
      "[10:05] Speaker speaker_A: hello\n[10:06] Speaker unknown: world",
    );
  });

  test("the recording span bounds the evidence with start and end", () => {
    expect(recordingSpan(entry("k"), diarized)).toBe(
      "10:05-10:06 America/Los_Angeles",
    );
  });

  test("a transcript without utterances falls back to its text", () => {
    const flat = new Transcript({ ...diarized, utterances: [], text: "raw" });
    expect(
      transcriptEvidence(flat, "2026-11-09T18:05:00.000Z", "America/Los_Angeles"),
    ).toBe("raw");
  });
});

describe("batches", () => {
  test("a small day is one labelled batch", () => {
    const result = batches([{ entry: entry("k"), transcript: diarized }]);
    expect(result.length).toBe(1);
    expect(result[0]).toContain(
      "--- recording 10:05-10:06 America/Los_Angeles (capture-1) ---",
    );
    expect(result[0]).toContain("[10:05] Speaker speaker_A: hello");
  });

  test("a long day splits under the batch cap, each batch labelled", () => {
    const big = new Transcript({
      ...diarized,
      utterances: [],
      text: "x".repeat(200_000),
    });
    const result = batches([{ entry: entry("k"), transcript: big }]);
    expect(result.length).toBeGreaterThanOrEqual(3);
    for (const batch of result) {
      expect(batch.length).toBeLessThanOrEqual(90_000);
      expect(batch).toContain("--- recording");
    }
  });

  test("an input with no evidence contributes no batch", () => {
    const empty = new Transcript({ ...diarized, utterances: [], text: null });
    expect(batches([{ entry: entry("k"), transcript: empty }])).toEqual([]);
  });
});

describe("renderMovementTimeline", () => {
  test("renders stays, travel, and gaps in the server's format", () => {
    const movement: MovementShape = {
      version: "movement-v1",
      day: "2026-11-09",
      basisHash: "basis",
      timeZone: "America/Los_Angeles",
      generatedAt: "2026-11-10T00:00:00.000Z",
      segments: [
        {
          kind: "stay",
          startTime: "2026-11-09T17:00:00.000Z",
          endTime: "2026-11-09T18:00:00.000Z",
          startLocal: "09:00",
          endLocal: "10:00",
          lat: 37.7,
          lon: -122.4,
          placeId: null,
          placeName: "Home",
          geocodedName: null,
          dwellMinutes: 60,
          fixes: 12,
        },
        {
          kind: "travel",
          startTime: "2026-11-09T18:00:00.000Z",
          endTime: "2026-11-09T18:20:00.000Z",
          startLocal: "10:00",
          endLocal: "10:20",
          distanceMeters: 1500,
          mode: "walk",
          fixes: 8,
        },
        {
          kind: "gap",
          startTime: "2026-11-09T18:20:00.000Z",
          endTime: "2026-11-09T19:00:00.000Z",
          startLocal: "10:20",
          endLocal: "11:00",
          fixes: 2,
        },
      ],
      narrative: null,
      suggestions: [],
    };
    expect(renderMovementTimeline(movement)).toBe(
      "09:00-10:00 stay at Home (60 min)\n10:00-10:20 walk 1.5 km\n10:20-11:00 gap in GPS evidence",
    );
  });
});

describe("journalCurrentJson", () => {
  test("publishes one entry per day with its hash and presence", () => {
    const parsed = JSON.parse(
      journalCurrentJson(
        [
          { day: "2026-11-09", inputHash: "abc123", present: true },
          { day: "2026-11-08", inputHash: "def456", present: false },
        ],
        "2026-11-10T17:00:00.000Z",
      ),
    ) as {
      version: number;
      builtAt: string;
      days: Record<string, { inputHash: string; present: boolean }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.builtAt).toBe("2026-11-10T17:00:00.000Z");
    expect(parsed.days["2026-11-09"]).toEqual({
      inputHash: "abc123",
      present: true,
    });
    expect(parsed.days["2026-11-08"]).toEqual({
      inputHash: "def456",
      present: false,
    });
    expect(Object.keys(parsed.days)).toHaveLength(2);
  });

  test("an empty pass publishes an empty map, not an absent file", () => {
    const parsed = JSON.parse(
      journalCurrentJson([], "2026-11-10T17:00:00.000Z"),
    ) as { days: Record<string, unknown> };
    expect(parsed.days).toEqual({});
  });
});

describe("journalIsPresent", () => {
  const journal = (report: string): Journal =>
    new Journal({
      version: "journal-v12",
      day: "2026-11-08",
      inputHash: "abc123",
      transcriptKeys: [],
      model: "gpt-5.5",
      generatedAt: "2026-11-09T00:00:00.000Z",
      status: "completed",
      report,
    });

  test("no stored journal is absent", () => {
    expect(journalIsPresent(null)).toBe(false);
  });

  test("an empty report is not a journal (the Nov 8 poison)", () => {
    expect(journalIsPresent(journal(""))).toBe(false);
    expect(journalIsPresent(journal("  \n\n  "))).toBe(false);
  });

  test("a journal with report text is present", () => {
    expect(journalIsPresent(journal("A day.\n\n## 09:00 — Home\nThings."))).toBe(
      true,
    );
  });
});

describe("hasJournalInputs", () => {
  test("any one input kind suffices", () => {
    expect(hasJournalInputs(0, false, false)).toBe(false);
    expect(hasJournalInputs(1, false, false)).toBe(true);
    expect(hasJournalInputs(0, true, false)).toBe(true);
    expect(hasJournalInputs(0, false, true)).toBe(true);
  });
});
