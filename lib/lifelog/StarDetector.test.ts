import { BunFileSystem } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { tmpdir } from "node:os"
import * as Files from "../Files.ts"
import {
  DATA_DIR,
  dataPath,
  DayEntry,
  DayIndex,
  DAY_INDEX_VERSION,
  Transcript,
  transcriptKey,
  Utterance
} from "./Resources.ts"
import { detectAndFileStarsIn, detectStarCommands, type TranscriptFile } from "./StarDetector.ts"
import { Stars, StarsLive } from "./Stars.ts"

// The preload (test-preload.ts) points DATA_DIR at a fresh temp dir before
// any of these modules capture it; refuse to run anywhere else.
if (!DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run against a non-temp data dir: ${DATA_DIR}`)
}

const layers = Layer.mergeAll(StarsLive, BunFileSystem.layer)
const run = <A, E>(program: Effect.Effect<A, E, Stars | import("effect/FileSystem").FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.provide(layers)))

const CAPTURE_START = "2026-01-01T12:00:00.000Z"

const utt = (speaker: string | null, startSec: number, endSec: number, text: string) =>
  new Utterance({ speaker, startMs: startSec * 1000, endMs: endSec * 1000, text, confidence: null })

const transcriptOf = (captureId: string, utterances: ReadonlyArray<Utterance>) =>
  new Transcript({
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
    error: null
  })

const fileOf = (captureId: string, utterances: ReadonlyArray<Utterance>, startTime: string = CAPTURE_START): TranscriptFile => ({
  captureId,
  startTime,
  transcript: transcriptOf(captureId, utterances)
})

describe("detectStarCommands", () => {
  test("a bare star takes the default window up to the utterance end", () => {
    // Utterance 12:10:00–12:10:03; the default window starts 120s before
    // the utterance starts and ends when it does.
    const [command] = detectStarCommands(fileOf("cap-bare", [utt(null, 600, 603, "Star.")]))
    expect(command?.startUtc).toBe("2026-01-01T12:08:00.000Z")
    expect(command?.endUtc).toBe("2026-01-01T12:10:03.000Z")
    expect(command?.name).toBeNull()
  })

  test("star that / star it take the default window too", () => {
    for (const text of ["star that", "star it", "star please"]) {
      const [command] = detectStarCommands(fileOf("cap-pronoun", [utt(null, 600, 602, text)]))
      expect(command?.startUtc).toBe("2026-01-01T12:08:00.000Z")
      expect(command?.endUtc).toBe("2026-01-01T12:10:02.000Z")
    }
  })

  test("star the last 5 minutes reaches back from the utterance end", () => {
    const [command] = detectStarCommands(fileOf("cap-five", [utt(null, 600, 604, "star the last 5 minutes")]))
    expect(command?.startUtc).toBe("2026-01-01T12:05:04.000Z")
    expect(command?.endUtc).toBe("2026-01-01T12:10:04.000Z")
    expect(command?.utteranceText).toBe("star the last 5 minutes")
  })

  test("star the last 30 seconds and the last 2 hours", () => {
    const [seconds] = detectStarCommands(fileOf("cap-secs", [utt(null, 600, 602, "star the last 30 seconds")]))
    expect(seconds?.startUtc).toBe("2026-01-01T12:09:32.000Z")
    const [hours] = detectStarCommands(fileOf("cap-hours", [utt(null, 600, 602, "star the last 2 hours")]))
    expect(hours?.startUtc).toBe("2026-01-01T10:10:02.000Z")
  })

  test("star the last half hour is 30 minutes; the last minute is 60 seconds", () => {
    const [half] = detectStarCommands(fileOf("cap-half", [utt(null, 3600, 3603, "star the last half hour")]))
    expect(half?.startUtc).toBe("2026-01-01T12:30:03.000Z")
    expect(half?.endUtc).toBe("2026-01-01T13:00:03.000Z")
    const [minute] = detectStarCommands(fileOf("cap-minute", [utt(null, 600, 602, "star the last minute")]))
    expect(minute?.startUtc).toBe("2026-01-01T12:09:02.000Z")
  })

  test("a zero-length span is unparseable and falls back to the default window", () => {
    const [command] = detectStarCommands(fileOf("cap-zero", [utt(null, 600, 602, "star the last 0 minutes")]))
    expect(command?.startUtc).toBe("2026-01-01T12:08:00.000Z")
  })

  test("star mid-sentence is speech, not a command", () => {
    expect(detectStarCommands(fileOf("cap-mid", [utt(null, 0, 3, "the star of the show was great")]))).toEqual([])
    expect(detectStarCommands(fileOf("cap-mid2", [utt(null, 0, 3, "I said star the last 5 minutes")]))).toEqual([])
    expect(detectStarCommands(fileOf("cap-mid3", [utt(null, 0, 3, "a star is born")]))).toEqual([])
  })

  test("another speaker's star is not a command", () => {
    expect(detectStarCommands(fileOf("cap-other", [utt("speaker_B", 600, 604, "star the last 5 minutes")]))).toEqual([])
    expect(detectStarCommands(fileOf("cap-other2", [utt("A", 600, 604, "star the last 5 minutes")]))).toEqual([])
  })

  test("one filler token may precede the command", () => {
    for (const [text, expectedStart] of [
      ["Ok, star the last 2 minutes", "2026-01-01T12:08:02.000Z"],
      ["okay star that", "2026-01-01T12:08:00.000Z"],
      ["Hey star", "2026-01-01T12:08:00.000Z"]
    ] as const) {
      const [command] = detectStarCommands(fileOf("cap-filler", [utt(null, 600, 602, text)]))
      expect(command?.startUtc).toBe(expectedStart)
      expect(command?.endUtc).toBe("2026-01-01T12:10:02.000Z")
    }
    // Two fillers is conversation, not a command.
    expect(detectStarCommands(fileOf("cap-filler2", [utt(null, 600, 602, "ok ok star that")]))).toEqual([])
  })

  test("names come from 'as …' or a quoted phrase", () => {
    const [as] = detectStarCommands(fileOf("cap-name", [utt(null, 600, 604, "Star the last 5 minutes as vet call.")]))
    expect(as?.name).toBe("vet call")
    expect(as?.startUtc).toBe("2026-01-01T12:05:04.000Z")
    const [quoted] = detectStarCommands(fileOf("cap-name2", [utt(null, 600, 603, "star \"morning pages\"")]))
    expect(quoted?.name).toBe("morning pages")
  })

  test("ids are deterministic over capture, utterance start, and text", () => {
    const utterances = [utt(null, 600, 604, "star the last 5 minutes")]
    const [a] = detectStarCommands(fileOf("cap-det", utterances))
    const [b] = detectStarCommands(fileOf("cap-det", utterances))
    expect(a?.starId).toBe(b?.starId)
    expect(a?.starId).toMatch(/^[0-9a-f]{32}$/)
    const [otherText] = detectStarCommands(fileOf("cap-det", [utt(null, 600, 604, "star the last 6 minutes")]))
    expect(otherText?.starId).not.toBe(a?.starId)
    const [otherCapture] = detectStarCommands(fileOf("cap-det-2", utterances))
    expect(otherCapture?.starId).not.toBe(a?.starId)
  })

  test("a capture whose start cannot be parsed yields nothing", () => {
    expect(detectStarCommands(fileOf("cap-nostart", [utt(null, 0, 2, "star")], "not-a-time"))).toEqual([])
  })
})

describe("detectAndFileStarsIn", () => {
  const dayIndexWith = async (
    day: string,
    captureId: string,
    startTime: string,
    transcript: Transcript
  ): Promise<DayIndex> => {
    await Effect.runPromise(
      Files.writeJson(dataPath(transcriptKey(captureId)), transcript).pipe(Effect.provide(BunFileSystem.layer))
    )
    return new DayIndex({
      version: DAY_INDEX_VERSION,
      inputHash: "detector-test",
      builtAt: "2026-01-01T00:00:00.000Z",
      days: {
        [day]: [new DayEntry({
          captureId,
          transcriptKey: transcriptKey(captureId),
          startTime,
          timeZone: "UTC",
          channel: "audio",
          correctionHash: null
        })]
      }
    })
  }

  test("filing twice over the same transcript yields one voice star", async () => {
    // Command spoken 13:00:00–13:00:03 in a capture starting 12:00:00.
    const transcript = transcriptOf("cap-voice", [utt(null, 3600, 3603, "star the last 5 minutes")])
    const index = await dayIndexWith("2026-01-01", "cap-voice", CAPTURE_START, transcript)
    const now = new Date("2026-01-01T13:10:00.000Z")
    const [expected] = detectStarCommands({ captureId: "cap-voice", startTime: CAPTURE_START, transcript })
    const first = await run(detectAndFileStarsIn(index, now))
    const second = await run(detectAndFileStarsIn(index, now))
    expect(first).toEqual([expected!.starId])
    expect(second).toEqual([expected!.starId])
    const star = await run(Effect.gen(function*() {
      const stars = yield* Stars
      const all = yield* stars.listStars()
      expect(all.filter((s) => s.id === expected!.starId)).toHaveLength(1)
      return yield* stars.getStar(expected!.starId)
    }))
    expect(star.createdVia).toBe("voice")
    expect(star.startUtc).toBe("2026-01-01T12:55:03.000Z")
    expect(star.endUtc).toBe("2026-01-01T13:00:03.000Z")
    expect(star.createdAt).toBe("2026-01-01T13:00:03.000Z")
    expect(star.retentionSeconds).toBe(3600)
  })

  test("another speaker's command files nothing", async () => {
    const transcript = transcriptOf("cap-notmine", [utt("speaker_B", 3600, 3603, "star the last 5 minutes")])
    const index = await dayIndexWith("2026-01-01", "cap-notmine", CAPTURE_START, transcript)
    const listIds = () =>
      run(Effect.gen(function*() {
        const stars = yield* Stars
        const all = yield* stars.listStars()
        return all.map((s) => s.id).sort()
      }))
    const before = await listIds()
    const filed = await run(detectAndFileStarsIn(index, new Date("2026-01-01T13:10:00.000Z")))
    expect(filed).toEqual([])
    expect(await listIds()).toEqual(before)
  })

  test("a command whose retention already ran out is left unfiled", async () => {
    // Spoken 01:00:03 on Jan 1; scanned Jan 2 — the default hour of
    // retention ran out long before the scan, so nothing is written.
    const transcript = transcriptOf("cap-stale", [utt(null, 3, 6, "star the last 5 minutes")])
    const index = await dayIndexWith("2026-01-01", "cap-stale", "2026-01-01T01:00:00.000Z", transcript)
    const filed = await run(detectAndFileStarsIn(index, new Date("2026-01-02T00:30:00.000Z")))
    expect(filed).toEqual([])
  })

  test("the same pass sweeps stars whose retention lapsed", async () => {
    await run(Effect.gen(function*() {
      const stars = yield* Stars
      yield* stars.setStar({
        id: "detector-swept",
        startUtc: "2026-01-01T10:55:00.000Z",
        endUtc: "2026-01-01T11:00:00.000Z",
        retentionSeconds: 60,
        createdAt: "2026-01-01T11:00:00.000Z"
      })
    }))
    const empty = new DayIndex({
      version: DAY_INDEX_VERSION,
      inputHash: "detector-test",
      builtAt: "2026-01-01T00:00:00.000Z",
      days: {}
    })
    const filed = await run(detectAndFileStarsIn(empty, new Date("2026-01-01T12:00:00.000Z")))
    expect(filed).toEqual([])
    const remaining = await run(Effect.gen(function*() {
      const stars = yield* Stars
      return yield* stars.listStars()
    }))
    expect(remaining.map((s) => s.id)).not.toContain("detector-swept")
  })
})
