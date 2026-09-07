/**
 * When an MP4/M4A recording started, read from its container metadata.
 *
 * Lifelog audio arrives with unreliable filenames, so the container's own
 * `mvhd` header is better evidence: it carries a creation instant in UTC
 * plus the track duration. For the recorders seen so far that instant is
 * when recording *stopped*, so the start is `creation - duration`.
 *
 * The read is deliberately structured to cost almost nothing on huge files.
 * An MP4 is a tree of length-prefixed atoms, so the top level can be walked
 * by reading 8-byte headers and skipping the payloads: `mdat` (the audio,
 * often gigabytes) is never touched. On a 153 MB recording with `moov` at
 * 98.5% this resolves in 6 reads totalling ~100 bytes.
 *
 * `RangeReader` keeps that property portable. A local file is one
 * implementation; an HTTP `Range` reader over Drive or S3 is another, and
 * would let an archive be dated without downloading it.
 */
import * as Effect from "effect/Effect"

/** Random access over a byte source, however it is stored. */
export interface RangeReader {
  readonly size: Effect.Effect<number, Error>
  /** Up to `length` bytes at `offset`; short reads at EOF are allowed. */
  readonly read: (offset: number, length: number) => Effect.Effect<Uint8Array, Error>
}

/** Seconds between the QuickTime epoch (1904-01-01) and the Unix epoch. */
const APPLE_EPOCH_OFFSET = 2_082_844_800

/** Guard rails for a plausible recording: rejects zeroed or garbage headers. */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(1990, 0, 1)
const MAX_DURATION_SECONDS = 30 * 24 * 60 * 60

/** Cap the atom walk so a malformed file cannot spin. */
const MAX_ATOMS = 64

const big = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const atomType = (header: Uint8Array) =>
  String.fromCharCode(header[4]!, header[5]!, header[6]!, header[7]!)

export interface Mp4Timing {
  /** Container creation instant, ISO-8601. Recording end for known devices. */
  readonly createdAt: string
  readonly durationSeconds: number
  /** `createdAt - durationSeconds`: when recording began, ISO-8601. */
  readonly startedAt: string
}

/**
 * Walk one level of atoms, calling `onAtom` with each header. Returns when
 * `onAtom` yields a result, the range ends, or the cap is hit.
 */
const walk = <A>(
  reader: RangeReader,
  from: number,
  until: number,
  onAtom: (type: string, bodyOffset: number, bodyLength: number) => Effect.Effect<A | null, Error>
): Effect.Effect<A | null, Error> =>
  Effect.gen(function*() {
    let offset = from
    for (let seen = 0; seen < MAX_ATOMS && offset + 8 <= until; seen++) {
      const header = yield* reader.read(offset, 16)
      if (header.length < 8) return null
      const view = big(header)
      let size = view.getUint32(0)
      let headerSize = 8
      if (size === 1) {
        if (header.length < 16) return null
        // 64-bit extended size. Beyond 2^53 the arithmetic stops being exact,
        // which no real recording reaches.
        size = Number(view.getBigUint64(8))
        headerSize = 16
      } else if (size === 0) {
        // Extends to the end of the enclosing range.
        size = until - offset
      }
      if (size < headerSize) return null
      const found = yield* onAtom(atomType(header), offset + headerSize, size - headerSize)
      if (found !== null) return found
      offset += size
    }
    return null
  })

