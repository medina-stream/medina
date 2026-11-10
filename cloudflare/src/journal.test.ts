/**
 * Serving tests for journal.ts: the read model's freshness rules
 * and the authored-star routes, exercised through handleJournal
 * against an in-memory bucket.
 *
 * The scenarios are keyed by distinct days in one shared fixture,
 * because the read model memoizes per isolate:
 *
 *   2026-11-09 — the retirement regression: the frozen previews
 *     snapshot (views/days-v6.json, last written by the server
 *     before it stopped) marks the day stale, but the journal
 *     pass's current-journal map says the journal at the current
 *     key is present. The day must serve.
 *   2026-11-05 — the mirror image: frozen rows call the day
 *     current and an older journal is on disk, but the map says
 *     the current key's journal is absent. The day must pend.
 *   2026-11-03 — no map entry at all: the frozen rows govern,
 *     the pre-map behavior.
 *   2026-11-11 — a journal day the frozen snapshot never knew:
 *     it serves, and refineModel synthesizes its ListDays row.
 *
 * The star cases pin the server's authored-star read surface
 * (example-lifelog/main.ts): day membership by civil day in the
 * home zone over [startUtc, endUtc), oldest first.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { DayRow } from "../../lib/lifelog/JournalApi.ts";
import {
  DayEntry,
  DayIndex,
  Journal,
} from "../../lib/lifelog/Resources.ts";
import {
  handleJournal,
  refineModel,
  type JournalBucket,
  type JournalGates,
  type ReadModel,
} from "./journal.ts";

const journalJson = (
  day: string,
  inputHash: string,
  report: string,
  generatedAt: string,
): string =>
  JSON.stringify({
    version: "journal-v12",
    day,
    inputHash,
    transcriptKeys: [],
    model: "gpt-5.5",
    generatedAt,
    status: "completed",
    report,
  });

const starJson = (
  id: string,
  startUtc: string,
  endUtc: string,
  createdAt: string,
): string =>
  JSON.stringify({
    id,
    startUtc,
    endUtc,
    name: null,
    note: null,
    visibility: "private",
    retentionSeconds: 86400,
    createdAt,
    createdVia: "voice",
  });

const FIXTURE: Record<string, string> = {
  // The frozen previews snapshot: the server's last word.
  "views/days-v6.json": JSON.stringify([
    {
      day: "2026-11-09",
      stale: true,
      preview: "Errands, planning, and late family talk",
      audioSeconds: 3750,
      coverage: [[571, 572]],
      summary: "Errands, planning, and late family talk",
    },
    {
      day: "2026-11-05",
      stale: false,
      preview: "A day whose re-derive is still owed.",
      audioSeconds: 60,
      coverage: [],
      summary: "A day whose re-derive is still owed.",
    },
    {
      day: "2026-11-03",
      stale: false,
      preview: "A settled day the frozen rows call current.",
      audioSeconds: 10,
      coverage: [],
      summary: "A settled day the frozen rows call current.",
    },
  ]),
  // The journal pass's current-journal map.
  "views/journal-current-v1.json": JSON.stringify({
    version: 1,
    builtAt: "2026-11-10T17:00:00.000Z",
    days: {
      "2026-11-09": { inputHash: "hash-nov9", present: true },
      "2026-11-05": { inputHash: "hash-nov5-current", present: false },
      "2026-11-11": { inputHash: "hash-nov11", present: true },
    },
  }),
  "journal/journal-v12/2026-11-09/hash-nov9.json": journalJson(
    "2026-11-09",
    "hash-nov9",
    "Errands, planning, and late family talk\n\n## 13:31–15:21 — Cow Hollow\nMoved through nearby streets.",
    "2026-11-10T15:47:06.859Z",
  ),
  "journal/journal-v12/2026-11-05/hash-nov5-old.json": journalJson(
    "2026-11-05",
    "hash-nov5-old",
    "A day whose re-derive is still owed.",
    "2026-11-06T00:00:00.000Z",
  ),
  "journal/journal-v12/2026-11-03/hash-nov3.json": journalJson(
    "2026-11-03",
    "hash-nov3",
    "A settled day the frozen rows call current.",
    "2026-11-04T00:00:00.000Z",
  ),
  "journal/journal-v12/2026-11-11/hash-nov11.json": journalJson(
    "2026-11-11",
    "hash-nov11",
    "A brand new day\n\n## 09:00–10:00 — Home\nDid things.",
    "2026-11-11T18:00:00.000Z",
  ),
  // The day index: only the synthesized day needs entries.
  "index/days-v1/indexhash.json": JSON.stringify({
    version: "days-v1",
    inputHash: "indexhash",
    builtAt: "2026-11-11T18:05:00.000Z",
    days: {
      "2026-11-11": [
        {
          captureId: "cap-b",
          transcriptKey: "transcript/assemblyai-u35p-v1/cap-b.json",
          startTime: "2026-11-11T17:00:00.000Z",
          timeZone: "America/Los_Angeles",
          channel: "main",
          correctionHash: null,
        },
      ],
    },
  }),
  "transcript/assemblyai-u35p-v1/cap-b.json": JSON.stringify({
    provider: "assemblyai",
    version: "assemblyai-u35p-v1",
    ingestId: "cap-b",
    inputKey: "capture/cap-b",
    transcriptId: null,
    vendorKey: null,
    status: "completed",
    completedAt: "2026-11-11T17:05:00.000Z",
    text: "hello",
    utterances: [
      { speaker: "A", startMs: 0, endMs: 3_600_000, text: "hello", confidence: null },
    ],
    error: null,
  }),
  // Authored stars around 2026-10-17 (America/Los_Angeles).
  "star/star-a.json": starJson(
    "star-a",
    "2026-10-17T20:00:00.000Z",
    "2026-10-17T20:05:00.000Z",
    "2026-10-17T20:06:00.000Z",
  ),
  "star/star-b.json": starJson(
    "star-b",
    "2026-10-18T07:30:00.000Z",
    "2026-10-18T07:35:00.000Z",
    "2026-10-18T07:36:00.000Z",
  ),
  "star/star-c.json": starJson(
    "star-c",
    "2026-10-17T06:00:00.000Z",
    "2026-10-17T09:00:00.000Z",
    "2026-10-17T09:05:00.000Z",
  ),
};

const makeBucket = (): JournalBucket => {
  const objects = new Map(Object.entries(FIXTURE));
  return {
    get: async (key) => {
      const text = objects.get(key);
      if (text === undefined) return null;
      return {
        body: new Response(text).body!,
        size: text.length,
        httpEtag: '"fixture"',
      };
    },
    head: async (key) => {
      const text = objects.get(key);
      if (text === undefined) return null;
      return {
        size: text.length,
        etag: '"fixture"',
        uploaded: new Date("2026-11-11T18:10:00.000Z"),
        customMetadata: {},
      };
    },
    put: async (key, value) => {
      objects.set(key, value);
    },
    list: async ({ prefix, limit, cursor }) => {
      const keys = [...objects.keys()]
        .filter((key) => prefix === undefined || key.startsWith(prefix))
        .sort();
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = keys.slice(start, start + (limit ?? 1000));
      const truncated = start + page.length < keys.length;
      return {
        objects: page.map((key) => ({
          key,
          size: objects.get(key)!.length,
          etag: '"fixture"',
          uploaded: new Date("2026-11-11T18:10:00.000Z"),
        })),
        truncated,
        ...(truncated ? { cursor: String(start + page.length) } : {}),
      };
    },
  };
};

const gates: JournalGates = {
  authorizeToken: (token) => Effect.succeed(token === "test-token"),
  authorizeSession: () => Effect.succeed(false),
  signInPath: "/auth/sign-in",
  homeZone: "America/Los_Angeles",
};

const bucket = makeBucket();
const auth = { authorization: "Bearer test-token" };

const call = (
  path: string,
  init?: RequestInit,
): Promise<Response> =>
  Effect.runPromise(
    Effect.map(
      handleJournal(
        new Request(`https://example.test${path}`, init),
        bucket,
        gates,
      ),
      (response) => response ?? new Response("no route", { status: 404 }),
    ),
  );

describe("day serving freshness", () => {
  test("a day the map calls present serves despite the frozen stale flag", async () => {
    const response = await call("/journal/020261109", { headers: auth });
    expect(response.status).toBe(200);
    const journal = (await response.json()) as {
      day: string;
      report: string;
    };
    expect(journal.day).toBe("2026-11-09");
    expect(journal.report).toContain("Errands, planning");
  });

  test("a day the map calls absent pends despite a frozen current row", async () => {
    const response = await call("/journal/020261105", { headers: auth });
    expect(response.status).toBe(202);
  });

  test("a day the map does not know follows the frozen rows", async () => {
    const response = await call("/journal/020261103", { headers: auth });
    expect(response.status).toBe(200);
    const journal = (await response.json()) as { report: string };
    expect(journal.report).toContain("A settled day");
  });

  test("a journal day the frozen snapshot never knew serves", async () => {
    const response = await call("/journal/020261111", { headers: auth });
    expect(response.status).toBe(200);
    const journal = (await response.json()) as { report: string };
    expect(journal.report).toContain("A brand new day");
  });
});

describe("refineModel rows and journal selection", () => {
  const journal = (
    day: string,
    inputHash: string,
    report: string,
    generatedAt: string,
  ): Journal =>
    new Journal({
      version: "journal-v12",
      day,
      inputHash,
      transcriptKeys: [],
      model: "gpt-5.5",
      generatedAt,
      status: "completed",
      report,
    });
  const row = (
    day: string,
    stale: boolean,
    summary: string,
  ): DayRow =>
    new DayRow({
      day,
      stale,
      preview: summary,
      audioSeconds: 60,
      coverage: [],
      summary,
    });
  const baseModel = (nov9?: Journal): ReadModel => ({
    builtAt: 0,
    rows: [
      row("2026-11-09", true, "Errands, planning, and late family talk"),
      row("2026-11-05", false, "A day whose re-derive is still owed."),
      row("2026-11-03", false, "A settled day the frozen rows call current."),
    ],
    journals: new Map([
      [
        "2026-11-09",
        nov9 ??
          journal(
            "2026-11-09",
            "hash-nov9",
            "Errands, planning, and late family talk",
            "2026-11-10T15:47:06.859Z",
          ),
      ],
      [
        "2026-11-11",
        journal(
          "2026-11-11",
          "hash-nov11",
          "A brand new day\n\n## 09:00–10:00 — Home\nDid things.",
          "2026-11-11T18:00:00.000Z",
        ),
      ],
    ]),
    index: new DayIndex({
      version: "days-v1",
      inputHash: "indexhash",
      builtAt: "2026-11-11T18:05:00.000Z",
      days: {
        "2026-11-11": [
          new DayEntry({
            captureId: "cap-b",
            transcriptKey: "transcript/assemblyai-u35p-v1/cap-b.json",
            startTime: "2026-11-11T17:00:00.000Z",
            timeZone: "America/Los_Angeles",
            channel: "main",
            correctionHash: null,
          }),
        ],
      },
    }),
    reports: new Map(),
    current: new Map([
      ["2026-11-09", { inputHash: "hash-nov9", present: true }],
      ["2026-11-05", { inputHash: "hash-nov5-current", present: false }],
      ["2026-11-11", { inputHash: "hash-nov11", present: true }],
    ]),
  });

  test("staleness comes from the map and new days are synthesized", async () => {
    const refined = await Effect.runPromise(
      refineModel(makeBucket(), baseModel()),
    );
    expect(refined.rows.map((r) => r.day)).toEqual([
      "2026-11-11",
      "2026-11-09",
      "2026-11-05",
      "2026-11-03",
    ]);
    const byDay = new Map(refined.rows.map((r) => [r.day, r]));
    // Frozen rows, staleness overridden by the map both ways; a
    // day the map does not know keeps the frozen flag.
    expect(byDay.get("2026-11-09")!.stale).toBe(false);
    expect(byDay.get("2026-11-05")!.stale).toBe(true);
    expect(byDay.get("2026-11-03")!.stale).toBe(false);
    // The synthesized row: preview/summary from the journal,
    // audio/coverage from the day's transcript (09:00–10:00 PT).
    const synthesized = byDay.get("2026-11-11")!;
    expect(synthesized.stale).toBe(false);
    expect(synthesized.preview).toBe("A brand new day");
    expect(synthesized.summary).toContain("Did things.");
    expect(synthesized.audioSeconds).toBe(3600);
    expect(synthesized.coverage).toEqual([[540, 600]]);
  });

  test("the journal at the current key is served over a newer generation", async () => {
    // The snapshot's winner for Nov 9 is an older-input generation
    // re-derived later (a newer generatedAt); the map names
    // hash-nov9 — the generation in the bucket fixture — as the
    // present current one.
    const base = baseModel(
      journal(
        "2026-11-09",
        "hash-nov9-older-input",
        "A later re-derive of an older input.",
        "2026-11-11T00:00:00.000Z",
      ),
    );
    const refined = await Effect.runPromise(
      refineModel(makeBucket(), base),
    );
    const served = refined.journals.get("2026-11-09")!;
    expect(served.inputHash).toBe("hash-nov9");
    expect(served.report).toContain("Errands, planning");
  });
});

describe("status surface", () => {
  test("per-day journal state follows the map, and totals agree", async () => {
    const response = await call("/status", { headers: auth });
    expect(response.status).toBe(200);
    const status = (await response.json()) as {
      days: Array<{ day: string; journal: string }>;
      totals: { days: number; transcripts: number; current: number; stale: number };
    };
    const byDay = new Map(status.days.map((d) => [d.day, d.journal]));
    expect(byDay.get("2026-11-09")).toBe("current");
    expect(byDay.get("2026-11-05")).toBe("stale");
    expect(byDay.get("2026-11-11")).toBe("current");
    expect(status.totals).toEqual({ days: 4, transcripts: 1, current: 3, stale: 1 });
  });
});

describe("authored stars", () => {
  test("a day's stars are its civil-day overlaps, oldest first", async () => {
    const response = await call("/stars/020261017", { headers: auth });
    expect(response.status).toBe(200);
    const stars = (await response.json()) as Array<{ id: string }>;
    expect(stars.map((star) => star.id)).toEqual(["star-c", "star-a"]);
  });

  test("neighboring days see only their own overlaps", async () => {
    const before = (await (
      await call("/stars/020261016", { headers: auth })
    ).json()) as Array<{ id: string }>;
    expect(before.map((star) => star.id)).toEqual(["star-c"]);
    const after = (await (
      await call("/stars/020261018", { headers: auth })
    ).json()) as Array<{ id: string }>;
    expect(after.map((star) => star.id)).toEqual(["star-b"]);
  });

  test("one star by id, and a missing star is a 404", async () => {
    const found = await call("/star/star-a", { headers: auth });
    expect(found.status).toBe(200);
    const star = (await found.json()) as { id: string; createdVia: string };
    expect(star.id).toBe("star-a");
    expect(star.createdVia).toBe("voice");
    const missing = await call("/star/nope", { headers: auth });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("no such star");
  });

  test("a malformed day is a 400, and the gate fails closed", async () => {
    const bad = await call("/stars/notaday", { headers: auth });
    expect(bad.status).toBe(400);
    const gated = await call("/stars/020261017");
    expect(gated.status).toBe(404);
  });
});
