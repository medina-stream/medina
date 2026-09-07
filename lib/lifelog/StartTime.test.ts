import { describe, expect, test } from "bun:test"
import {
  AGREEMENT_WINDOW_SECONDS,
  decideStart,
  defaultStartTimeRules,
  matchFilenameStamp,
  type StartEvidence,
  startTimeRulesDigest,
  type StartTimeRules
} from "./StartTime.ts"

/** PDT is UTC-7 in September; enough to exercise the policy. */
const toUtc = (wallClock: string, zone: string): string | null => {
  const offset = zone === "America/Los_Angeles" ? 7 : 0
  const parsed = Date.parse(`${wallClock}Z`)
  return Number.isNaN(parsed) ? null : new Date(parsed + offset * 3600_000).toISOString()
}

const evidence = (over: Partial<StartEvidence> = {}): StartEvidence => ({
  source: null,
  filename: null,
  containerCreatedAt: null,
  containerDurationSeconds: null,
  legacyWallClock: null,
  modifiedAt: null,
  zone: "America/Los_Angeles",
  toUtc,
  ...over
})

/** A filename carrying a stamp, in this archive's format. */
const named = (wallClock: string) => `sco-lifelog-0${wallClock.replace(/[-:]/g, "")}.m4a`

/** Container evidence for a recording that ended at `end` after `seconds`. */
const container = (end: string, seconds: number) => ({
  containerCreatedAt: end,
  containerDurationSeconds: seconds
})

describe("decideStart", () => {
  test("agreeing filename and container is the strongest claim", () => {
    // The common case: 31 of 32 real recordings agreed within 2s.
    const decision = decideStart(evidence({
      filename: named("2026-09-07T11:01:12"),
      ...container("2026-09-07T18:55:10.000Z", 3237.568)
    }))
    expect(decision.method).toBe("filename-and-container")
    expect(decision.confidence).toBe("high")
    expect(decision.startUtc).toBe("2026-09-07T18:01:12.000Z")
    expect(decision.disagreementSeconds).toBeLessThan(2)
    expect(decision.filenamePattern).toBe("medina-0-prefixed")
  })

  /**
   * The real outlier: `020260903T140436` probed 888s later than its
   * filename, because the encoded duration excludes a pause. The earlier
   * instant is the record-press, and confidence drops to say so.
   */
  test("on disagreement the earlier instant wins, at lower confidence", () => {
    const decision = decideStart(evidence({
      filename: named("2026-09-03T14:04:36"),
      ...container("2026-09-04T02:52:29.000Z", 19984.96)
    }))
    expect(decision.startUtc).toBe("2026-09-03T21:04:36.000Z")
    expect(decision.method).toBe("filename-stamp")
    expect(decision.confidence).toBe("medium")
    expect(Math.round(decision.disagreementSeconds!)).toBe(888)
  })

  test("a container earlier than the filename is also taken", () => {
    const decision = decideStart(evidence({
      filename: named("2026-09-03T14:04:36"),
      ...container("2026-09-03T21:00:00.000Z", 3600)
    }))
    expect(decision.startUtc).toBe("2026-09-03T20:00:00.000Z")
    expect(decision.method).toBe("container-mvhd")
    expect(decision.confidence).toBe("medium")
  })

  test("the agreement window is inclusive at its edge", () => {
    const base = Date.parse("2026-09-07T18:01:12Z")
    const inside = decideStart(evidence({
      filename: named("2026-09-07T11:01:12"),
      containerCreatedAt: new Date(base + AGREEMENT_WINDOW_SECONDS * 1000).toISOString(),
      containerDurationSeconds: 0
    }))
    expect(inside.method).toBe("filename-and-container")
    const outside = decideStart(evidence({
      filename: named("2026-09-07T11:01:12"),
      containerCreatedAt: new Date(base + (AGREEMENT_WINDOW_SECONDS + 1) * 1000).toISOString(),
      containerDurationSeconds: 0
    }))
    expect(outside.method).not.toBe("filename-and-container")
  })

  test("container alone is high confidence: an absolute instant, no zone guess", () => {
    const decision = decideStart(evidence(container("2026-09-07T18:55:10.000Z", 3237.568)))
    expect(decision.method).toBe("container-mvhd")
    expect(decision.confidence).toBe("high")
    expect(decision.startUtc).toBe("2026-09-07T18:01:12.432Z")
  })

  test("filename alone is medium: exact clock, assumed zone", () => {
    const decision = decideStart(evidence({ filename: named("2026-09-07T11:01:12") }))
    expect(decision.method).toBe("filename-stamp")
    expect(decision.confidence).toBe("medium")
    expect(decision.startUtc).toBe("2026-09-07T18:01:12.000Z")
  })

  test("modified time is a last resort, marked low", () => {
    const decision = decideStart(evidence({ modifiedAt: "2026-09-08T06:55:10.000Z" }))
    expect(decision.method).toBe("modified-time")
    expect(decision.confidence).toBe("low")
  })

  test("better evidence always outranks modified time", () => {
    expect(decideStart(evidence({
      filename: named("2026-09-07T11:01:12"),
      modifiedAt: "2026-09-08T06:55:10.000Z"
    })).method).toBe("filename-stamp")
    expect(decideStart(evidence({
      ...container("2026-09-07T18:55:10.000Z", 3237.568),
      modifiedAt: "2026-09-08T06:55:10.000Z"
    })).method).toBe("container-mvhd")
  })

  test("no evidence is stated as such, not guessed", () => {
    const decision = decideStart(evidence())
    expect(decision.startUtc).toBeNull()
    expect(decision.method).toBe("none")
    expect(decision.confidence).toBe("none")
  })

  test("an unusable zone yields no decision rather than a wrong one", () => {
    const decision = decideStart(evidence({ filename: "no-stamp-here.m4a" }))
    expect(decision.startUtc).toBeNull()
  })
})