/** Parse an `mvhd` body into timing, or null if it is not usable. */
const parseMvhd = (body: Uint8Array): Mp4Timing | null => {
  if (body.length < 20) return null
  const view = big(body)
  const version = body[0]
  let createdSeconds: number
  let timescale: number
  let duration: number
  if (version === 1) {
    if (body.length < 32) return null
    createdSeconds = Number(view.getBigUint64(4))
    timescale = view.getUint32(20)
    duration = Number(view.getBigUint64(24))
  } else {
    createdSeconds = view.getUint32(4)
    timescale = view.getUint32(12)
    duration = view.getUint32(16)
  }
  if (timescale === 0) return null
  const createdMs = (createdSeconds - APPLE_EPOCH_OFFSET) * 1000
  const durationSeconds = duration / timescale
  // A zeroed creation time (some encoders) lands in 1904; a garbage one can
  // land anywhere. Both are rejected rather than dated wrongly.
  if (!Number.isFinite(createdMs) || createdMs < EARLIEST_PLAUSIBLE_MS) return null
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > MAX_DURATION_SECONDS) {
    return null
  }
  const startedMs = createdMs - durationSeconds * 1000
  if (startedMs < EARLIEST_PLAUSIBLE_MS) return null
  return {
    createdAt: new Date(createdMs).toISOString(),
    durationSeconds,
    startedAt: new Date(startedMs).toISOString()
  }
}

/**
 * The recording's timing, or null if the container does not carry it.
 *
 * Never fails on unusable input: a file that is not an MP4, or one whose
 * `mvhd` is missing or zeroed, is simply an absence of evidence for the
 * caller to fall back from.
 */
export const probeMp4Timing = (reader: RangeReader): Effect.Effect<Mp4Timing | null, Error> =>
  Effect.gen(function*() {
    const size = yield* reader.size
    if (size < 16) return null
    return yield* walk(reader, 0, size, (type, bodyOffset, bodyLength) =>
      type !== "moov"
        // Skip everything else, `mdat` included: its payload is never read.
        ? Effect.succeed(null)
        : walk(reader, bodyOffset, bodyOffset + bodyLength, (childType, childOffset) =>
          childType !== "mvhd"
            ? Effect.succeed(null)
            : Effect.map(reader.read(childOffset, 32), parseMvhd)))
  })

/** A reader over a local file, using positional reads (no full load). */
export const fileReader = (path: string): RangeReader => ({
  size: Effect.tryPromise({
    try: () => Bun.file(path).stat().then((stat) => stat.size),
    catch: (cause) => new Error(`stat ${path}: ${cause}`)
  }),
  read: (offset, length) =>
    Effect.tryPromise({
      try: async () => {
        const slice = Bun.file(path).slice(offset, offset + length)
        return new Uint8Array(await slice.arrayBuffer())
      },
      catch: (cause) => new Error(`read ${path}: ${cause}`)
    })
})

/**
 * A reader over an HTTP resource that supports byte ranges.
 *
 * This is what makes dating a remote archive cheap: the same probe that
 * reads ~100 bytes of a local file issues a handful of small Range requests
 * instead of downloading gigabytes. Callers supply `fetch` so auth headers
 * (a Drive token, a signed S3 URL) stay their concern.
 *
 * A server that ignores `Range` and returns 200 with the whole body would
 * defeat the purpose, so that is treated as unsupported rather than read.
 */
export const httpRangeReader = (
  url: string,
  request: (url: string, headers: Record<string, string>) => Promise<Response>
): RangeReader => ({
  size: Effect.tryPromise({
    try: async () => {
      const response = await request(url, { range: "bytes=0-0" })
      if (response.status !== 206) throw new Error(`range unsupported (status ${response.status})`)
      const total = response.headers.get("content-range")?.split("/").at(-1)
      const size = Number(total)
      if (!Number.isFinite(size) || size <= 0) throw new Error("no content-range length")
      return size
    },
    catch: (cause) => new Error(`size ${url}: ${cause}`)
  }),
  read: (offset, length) =>
    Effect.tryPromise({
      try: async () => {
        const response = await request(url, { range: `bytes=${offset}-${offset + length - 1}` })
        if (response.status !== 206) throw new Error(`range unsupported (status ${response.status})`)
        return new Uint8Array(await response.arrayBuffer())
      },
      catch: (cause) => new Error(`read ${url}: ${cause}`)
    })
})
