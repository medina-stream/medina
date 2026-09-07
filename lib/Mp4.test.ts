import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { probeMp4Timing, type RangeReader } from "./Mp4.ts"

const APPLE_EPOCH_OFFSET = 2_082_844_800

const be32 = (value: number) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

const be64 = (value: number) => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value))
  return out
}

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const ascii = (text: string) => new Uint8Array([...text].map((char) => char.charCodeAt(0)))

/** A length-prefixed atom. */
const atom = (type: string, body: Uint8Array) =>
  concat([be32(body.length + 8), ascii(type), body])

/** An atom declaring a 64-bit extended size. */
const atom64 = (type: string, body: Uint8Array) =>
  concat([be32(1), ascii(type), be64(body.length + 16), body])

const mvhd = (
  { created, timescale = 1000, duration, version = 0 }: {
    created: number
    timescale?: number
    duration: number
    version?: 0 | 1
  }
) =>
  version === 1
    ? atom("mvhd", concat([
      new Uint8Array([1, 0, 0, 0]),
      be64(created),
      be64(created),
      be32(timescale),
      be64(duration),
      new Uint8Array(12)
    ]))
    : atom("mvhd", concat([
      new Uint8Array([0, 0, 0, 0]),
      be32(created),
      be32(created),
      be32(timescale),
      be32(duration),
      new Uint8Array(12)
    ]))

const ftyp = atom("ftyp", ascii("mp42mp42"))

/** Counts what a probe actually touches, which is the point of the design. */
const readerOf = (bytes: Uint8Array) => {
  const stats = { reads: 0, bytes: 0, maxOffset: 0 }
  const reader: RangeReader = {
    size: Effect.succeed(bytes.length),
    read: (offset, length) =>
      Effect.sync(() => {
        stats.reads++
        const slice = bytes.slice(offset, offset + length)
        stats.bytes += slice.length
        stats.maxOffset = Math.max(stats.maxOffset, offset + slice.length)
        return slice
      })
  }
  return { reader, stats }
}

const probe = (bytes: Uint8Array) => {
  const { reader, stats } = readerOf(bytes)
  return { result: Effect.runSync(probeMp4Timing(reader)), stats }
}

// 2026-09-05T14:52:42Z, the creation instant of a real 10.4h recording.
const CREATED_ISO = "2026-09-05T14:52:42.000Z"
const created = APPLE_EPOCH_OFFSET + Date.parse(CREATED_ISO) / 1000

describe("probeMp4Timing", () => {
  /**
   * The finding this module is built on: for these recorders `mvhd`'s
   * creation time is when recording *stopped*, so the start is
   * `creation - duration`. Verified against 20 real files, where
   * `creation - duration` matched the filename stamp within 3 seconds.
   */
  test("start is creation minus duration", () => {
    const bytes = concat([
      ftyp,
      atom("mdat", new Uint8Array(4096)),
      atom("moov", mvhd({ created, timescale: 1000, duration: 37_538_432 }))
    ])
    const { result } = probe(bytes)
    expect(result?.createdAt).toBe(CREATED_ISO)
    expect(result?.durationSeconds).toBeCloseTo(37538.432, 3)
    expect(result?.startedAt).toBe("2026-09-05T04:27:03.568Z")
  })

  /** The efficiency claim: `mdat` is skipped, never read. */
  test("a huge mdat is never touched", () => {
    const mdatBytes = 8_000_000
    const bytes = concat([
      ftyp,
      atom("mdat", new Uint8Array(mdatBytes)),
      atom("moov", mvhd({ created, duration: 60_000 }))
    ])
    const { result, stats } = probe(bytes)
    expect(result).not.toBeNull()
    expect(stats.bytes).toBeLessThan(200)
    expect(stats.reads).toBeLessThan(10)
    // Only headers before mdat, then the tail: nothing inside the payload.
    expect(stats.bytes / bytes.length).toBeLessThan(0.0001)
  })

  test("moov at the front (faststart) works too", () => {
    const bytes = concat([
      ftyp,
      atom("moov", mvhd({ created, duration: 60_000 })),
      atom("mdat", new Uint8Array(4096))
    ])
    expect(probe(bytes).result?.startedAt).toBe("2026-09-05T14:51:42.000Z")
  })

  test("64-bit atom sizes are followed", () => {
    const bytes = concat([
      ftyp,
      atom64("mdat", new Uint8Array(1024)),
      atom("moov", mvhd({ created, duration: 60_000 }))
    ])
    expect(probe(bytes).result?.startedAt).toBe("2026-09-05T14:51:42.000Z")
  })

  test("a version-1 mvhd is read with 64-bit fields", () => {
    const bytes = concat([
      ftyp,
      atom("moov", mvhd({ created, duration: 60_000, version: 1 }))
    ])
    expect(probe(bytes).result?.startedAt).toBe("2026-09-05T14:51:42.000Z")
  })

  test("mvhd is found even when it is not moov's first child", () => {
    const bytes = concat([
      ftyp,
      atom("moov", concat([
        atom("udta", ascii("some metadata")),
        mvhd({ created, duration: 60_000 })
      ]))
    ])
    expect(probe(bytes).result?.startedAt).toBe("2026-09-05T14:51:42.000Z")
  })

  test("an mdat with size 0 runs to EOF and yields no timing", () => {
    const bytes = concat([ftyp, concat([be32(0), ascii("mdat"), new Uint8Array(512)])])
    expect(probe(bytes).result).toBeNull()
  })

  describe("absence of evidence, not a failure", () => {
    test("no moov", () => {
      expect(probe(concat([ftyp, atom("mdat", new Uint8Array(64))])).result).toBeNull()
    })

    test("moov without mvhd", () => {
      expect(probe(concat([ftyp, atom("moov", atom("udta", ascii("x")))])).result).toBeNull()
    })

    test("a zeroed creation time is rejected rather than dated to 1904", () => {
      const bytes = concat([ftyp, atom("moov", mvhd({ created: 0, duration: 60_000 }))])
      expect(probe(bytes).result).toBeNull()
    })

    test("a zero timescale cannot divide", () => {
      const bytes = concat([ftyp, atom("moov", mvhd({ created, timescale: 0, duration: 1000 }))])
      expect(probe(bytes).result).toBeNull()
    })

    test("an implausibly long duration is rejected", () => {
      const bytes = concat([
        ftyp,
        atom("moov", mvhd({ created, timescale: 1, duration: 400 * 24 * 3600 }))
      ])
      expect(probe(bytes).result).toBeNull()
    })

    test("not an MP4 at all", () => {
      expect(probe(ascii("this is a plain text file, not audio")).result).toBeNull()
    })

    test("empty and truncated input", () => {
      expect(probe(new Uint8Array(0)).result).toBeNull()
      expect(probe(ascii("0000")).result).toBeNull()
    })
  })
})