describe("filename patterns", () => {
  const patterns = defaultStartTimeRules.filenamePatterns

  test("recognizes this archive's recorder", () => {
    const found = matchFilenameStamp("sco-lifelog-020260907T110112.m4a", patterns)
    expect(found?.wallClock).toBe("2026-09-07T11:01:12")
    expect(found?.pattern.name).toBe("medina-0-prefixed")
  })

  test("recognizes common phone recorder formats", () => {
    expect(matchFilenameStamp("Recording 2026-09-07 11.01.12.m4a", patterns)?.wallClock)
      .toBe("2026-09-07T11:01:12")
    expect(matchFilenameStamp("audio_2026-09-07_11-01-12.mp4", patterns)?.wallClock)
      .toBe("2026-09-07T11:01:12")
    expect(matchFilenameStamp("VID20260907T110112.mp4", patterns)?.wallClock)
      .toBe("2026-09-07T11:01:12")
  })

  test("no stamp is null, not a guess", () => {
    expect(matchFilenameStamp("voice-memo.m4a", patterns)).toBeNull()
    expect(matchFilenameStamp("", patterns)).toBeNull()
  })

  test("digits that are not a date are rejected", () => {
    // Month 47 cannot be a date; a looser matcher would date this capture.
    expect(matchFilenameStamp("track-020264799T990000.m4a", patterns)).toBeNull()
  })

  test("an application pattern can declare a fixed zone", () => {
    const rules: StartTimeRules = {
      ...defaultStartTimeRules,
      filenamePatterns: [
        { name: "utc-recorder", pattern: /UTC(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/, zone: "UTC" },
        ...defaultStartTimeRules.filenamePatterns
      ]
    }
    const decision = decideStart(
      evidence({ filename: "dictaphone-UTC20260907_180112.wav" }),
      rules
    )
    // Read as UTC, not shifted by the believed local zone.
    expect(decision.startUtc).toBe("2026-09-07T18:01:12.000Z")
    expect(decision.zone).toBe("UTC")
    expect(decision.filenamePattern).toBe("utc-recorder")
  })
})

describe("application rules", () => {
  const withRules = (rules: StartTimeRules["rules"]): StartTimeRules => ({
    ...defaultStartTimeRules,
    rules
  })

  test("a recorder whose container stamps the start, not the end", () => {
    const rules = withRules([
      { name: "stamps-start", filename: /^DS\d/, container: "start" }
    ])
    const decision = decideStart(
      evidence({ filename: "DS700123.mp3", ...container("2026-09-07T18:01:12.000Z", 3600) }),
      rules
    )
    // Without the rule this would resolve an hour earlier.
    expect(decision.startUtc).toBe("2026-09-07T18:01:12.000Z")
    expect(decision.appliedRules).toEqual(["stamps-start"])
  })

  test("a trip: zone-less stamps were another zone that week", () => {
    const rules = withRules([
      { name: "berlin-trip", from: "2026-06-14", until: "2026-06-29", zone: "UTC" }
    ])
    const inTrip = decideStart(evidence({ filename: named("2026-06-20T09:00:00") }), rules)
    expect(inTrip.zone).toBe("UTC")
    expect(inTrip.startUtc).toBe("2026-06-20T09:00:00.000Z")
    // Outside the window the rule does not apply.
    const after = decideStart(evidence({ filename: named("2026-07-01T09:00:00") }), rules)
    expect(after.zone).toBe("America/Los_Angeles")
    expect(after.appliedRules).toEqual([])
  })

  test("a known clock skew is corrected by shifting", () => {
    const rules = withRules([
      { name: "fast-clock", source: /^easy-voice$/, shiftSeconds: -1800 }
    ])
    const decision = decideStart(
      evidence({ source: "easy-voice", filename: named("2026-09-07T11:01:12") }),
      rules
    )
    expect(decision.startUtc).toBe("2026-09-07T17:31:12.000Z")
  })

  test("later rules win, and shifts accumulate", () => {
    const rules = withRules([
      { name: "first", source: /easy/, zone: "UTC", shiftSeconds: 60 },
      { name: "second", source: /easy/, zone: "America/New_York", shiftSeconds: 60 }
    ])
    const decision = decideStart(
      evidence({ source: "easy-voice", filename: named("2026-09-07T11:01:12") }),
      rules
    )
    expect(decision.zone).toBe("America/New_York")
    expect(decision.appliedRules).toEqual(["first", "second"])
    // Both shifts applied: +120s on top of the New York conversion.
    expect(decision.startUtc).toBe("2026-09-07T11:03:12.000Z")
  })

  test("a rule that matches nothing changes nothing", () => {
    const plain = decideStart(evidence({ filename: named("2026-09-07T11:01:12") }))
    const withUnrelated = decideStart(
      evidence({ filename: named("2026-09-07T11:01:12") }),
      withRules([{ name: "other-device", filename: /^DS\d/, shiftSeconds: 9999 }])
    )
    expect(withUnrelated.startUtc).toBe(plain.startUtc)
    expect(withUnrelated.appliedRules).toEqual([])
  })

  test("ignoring a recorder's container falls back to its filename", () => {
    const rules = withRules([{ name: "bad-metadata", source: /junk/, container: "ignore" }])
    const decision = decideStart(
      evidence({
        source: "junk-recorder",
        filename: named("2026-09-07T11:01:12"),
        ...container("2001-01-01T00:00:00.000Z", 60)
      }),
      rules
    )
    expect(decision.method).toBe("filename-stamp")
    expect(decision.startUtc).toBe("2026-09-07T18:01:12.000Z")
  })
})

describe("startTimeRulesDigest", () => {
  /**
   * The digest is what makes rules safe to iterate on: it goes into the
   * attribution basis hash, so editing a rule re-derives the captures it
   * affects instead of leaving stale beliefs on disk.
   */
  test("changes when any rule changes", () => {
    const base = defaultStartTimeRules
    const digest = startTimeRulesDigest(base)
    expect(startTimeRulesDigest(base)).toBe(digest)

    const added = startTimeRulesDigest({
      ...base,
      rules: [{ name: "new", source: /x/, shiftSeconds: 1 }]
    })
    expect(added).not.toBe(digest)

    // Same rule name, different pattern: still a real change.
    const edited = startTimeRulesDigest({
      ...base,
      rules: [{ name: "new", source: /y/, shiftSeconds: 1 }]
    })
    expect(edited).not.toBe(added)

    // Same rule, different shift.
    const reshifted = startTimeRulesDigest({
      ...base,
      rules: [{ name: "new", source: /y/, shiftSeconds: 2 }]
    })
    expect(reshifted).not.toBe(edited)
  })

  test("a changed filename pattern changes the digest", () => {
    const digest = startTimeRulesDigest(defaultStartTimeRules)
    const extra = startTimeRulesDigest({
      ...defaultStartTimeRules,
      filenamePatterns: [
        { name: "extra", pattern: /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/ },
        ...defaultStartTimeRules.filenamePatterns
      ]
    })
    expect(extra).not.toBe(digest)
  })
})
