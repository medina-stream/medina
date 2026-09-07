import { describe, expect, test } from "bun:test"
import { AGREEMENT_WINDOW_SECONDS, decideStart, type StartEvidence } from "./StartTime.ts"

/** PDT is UTC-7 in September; enough to exercise the policy. */
const toUtc = (wallClock: string, zone: string): string | null => {
  const offset = zone === "America/Los_Angeles" ? 7 : 0
  const parsed = Date.parse(`${wallClock}Z`)
  return Number.isNaN(parsed) ? null : new Date(parsed + offset * 3600_000).toISOString()
}

const evidence = (over: Partial<StartEvidence> = {}): StartEvidence => ({
  filenameWallClock: null,
  containerStartUtc: null,
  modifiedWallClock: null,
  zone: "America/Los_Angeles",
  toUtc,
  ...over
})

describe("decideStart", () => {
  test("agreeing filename and container is the strongest claim", () => {
    // The common case: 31 of 32 real recordings agreed within 2s.
    const decision = decideStart(evidence({
      filenameWallClock: "2026-09-07T11:01:12",
      containerStartUtc: "2026-09-07T18:01:12.432Z"
    }))
    expect(decision.method).toBe("filename-and-container")
    expect(decision.confidence).toBe("high")
    expect(decision.startUtc).toBe("2026-09-07T18:01:12.000Z")
    expect(decision.disagreementSeconds).toBeLessThan(1)
  })

  /**
   * The real outlier: `020260903T140436` probed 888s later than its
   * filename, because the encoded duration excludes a pause. The earlier
   * instant is the record-press, and confidence drops to say so.
   */
  test("on disagreement the earlier instant wins, at lower confidence", () => {
    const decision = decideStart(evidence({
      filenameWallClock: "2026-09-03T14:04:36",
      containerStartUtc: "2026-09-03T21:19:24.040Z"
    }))
    expect(decision.startUtc).toBe("2026-09-03T21:04:36.000Z")
    expect(decision.method).toBe("filename-stamp")
    expect(decision.confidence).toBe("medium")
    expect(Math.round(decision.disagreementSeconds!)).toBe(888)
  })

  test("a container earlier than the filename is also taken", () => {
    const decision = decideStart(evidence({
      filenameWallClock: "2026-09-03T14:04:36",
      containerStartUtc: "2026-09-03T20:00:00.000Z"
    }))
    expect(decision.startUtc).toBe("2026-09-03T20:00:00.000Z")
    expect(decision.method).toBe("container-mvhd")
    expect(decision.confidence).toBe("medium")
  })

  test("the agreement window is inclusive at its edge", () => {
    const base = Date.parse("2026-09-07T18:01:12Z")
    const inside = decideStart(evidence({
      filenameWallClock: "2026-09-07T11:01:12",
      containerStartUtc: new Date(base + AGREEMENT_WINDOW_SECONDS * 1000).toISOString()
    }))
    expect(inside.method).toBe("filename-and-container")
    const outside = decideStart(evidence({
      filenameWallClock: "2026-09-07T11:01:12",
      containerStartUtc: new Date(base + (AGREEMENT_WINDOW_SECONDS + 1) * 1000).toISOString()
    }))
    expect(outside.method).not.toBe("filename-and-container")
  })

  test("container alone is high confidence: an absolute instant, no zone guess", () => {
    const decision = decideStart(evidence({ containerStartUtc: "2026-09-07T18:01:12.432Z" }))
    expect(decision.method).toBe("container-mvhd")
    expect(decision.confidence).toBe("high")
    expect(decision.startUtc).toBe("2026-09-07T18:01:12.432Z")
  })

  test("filename alone is medium: exact clock, assumed zone", () => {
    const decision = decideStart(evidence({ filenameWallClock: "2026-09-07T11:01:12" }))
    expect(decision.method).toBe("filename-stamp")
    expect(decision.confidence).toBe("medium")
    expect(decision.startUtc).toBe("2026-09-07T18:01:12.000Z")
  })

  test("modified time is a last resort, marked low", () => {
    const decision = decideStart(evidence({ modifiedWallClock: "2026-09-07T23:55:10" }))
    expect(decision.method).toBe("modified-time")
    expect(decision.confidence).toBe("low")
  })

  test("better evidence always outranks modified time", () => {
    expect(decideStart(evidence({
      filenameWallClock: "2026-09-07T11:01:12",
      modifiedWallClock: "2026-09-07T23:55:10"
    })).method).toBe("filename-stamp")
    expect(decideStart(evidence({
      containerStartUtc: "2026-09-07T18:01:12.432Z",
      modifiedWallClock: "2026-09-07T23:55:10"
    })).method).toBe("container-mvhd")
  })

  test("no evidence is stated as such, not guessed", () => {
    const decision = decideStart(evidence())
    expect(decision.startUtc).toBeNull()
    expect(decision.method).toBe("none")
    expect(decision.confidence).toBe("none")
  })

  test("an unusable zone yields no decision rather than a wrong one", () => {
    const decision = decideStart(evidence({
      filenameWallClock: "not-a-time",
      zone: "America/Los_Angeles"
    }))
    expect(decision.startUtc).toBeNull()
  })
})
