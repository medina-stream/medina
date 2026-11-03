/**
 * Media-normalize on the Worker (migration milestone 4 step 5 —
 * docs/cloudflare-migration.md §4.3): the port of medina-dev's
 * media-normalize stage (lib/capture/Media.ts `mediaNormalizeSource`
 * + lib/capture/TransloaditNormalize.ts `normalize`).
 *
 * What the stage does, unchanged: every capture is probed once;
 * captures already in canonical-ish form (compact codec, mono
 * 16 kHz, at most an hour) skip the transcode — the archived
 * original IS the chunk and the manifest points at it. Everything
 * else goes to Transloadit as ONE assembly (import the original
 * from a presigned R2 URL → /audio/split into fixed four-hour
 * segments → /s3/store the chunks back into R2 with Medina-minted
 * short-lived credentials), coordinated through a durable receipt
 * at normalize/transloadit/<captureId>.json: a pass fires or polls,
 * never blocks. Audio bytes never cross this Worker, exactly as
 * they never cross medina-dev.
 *
 * What the move changes, and why:
 *
 *   - No ffprobe exists on the Worker. The stored probe record
 *     (capture/<id>/ffprobe.json) is the first source — during the
 *     rehearsal medina-dev has already probed everything, and its
 *     records stay authoritative where they exist. For captures
 *     with no record the Worker derives the same verdict from the
 *     container bytes with bounded range reads (MP4/M4A box walk,
 *     RIFF/WAVE fmt walk, MP3 frame/Xing parse, FLAC STREAMINFO,
 *     Ogg/Opus headers) and caches it in the stage's own notebook —
 *     it never fabricates an ffprobe.json, which downstream
 *     attribution reads as ffprobe's literal output. The rehearsal
 *     diff compares every derivation against medina-dev's stored
 *     record for the same capture before any flip.
 *   - No local ffmpeg fallback exists here either (medina-dev's
 *     unconfigured-Transloadit path). On the Worker an unbound
 *     Transloadit key means transcode-path captures wait, counted
 *     in the report — the direct path still runs.
 *   - R2 credentials come from src/r2creds.ts (the stack-minted
 *     bucket keypair + locally minted temporary credentials)
 *     instead of the edge-injected token medina-dev uses; the
 *     credential SHAPES Transloadit and R2 see are the same.
 *   - Per-item failure isolation is deliberate (the §4.2
 *     hardening): on medina-dev one capture's failure can fail
 *     the whole stage pass (the media sources use an unbounded,
 *     fail-fast forEach); here every capture is reconciled inside
 *     its own catch, so a bad capture — or a medina-index 500
 *     while registering its manifest — degrades that capture
 *     only, and the pass report names it.
 *
 * Modes (NORMALIZE_MODE in alchemy.run.ts): "shadow" plans and
 * diffs against what medina-dev produced, writing nothing outside
 * the stage's notebook; "live" performs. The manual endpoint can
 * also run one capture as a PROOF: the full live flow with every
 * write redirected under normalize-proof/, spending at most one
 * Transloadit assembly, so the chain can be proven end-to-end
 * without touching production artifacts.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ArtifactLedger,
  type ArtifactReadError,
  type IndexRequestError,
  NotebookError,
  sha256Hex,
} from "./capture.ts";
import {
  ArtifactCatalog,
  type CatalogError,
  type CatalogHead,
} from "./catalog.ts";
import {
  accountIdFromEndpoint,
  mintTempCredentials,
  parseS3Credentials,
  presignGetUrl,
  type R2CredsError,
  type S3CredentialsValue,
  type TempCredentials,
} from "./r2creds.ts";

// ---------------------------------------------------------------------------
// Keys and constants — mirrors of the lib values they must agree with.
// ---------------------------------------------------------------------------

export const MEDIA_VERSION = "media-v1";
export const CHUNK_SECONDS = 14400;
/** The direct path's ceiling (lib: DIRECT_CHUNK_MAX_SECONDS). */
export const DIRECT_CHUNK_MAX_SECONDS = 3600;
const WORKFLOW_VERSION = "remote-media-v1";
/** Import presign + store-credential lifetime (lib: JOB_TTL_SECONDS). */
const JOB_TTL_SECONDS = 24 * 60 * 60;
const MAX_CHUNKS = 200;
const MAX_CHUNK_ATTEMPTS = 3;
const CHUNK_NAME_PATTERN = /_(\d+)\.ogg$/;
const DIRECT_CODECS = new Set(["opus", "aac"]);

export const captureDir = (captureId: string) => `capture/${captureId}`;
export const ffprobeKey = (captureId: string) =>
  `${captureDir(captureId)}/ffprobe.json`;
export const mediaManifestKey = (captureId: string) =>
  `media/${MEDIA_VERSION}/${captureId}.json`;
export const mediaChunkPrefix = (captureId: string) =>
  `media/${MEDIA_VERSION}/${captureId}/`;
export const canonicalMediaKey = (captureId: string) =>
  `media/${MEDIA_VERSION}/${captureId}/canonical.ogg`;
export const normalizeSettledKey = (captureId: string) =>
  `normalize-settled/${MEDIA_VERSION}/${captureId}.json`;
export const transloaditReceiptKey = (captureId: string) =>
  `normalize/transloadit/${captureId}.json`;

const METADATA_NAMES = new Set([
  "provenance.json",
  "media-timing.json",
  "ffprobe.json",
]);

// ---------------------------------------------------------------------------
// Probe verdicts: one shape, two sources (stored ffprobe JSON, or the
// Worker's own derivation from the container bytes).
// ---------------------------------------------------------------------------

export interface ProbeVerdict {
  readonly media: boolean;
  /** The first audio stream's codec, when media. */
  readonly codec: string | null;
  readonly channels: number | null;
  /** Sample rate as a number (ffprobe carries it as a string). */
  readonly sampleRate: number | null;
  /** Format duration in seconds (lib: probeDuration reads format only). */
  readonly durationSeconds: number | null;
}

const NOT_MEDIA: ProbeVerdict = {
  media: false,
  codec: null,
  channels: null,
  sampleRate: null,
  durationSeconds: null,
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The verdict inside a stored ffprobe.json ProbeRecord. */
export const verdictFromStoredProbe = (
  probeRecordJson: unknown,
): { readonly verdict: ProbeVerdict; readonly blobName: string | null } | null => {
  if (typeof probeRecordJson !== "object" || probeRecordJson === null) {
    return null;
  }
  const envelope = probeRecordJson as Record<string, unknown>;
  if (typeof envelope["captureId"] !== "string") return null;
  const ffprobe = record(envelope["ffprobe"]);
  const streams = Array.isArray(ffprobe["streams"]) ? ffprobe["streams"] : [];
  const audio = streams
    .map(record)
    .find((stream) => stream["codec_type"] === "audio");
  const formatDuration = Number(record(ffprobe["format"])["duration"]);
  const media =
    envelope["media"] === true ||
    (envelope["media"] === undefined && audio !== undefined);
  return {
    blobName: text(envelope["blobName"]),
    verdict: {
      media,
      codec: audio === undefined ? null : text(audio["codec_name"]),
      channels: audio === undefined ? null : number(audio["channels"]),
      sampleRate:
        audio === undefined || audio["sample_rate"] === undefined
          ? null
          : Number(audio["sample_rate"]) || null,
      durationSeconds:
        Number.isFinite(formatDuration) && formatDuration > 0
          ? formatDuration
          : null,
    },
  };
};

/** lib's directChunkFor, over a verdict instead of raw ffprobe JSON. */
export const directChunkFor = (
  verdict: ProbeVerdict,
): { readonly durationSeconds: number } | null => {
  if (!verdict.media || verdict.codec === null) return null;
  if (!DIRECT_CODECS.has(verdict.codec)) return null;
  if (verdict.channels !== 1 || verdict.sampleRate !== 16000) return null;
  if (
    verdict.durationSeconds === null ||
    verdict.durationSeconds > DIRECT_CHUNK_MAX_SECONDS
  ) {
    return null;
  }
  return { durationSeconds: verdict.durationSeconds };
};

/** lib's segmentsFor (TransloaditNormalize): fixed spans, capped. */
export const segmentsFor = (
  durationSeconds: number,
): ReadonlyArray<{ readonly from: number; readonly to: number }> => {
  const count = Math.ceil(durationSeconds / CHUNK_SECONDS);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(
      `cannot chunk media with invalid duration ${durationSeconds}`,
    );
  }
  if (count > MAX_CHUNKS) {
    throw new Error(
      `media duration ${durationSeconds}s exceeds the ${MAX_CHUNKS}-chunk safety limit`,
    );
  }
  return Array.from({ length: count }, (_, index) => ({
    from: index * CHUNK_SECONDS,
    to: Math.min(durationSeconds, (index + 1) * CHUNK_SECONDS),
  }));
};

// ---------------------------------------------------------------------------
// Container derivations. A RangeReader keeps every probe to a handful
// of small reads: atom/chunk headers are walked, payloads are never
// read (the same discipline as lib/Mp4.ts).
// ---------------------------------------------------------------------------

export interface RangeReader {
  readonly size: number;
  /** Up to `length` bytes at `offset`; short reads at EOF are allowed. */
  readonly read: (
    offset: number,
    length: number,
  ) => Effect.Effect<Uint8Array, Error>;
}

const u32be = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
  );
const u64be = (bytes: Uint8Array, offset: number): number =>
  Number(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
      offset,
    ),
  );
const typeAt = (bytes: Uint8Array, offset: number): string =>
  String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );

interface BoxHead {
  readonly type: string;
  readonly bodyOffset: number;
  readonly bodyLength: number;
}

/** List one level of MP4 boxes by their headers alone — payloads
 * (mdat above all) are skipped by size, never read. */
const listBoxes = (
  reader: RangeReader,
  from: number,
  until: number,
): Effect.Effect<ReadonlyArray<BoxHead>, Error> =>
  Effect.gen(function* () {
    const boxes: Array<BoxHead> = [];
    let offset = from;
    for (let seen = 0; seen < 64 && offset + 8 <= until; seen++) {
      const header = yield* reader.read(offset, 16);
      if (header.length < 8) break;
      let size = u32be(header, 0);
      let headerSize = 8;
      if (size === 1) {
        if (header.length < 16) break;
        size = u64be(header, 8);
        headerSize = 16;
      } else if (size === 0) {
        size = until - offset;
      }
      if (size < headerSize) break;
      boxes.push({
        type: typeAt(header, 4),
        bodyOffset: offset + headerSize,
        bodyLength: size - headerSize,
      });
      offset += size;
    }
    return boxes;
  });

const findChild = (
  boxes: ReadonlyArray<BoxHead>,
  type: string,
): BoxHead | undefined => boxes.find((box) => box.type === type);

interface Mp4AudioTrack {
  readonly codec: string;
  readonly channels: number | null;
  readonly sampleRate: number | null;
}

/** Parse one stsd box body: the first entry decides the codec. */
const parseStsd = (body: Uint8Array): Mp4AudioTrack | null => {
  if (body.length < 8) return null;
  const entryOffset = 8;
  if (body.length < entryOffset + 8) return null;
  const entryType = typeAt(body, entryOffset + 4);
  if (entryType === "mp4a") {
    // AudioSampleEntry (version 0 layout): channels at +24,
    // sample rate (16.16 fixed) at +32, relative to the entry start.
    let channels: number | null = null;
    let sampleRate: number | null = null;
    if (body.length >= entryOffset + 28) {
      channels = new DataView(
        body.buffer,
        body.byteOffset,
        body.byteLength,
      ).getUint16(entryOffset + 24);
    }
    if (body.length >= entryOffset + 36) {
      sampleRate =
        u32be(body, entryOffset + 32) / 65536;
    }
    return { codec: "aac", channels, sampleRate };
  }
  if (entryType === "Opus") {
    // OpusSampleEntry: same sample-entry prefix; channels at +24,
    // and dOps carries the channel count again at its own +9. The
    // sample rate field is the encoder's input rate; ffprobe
    // reports Opus at 48000 regardless, and the direct path's
    // 16 kHz test is what matters — report the field as-is and let
    // OpusHead-free files fall where they fall.
    let channels: number | null = null;
    if (body.length >= entryOffset + 28) {
      channels = new DataView(
        body.buffer,
        body.byteOffset,
        body.byteLength,
      ).getUint16(entryOffset + 24);
    }
    let sampleRate: number | null = null;
    if (body.length >= entryOffset + 36) {
      sampleRate = u32be(body, entryOffset + 32) / 65536;
    }
    return { codec: "opus", channels, sampleRate };
  }
  return { codec: entryType, channels: null, sampleRate: null };
};

/** MP4/M4A: mvhd gives the duration; the first 'soun' track's stsd
 * gives codec/channels/rate. Null when the bytes are not an MP4. */
export const deriveMp4Verdict = (
  reader: RangeReader,
): Effect.Effect<ProbeVerdict | null, Error> =>
  Effect.gen(function* () {
    const head = yield* reader.read(0, 16);
    if (head.length < 12 || typeAt(head, 4) !== "ftyp") return null;
    const top = yield* listBoxes(reader, 0, reader.size);
    const moov = findChild(top, "moov");
    if (moov === undefined) return NOT_MEDIA;
    const children = yield* listBoxes(
      reader,
      moov.bodyOffset,
      moov.bodyOffset + moov.bodyLength,
    );
    let durationSeconds: number | null = null;
    const mvhd = findChild(children, "mvhd");
    if (mvhd !== undefined) {
      const body = yield* reader.read(
        mvhd.bodyOffset,
        Math.min(mvhd.bodyLength, 32),
      );
      if (body.length >= 20) {
        const version = body[0]!;
        let timescale = 0;
        let duration = 0;
        if (version === 1 && body.length >= 32) {
          timescale = u32be(body, 20);
          duration = u64be(body, 24);
        } else if (version === 0) {
          timescale = u32be(body, 12);
          duration = u32be(body, 16);
        }
        if (timescale > 0) durationSeconds = duration / timescale;
      }
    }
    let sawAudioTrack = false;
    let audio: Mp4AudioTrack | null = null;
    for (const trak of children.filter((box) => box.type === "trak")) {
      const mdia = findChild(
        yield* listBoxes(
          reader,
          trak.bodyOffset,
          trak.bodyOffset + trak.bodyLength,
        ),
        "mdia",
      );
      if (mdia === undefined) continue;
      const mdiaChildren = yield* listBoxes(
        reader,
        mdia.bodyOffset,
        mdia.bodyOffset + mdia.bodyLength,
      );
      const hdlr = findChild(mdiaChildren, "hdlr");
      if (hdlr === undefined) continue;
      const hdlrBody = yield* reader.read(
        hdlr.bodyOffset,
        Math.min(hdlr.bodyLength, 16),
      );
      if (hdlrBody.length < 12 || typeAt(hdlrBody, 8) !== "soun") continue;
      sawAudioTrack = true;
      if (audio !== null) continue;
      const minf = findChild(mdiaChildren, "minf");
      if (minf === undefined) continue;
      const stbl = findChild(
        yield* listBoxes(
          reader,
          minf.bodyOffset,
          minf.bodyOffset + minf.bodyLength,
        ),
        "stbl",
      );
      if (stbl === undefined) continue;
      const stsd = findChild(
        yield* listBoxes(
          reader,
          stbl.bodyOffset,
          stbl.bodyOffset + stbl.bodyLength,
        ),
        "stsd",
      );
      if (stsd === undefined) continue;
      const stsdBody = yield* reader.read(
        stsd.bodyOffset,
        Math.min(stsd.bodyLength, 128),
      );
      audio = parseStsd(stsdBody);
    }
    if (!sawAudioTrack) return NOT_MEDIA;
    return {
      media: true,
      codec: audio?.codec ?? null,
      channels: audio?.channels ?? null,
      sampleRate: audio?.sampleRate ?? null,
      durationSeconds,
    };
  });

/** RIFF/WAVE: the fmt chunk gives codec/channels/rate/byte rate; the
 * data chunk's size over the byte rate is the exact duration. */
export const deriveWavVerdict = (
  reader: RangeReader,
): Effect.Effect<ProbeVerdict | null, Error> =>
  Effect.gen(function* () {
    const head = yield* reader.read(0, 12);
    if (
      head.length < 12 ||
      typeAt(head, 0) !== "RIFF" ||
      typeAt(head, 8) !== "WAVE"
    ) {
      return null;
    }
    let formatTag: number | null = null;
    let channels: number | null = null;
    let sampleRate: number | null = null;
    let byteRate: number | null = null;
    let dataBytes: number | null = null;
    let offset = 12;
    for (let seen = 0; seen < 64 && offset + 8 <= reader.size; seen++) {
      const header = yield* reader.read(offset, 8);
      if (header.length < 8) break;
      const type = typeAt(header, 0);
      const size = new DataView(
        header.buffer,
        header.byteOffset,
        header.byteLength,
      ).getUint32(4, true);
      if (type === "fmt " && size >= 16) {
        const body = yield* reader.read(offset + 8, Math.min(size, 40));
        if (body.length >= 16) {
          const view = new DataView(
            body.buffer,
            body.byteOffset,
            body.byteLength,
          );
          formatTag = view.getUint16(0, true);
          channels = view.getUint16(2, true);
          sampleRate = view.getUint32(4, true);
          byteRate = view.getUint32(8, true);
        }
      }
      if (type === "data") dataBytes = size;
      offset += 8 + size + (size % 2);
    }
    if (formatTag === null) return NOT_MEDIA;
    const codec =
      formatTag === 1
        ? "pcm"
        : formatTag === 3
          ? "float"
          : formatTag === 85
            ? "mp3"
            : `wav-${formatTag}`;
    return {
      media: true,
      codec,
      channels,
      sampleRate,
      durationSeconds:
        dataBytes !== null && byteRate !== null && byteRate > 0
          ? dataBytes / byteRate
          : null,
    };
  });

/** FLAC: the STREAMINFO block carries rate/channels/total samples. */
export const deriveFlacVerdict = (
  reader: RangeReader,
): Effect.Effect<ProbeVerdict | null, Error> =>
  Effect.gen(function* () {
    const head = yield* reader.read(0, 42);
    if (
      head.length < 42 ||
      typeAt(head, 0) !== "fLaC" ||
      (head[4]! & 0x7f) !== 0
    ) {
      return null;
    }
    const streamInfo = head.subarray(8, 42);
    const sampleRate =
      (streamInfo[10]! << 12) | (streamInfo[11]! << 4) | (streamInfo[12]! >> 4);
    const channels = ((streamInfo[12]! >> 1) & 0x7) + 1;
    const totalSamples =
      (streamInfo[13]! & 0xf) * 2 ** 32 +
      ((streamInfo[14]! << 24) |
        (streamInfo[15]! << 16) |
        (streamInfo[16]! << 8) |
        streamInfo[17]!);
    return {
      media: true,
      codec: "flac",
      channels,
      sampleRate: sampleRate > 0 ? sampleRate : null,
      durationSeconds:
        sampleRate > 0 && totalSamples > 0
          ? totalSamples / sampleRate
          : null,
    };
  });

const MPEG_BITRATES: ReadonlyArray<ReadonlyArray<number>> = [
  // MPEG-1 Layer III, MPEG-2 Layer III (kbps by bitrate index 1..14)
  [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];
const MPEG_RATES: ReadonlyArray<ReadonlyArray<number>> = [
  [44100, 48000, 32000],
  [22050, 24000, 16000],
];

/** MP3: skip ID3v2, read the first frame header; a Xing/Info header
 * gives the exact frame count, otherwise duration is the CBR
 * estimate from the byte count (what ffprobe reports absent a
 * Xing header is the same estimate refined by its scan). */
export const deriveMp3Verdict = (
  reader: RangeReader,
): Effect.Effect<ProbeVerdict | null, Error> =>
  Effect.gen(function* () {
    let start = 0;
    const head = yield* reader.read(0, 10);
    if (
      head.length >= 10 &&
      head[0] === 0x49 &&
      head[1] === 0x44 &&
      head[2] === 0x33
    ) {
      const size =
        ((head[6]! & 0x7f) << 21) |
        ((head[7]! & 0x7f) << 14) |
        ((head[8]! & 0x7f) << 7) |
        (head[9]! & 0x7f);
      start = 10 + size + ((head[5]! & 0x10) !== 0 ? 10 : 0);
    }
    // Scan a bounded window for the first frame sync.
    const window = yield* reader.read(start, 4096);
    let frameAt = -1;
    for (let i = 0; i + 4 <= window.length; i++) {
      if (
        window[i] === 0xff &&
        (window[i + 1]! & 0xe0) === 0xe0 &&
        ((window[i + 1]! >> 3) & 0x3) !== 1 &&
        ((window[i + 1]! >> 1) & 0x3) === 1 &&
        ((window[i + 2]! >> 4) & 0xf) !== 0xf &&
        ((window[i + 2]! >> 4) & 0xf) !== 0
      ) {
        frameAt = i;
        break;
      }
    }
    if (frameAt === -1) return null;
    const b1 = window[frameAt + 1]!;
    const b2 = window[frameAt + 2]!;
    const b3 = window[frameAt + 3]!;
    const mpeg2 = ((b1 >> 3) & 0x3) !== 3; // version bits: 3 = MPEG-1
    const bitrateIndex = (b2 >> 4) & 0xf;
    const rateIndex = (b2 >> 2) & 0x3;
    if (rateIndex === 3) return null;
    const bitrateKbps =
      MPEG_BITRATES[mpeg2 ? 1 : 0]![bitrateIndex - 1] ?? null;
    const sampleRate = MPEG_RATES[mpeg2 ? 1 : 0]![rateIndex] ?? null;
    if (bitrateKbps === null || sampleRate === null) return null;
    const channels = ((b3 >> 6) & 0x3) === 3 ? 1 : 2;
    // Xing/Info header: at a fixed offset past the frame header
    // (depends on version + channel mode), carrying the frame count.
    const samplesPerFrame = mpeg2 ? 576 : 1152;
    const xingOffset =
      frameAt + 4 + (mpeg2 ? (channels === 1 ? 9 : 17) : channels === 1 ? 17 : 32);
    let durationSeconds: number | null = null;
    if (xingOffset + 16 <= window.length) {
      const tag = typeAt(window, xingOffset);
      if (tag === "Xing" || tag === "Info") {
        const flags = u32be(window, xingOffset + 4);
        if ((flags & 0x1) !== 0) {
          const frames = u32be(window, xingOffset + 8);
          durationSeconds = (frames * samplesPerFrame) / sampleRate;
        }
      }
    }
    if (durationSeconds === null) {
      const audioBytes = reader.size - start;
      durationSeconds = (audioBytes * 8) / (bitrateKbps * 1000);
    }
    return {
      media: true,
      codec: "mp3",
      channels,
      sampleRate,
      durationSeconds,
    };
  });

const findBytes = (
  haystack: Uint8Array,
  needle: string,
  from = 0,
): number => {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
};

const findBytesLast = (haystack: Uint8Array, needle: string): number => {
  for (let i = haystack.length - needle.length; i >= 0; i--) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
};

/** Ogg/Opus: OpusHead gives the channel count; the last page's
 * granule position over 48 kHz is the duration. ffprobe reports
 * Opus at 48000 Hz regardless of the encoder's input rate. */
export const deriveOggOpusVerdict = (
  reader: RangeReader,
): Effect.Effect<ProbeVerdict | null, Error> =>
  Effect.gen(function* () {
    const head = yield* reader.read(0, 4096);
    if (head.length < 27 || typeAt(head, 0) !== "OggS") {
      return null;
    }
    const opusHeadAt = findBytes(head.subarray(0, 2048), "OpusHead");
    if (opusHeadAt === -1) return null;
    const channels =
      head.length > opusHeadAt + 9 ? head[opusHeadAt + 9]! : null;
    let durationSeconds: number | null = null;
    const tailSize = Math.min(reader.size, 128 * 1024);
    const tail = yield* reader.read(reader.size - tailSize, tailSize);
    const lastPage = findBytesLast(tail, "OggS");
    if (lastPage >= 0 && tail.length >= lastPage + 14) {
      const granule =
        Number(
          new DataView(
            tail.buffer,
            tail.byteOffset,
            tail.byteLength,
          ).getBigUint64(lastPage + 6, true),
        ) -
        // The pre-skip lives in OpusHead (+10, uint16 LE); granule
        // positions count from the end of the pre-skip.
        (opusHeadAt >= 0 && head.length > opusHeadAt + 11
          ? new DataView(
              head.buffer,
              head.byteOffset,
              head.byteLength,
            ).getUint16(opusHeadAt + 10, true)
          : 0);
      if (granule > 0) durationSeconds = granule / 48000;
    }
    return {
      media: true,
      codec: "opus",
      channels,
      sampleRate: 48000,
      durationSeconds,
    };
  });

const TEXT_EXTENSIONS = [".ndjson", ".json", ".md", ".txt", ".csv", ".log"];

/**
 * Derive a verdict from the blob's bytes. Null means the format is
 * not one the Worker can read — not a claim about the bytes. A
 * recognized non-media answer is returned as media:false.
 */
export const deriveVerdict = (
  blobName: string,
  reader: RangeReader,
): Effect.Effect<ProbeVerdict | null, Error> =>
  Effect.gen(function* () {
    const lower = blobName.toLowerCase();
    if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      return NOT_MEDIA;
    }
    const mp4 = yield* deriveMp4Verdict(reader);
    if (mp4 !== null) return mp4;
    const wav = yield* deriveWavVerdict(reader);
    if (wav !== null) return wav;
    const flac = yield* deriveFlacVerdict(reader);
    if (flac !== null) return flac;
    const mp3 = yield* deriveMp3Verdict(reader);
    if (mp3 !== null) return mp3;
    const ogg = yield* deriveOggOpusVerdict(reader);
    if (ogg !== null) return ogg;
    return null;
  });

/** Whether two verdicts agree for planning purposes: same media
 * answer, and when media, the same direct/transcode decision and
 * the same segment count. Duration is compared by decision, not by
 * the millisecond — ffprobe and a container walk can disagree by
 * fractions of a second without changing anything downstream. */
export const verdictsAgree = (
  a: ProbeVerdict,
  b: ProbeVerdict,
): boolean => {
  if (a.media !== b.media) return false;
  if (!a.media) return true;
  const directA = directChunkFor(a) !== null;
  const directB = directChunkFor(b) !== null;
  if (directA !== directB) return false;
  if (directA) return true;
  if (a.durationSeconds === null || b.durationSeconds === null) {
    return a.durationSeconds === b.durationSeconds;
  }
  return (
    Math.ceil(a.durationSeconds / CHUNK_SECONDS) ===
    Math.ceil(b.durationSeconds / CHUNK_SECONDS)
  );
};

// ---------------------------------------------------------------------------
// Manifests and receipts: parsers and writers that agree byte-for-byte
// with the lib shapes (field order follows the Schema declarations).
// ---------------------------------------------------------------------------

export interface MediaChunkShape {
  readonly index: number;
  readonly key: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
}

export interface MediaManifestShape {
  readonly captureId: string;
  readonly version: string;
  readonly createdAt: string;
  readonly sourceDurationSeconds: number | null;
  readonly chunks: ReadonlyArray<MediaChunkShape>;
}

export const parseMediaManifest = (
  value: unknown,
): MediaManifestShape | null => {
  const body = record(value);
  if (
    typeof body["captureId"] !== "string" ||
    typeof body["version"] !== "string" ||
    typeof body["createdAt"] !== "string" ||
    !Array.isArray(body["chunks"])
  ) {
    return null;
  }
  const chunks: Array<MediaChunkShape> = [];
  for (const raw of body["chunks"]) {
    const chunk = record(raw);
    if (
      typeof chunk["index"] !== "number" ||
      typeof chunk["key"] !== "string" ||
      typeof chunk["startSeconds"] !== "number" ||
      typeof chunk["durationSeconds"] !== "number"
    ) {
      return null;
    }
    chunks.push({
      index: chunk["index"],
      key: chunk["key"],
      startSeconds: chunk["startSeconds"],
      durationSeconds: chunk["durationSeconds"],
    });
  }
  return {
    captureId: body["captureId"],
    version: body["version"],
    createdAt: body["createdAt"],
    sourceDurationSeconds: number(body["sourceDurationSeconds"]),
    chunks,
  };
};

export const manifestJson = (manifest: MediaManifestShape): string =>
  JSON.stringify({
    captureId: manifest.captureId,
    version: manifest.version,
    createdAt: manifest.createdAt,
    sourceDurationSeconds: manifest.sourceDurationSeconds,
    chunks: manifest.chunks.map((chunk) => ({
      index: chunk.index,
      key: chunk.key,
      startSeconds: chunk.startSeconds,
      durationSeconds: chunk.durationSeconds,
    })),
  });

export interface TransloaditReceiptShape {
  readonly assemblyId: string;
  readonly assemblySslUrl: string;
  readonly createdAt: string;
  readonly mediaVersion: string;
  readonly workflowVersion?: string;
  readonly phase?: "import" | "chunks" | "completed";
  readonly captureId?: string;
  readonly originalKey?: string;
  readonly sourceDurationSeconds?: number | null;
  readonly previousAssemblyIds?: ReadonlyArray<string>;
  readonly completedAt?: string;
}

export const parseTransloaditReceipt = (
  value: unknown,
): TransloaditReceiptShape | null => {
  const body = record(value);
  if (
    typeof body["assemblyId"] !== "string" ||
    typeof body["assemblySslUrl"] !== "string" ||
    typeof body["createdAt"] !== "string" ||
    typeof body["mediaVersion"] !== "string"
  ) {
    return null;
  }
  const phase = body["phase"];
  return {
    assemblyId: body["assemblyId"],
    assemblySslUrl: body["assemblySslUrl"],
    createdAt: body["createdAt"],
    mediaVersion: body["mediaVersion"],
    ...(typeof body["workflowVersion"] === "string"
      ? { workflowVersion: body["workflowVersion"] }
      : {}),
    ...(phase === "import" || phase === "chunks" || phase === "completed"
      ? { phase }
      : {}),
    ...(typeof body["captureId"] === "string"
      ? { captureId: body["captureId"] }
      : {}),
    ...(typeof body["originalKey"] === "string"
      ? { originalKey: body["originalKey"] }
      : {}),
    ...(body["sourceDurationSeconds"] === null ||
    typeof body["sourceDurationSeconds"] === "number"
      ? { sourceDurationSeconds: body["sourceDurationSeconds"] as number | null }
      : {}),
    ...(Array.isArray(body["previousAssemblyIds"])
      ? {
          previousAssemblyIds: body["previousAssemblyIds"].filter(
            (id): id is string => typeof id === "string",
          ),
        }
      : {}),
    ...(typeof body["completedAt"] === "string"
      ? { completedAt: body["completedAt"] }
      : {}),
  };
};

export const receiptJson = (receipt: TransloaditReceiptShape): string =>
  JSON.stringify({
    assemblyId: receipt.assemblyId,
    assemblySslUrl: receipt.assemblySslUrl,
    createdAt: receipt.createdAt,
    mediaVersion: receipt.mediaVersion,
    ...(receipt.workflowVersion !== undefined
      ? { workflowVersion: receipt.workflowVersion }
      : {}),
    ...(receipt.phase !== undefined ? { phase: receipt.phase } : {}),
    ...(receipt.captureId !== undefined
      ? { captureId: receipt.captureId }
      : {}),
    ...(receipt.originalKey !== undefined
      ? { originalKey: receipt.originalKey }
      : {}),
    ...(receipt.sourceDurationSeconds !== undefined
      ? { sourceDurationSeconds: receipt.sourceDurationSeconds }
      : {}),
    ...(receipt.previousAssemblyIds !== undefined
      ? { previousAssemblyIds: receipt.previousAssemblyIds }
      : {}),
    ...(receipt.completedAt !== undefined
      ? { completedAt: receipt.completedAt }
      : {}),
  });

// ---------------------------------------------------------------------------
// Transloadit: error text, result reading, and the assembly params —
// ports of the lib helpers with the same shapes.
// ---------------------------------------------------------------------------

/** Keep Transloadit's own code/message/reason intact (lib's
 * transloaditErrorText). The whole response is never serialized into
 * an error: merged params can contain ephemeral credentials. */
export const transloaditErrorText = (assembly: unknown): string => {
  const body = record(assembly);
  const parts = [text(body["error"]) ?? text(body["code"]) ?? text(body["ok"])];
  for (const field of ["message", "reason", "step", "previousStep"] as const) {
    const value = text(body[field]);
    if (value !== null && !parts.includes(value)) parts.push(value);
  }
  return (
    parts.filter((part): part is string => part !== null).join(": ") ||
    "unknown Transloadit error"
  );
};

const resultRows = (
  assembly: unknown,
  step: string,
): ReadonlyArray<Record<string, unknown>> => {
  const results = record(record(assembly)["results"]);
  const rows = results[step];
  return Array.isArray(rows) ? rows.map(record) : [];
};

/** lib's resultDuration: a step row's own duration, then its meta,
 * then the uploads' meta. */
export const resultDuration = (
  assembly: unknown,
  steps: ReadonlyArray<string>,
): number | null => {
  for (const step of steps) {
    for (const row of resultRows(assembly, step)) {
      const duration =
        number(row["duration"]) ?? number(record(row["meta"])["duration"]);
      if (duration !== null && duration > 0) return duration;
    }
  }
  const uploads = record(assembly)["uploads"];
  for (const row of Array.isArray(uploads) ? uploads : []) {
    const duration = number(record(record(row)["meta"])["duration"]);
    if (duration !== null && duration > 0) return duration;
  }
  return null;
};

const ASSEMBLY_RUNNING = new Set([
  "ASSEMBLY_UPLOADING",
  "ASSEMBLY_EXECUTING",
  "ASSEMBLY_REPLAYING",
]);

/** lib's poll + requireCompleted, as one state read. */
export const assemblyState = (
  assembly: unknown,
): "pending" | "completed" | { readonly error: string } => {
  const body = record(assembly);
  const errorCode = text(body["error"]) ?? text(body["code"]);
  if (errorCode !== null || typeof body["errno"] === "number") {
    return { error: transloaditErrorText(assembly) };
  }
  const status = text(body["ok"]);
  if (status === null || ASSEMBLY_RUNNING.has(status)) return "pending";
  if (status !== "ASSEMBLY_COMPLETED") {
    return { error: transloaditErrorText(assembly) };
  }
  return "completed";
};

export interface StoreCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

/**
 * The chunk assembly's params, exactly as lib's createChunkReceipt
 * builds them: import from the presigned URL, split into the
 * duration's segments as mono 16 kHz Opus at 24 kbps, store under
 * the produced names (`<prefix>${file.name}` — the split robot
 * names outputs `_<index>.ogg` and the index is parsed back from
 * the stored name).
 */
export const buildChunkAssemblyParams = (options: {
  readonly authKey: string;
  readonly importUrl: string;
  readonly store: StoreCredentials;
  readonly bucket: string;
  readonly endpoint: string;
  readonly chunkPrefix: string;
  readonly durationSeconds: number;
}): Record<string, unknown> => ({
  auth: { key: options.authKey },
  steps: {
    import: {
      robot: "/http/import",
      url: options.importUrl,
      result: true,
    },
    split: {
      robot: "/audio/split",
      use: "import",
      ffmpeg_stack: "v7",
      preset: "empty",
      ffmpeg: {
        "c:a": "libopus",
        "b:a": "24k",
        ar: 16000,
        ac: 1,
        f: "ogg",
        vn: true,
      },
      segments: segmentsFor(options.durationSeconds),
      result: true,
    },
    store_chunks: {
      robot: "/s3/store",
      use: "split",
      bucket: options.bucket,
      bucket_region: "auto",
      host: options.endpoint,
      no_vhost: true,
      key: options.store.accessKeyId,
      secret: options.store.secretAccessKey,
      session_token: options.store.sessionToken,
      acl: "bucket-default",
      path: `${options.chunkPrefix}\${file.name}`,
      result: true,
    },
  },
});

/** A completed chunk assembly whose stored chunks are unusable
 * (lib's ChunkValidationError): re-fired, capped per capture. */
export class ChunkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkValidationError";
  }
}

const chunkIndexFromName = (name: string): number | null => {
  const match = CHUNK_NAME_PATTERN.exec(name);
  if (match === null) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : null;
};

/**
 * Build the manifest for a completed chunk assembly from the chunk
 * prefix's listing (ground truth — the /s3/store step does not
 * report its results), exactly as lib's manifestFromCompletedChunks
 * validates it. Throws ChunkValidationError on unusable output.
 */
export const manifestFromChunkListing = (options: {
  readonly captureId: string;
  readonly durationSeconds: number;
  readonly chunkPrefix: string;
  readonly stored: ReadonlyArray<{ readonly key: string; readonly size: number }>;
  readonly createdAt: string;
}): MediaManifestShape => {
  const segments = segmentsFor(options.durationSeconds);
  const namesByIndex = new Map<number, string>();
  for (const obj of options.stored) {
    const name = obj.key.startsWith(options.chunkPrefix)
      ? obj.key.slice(options.chunkPrefix.length)
      : obj.key;
    if (name.includes("/")) {
      throw new ChunkValidationError(
        `Transloadit stored an unexpected nested chunk key for ${options.captureId}: ${obj.key}`,
      );
    }
    const index = chunkIndexFromName(name);
    if (index === null) {
      throw new ChunkValidationError(
        `Transloadit stored a malformed chunk name for ${options.captureId}: ` +
          `${JSON.stringify(name)} (expected a name ending _<index>.ogg)`,
      );
    }
    if (namesByIndex.has(index)) {
      throw new ChunkValidationError(
        `Transloadit stored duplicate chunks for index ${index} for ${options.captureId}`,
      );
    }
    if (obj.size <= 0) {
      throw new ChunkValidationError(
        `Transloadit stored an empty chunk ${index} for ${options.captureId}: ${obj.key}`,
      );
    }
    namesByIndex.set(index, name);
  }
  const chunks: Array<MediaChunkShape> = [];
  for (const [index, segment] of segments.entries()) {
    const name = namesByIndex.get(index);
    if (name === undefined) {
      throw new ChunkValidationError(
        `Transloadit stored no chunk ${index} for ${options.captureId} ` +
          `(expected ${segments.length} chunks)`,
      );
    }
    chunks.push({
      index,
      key: `${options.chunkPrefix}${name}`,
      startSeconds: segment.from,
      durationSeconds: segment.to - segment.from,
    });
  }
  if (namesByIndex.size > segments.length) {
    throw new ChunkValidationError(
      `Transloadit stored ${namesByIndex.size} chunks for ${options.captureId}; expected ${segments.length}`,
    );
  }
  return {
    captureId: options.captureId,
    version: MEDIA_VERSION,
    createdAt: options.createdAt,
    sourceDurationSeconds: options.durationSeconds,
    chunks,
  };
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export class NormalizeReport extends Schema.Class<NormalizeReport>(
  "NormalizeReport",
)({
  ranAt: Schema.String,
  mode: Schema.Literals(["cron", "manual"]),
  perform: Schema.Boolean,
  totalCaptures: Schema.Number,
  checked: Schema.Number,
  matched: Schema.Number,
  pending: Schema.Number,
  mismatched: Schema.Number,
  settled: Schema.Number,
  notMedia: Schema.Number,
  noBlob: Schema.Number,
  legacy: Schema.Number,
  inFlight: Schema.Number,
  derivationsChecked: Schema.Number,
  derivationsAgreeing: Schema.Number,
  performedDirect: Schema.Number,
  performedFired: Schema.Number,
  performedPending: Schema.Number,
  performedCompleted: Schema.Number,
  performedCached: Schema.Number,
  performedSettled: Schema.Number,
  unconfigured: Schema.Number,
  mismatches: Schema.Array(
    Schema.Struct({
      captureId: Schema.String,
      kind: Schema.String,
      detail: Schema.String,
    }),
  ),
  errors: Schema.Array(
    Schema.Struct({ captureId: Schema.String, detail: Schema.String }),
  ),
  proof: Schema.NullOr(
    Schema.Struct({
      captureId: Schema.String,
      state: Schema.String,
      detail: Schema.String,
    }),
  ),
}) {}

export interface NormalizePassOptions {
  readonly mode: "cron" | "manual";
  readonly now: Date;
  readonly limit: number;
  readonly offset?: number;
  readonly staleAfterMs: number;
  readonly perform: boolean;
  /** Reconcile exactly this capture (manual rehearsal/proof tooling). */
  readonly captureId?: string;
  /** Perform against the normalize-proof/ namespace instead. */
  readonly proof?: boolean;
}

// ---------------------------------------------------------------------------
// Platform: typed errors and services
// ---------------------------------------------------------------------------

export class NormalizeDataError extends Data.TaggedError(
  "NormalizeDataError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class NormalizeVendorError extends Data.TaggedError(
  "NormalizeVendorError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

type NormalizeError =
  | NormalizeDataError
  | NormalizeVendorError
  | CatalogError
  | ArtifactReadError
  | IndexRequestError
  | NotebookError
  | R2CredsError;

export interface CaptureFile {
  readonly name: string;
  readonly size: number;
  readonly uploaded: Date;
}

export class NormalizeData extends Context.Service<
  NormalizeData,
  {
    readonly captureIds: Effect.Effect<ReadonlyArray<string>, CatalogError>;
    readonly manifestIds: Effect.Effect<ReadonlyArray<string>, CatalogError>;
    readonly receiptIds: Effect.Effect<ReadonlyArray<string>, CatalogError>;
    readonly settledIds: Effect.Effect<ReadonlyArray<string>, CatalogError>;
    readonly listFiles: (
      captureId: string,
    ) => Effect.Effect<ReadonlyArray<CaptureFile>, CatalogError>;
    readonly readText: (
      key: string,
    ) => Effect.Effect<string | null, ArtifactReadError>;
    readonly head: (
      key: string,
    ) => Effect.Effect<CatalogHead | null, CatalogError>;
    readonly listChunks: (
      prefix: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly key: string; readonly size: number }>,
      CatalogError
    >;
    readonly rangeReader: (
      key: string,
      size: number,
    ) => RangeReader;
    /** The bucket's S3 keypair (presigning + credential minting);
     * null when the binding is missing or unreadable. */
    readonly s3Credentials: S3CredentialsValue | null;
  }
>()("medina-cloudflare/NormalizeData") {}

export class NormalizeVendor extends Context.Service<
  NormalizeVendor,
  {
    readonly configured: boolean;
    /** The binding's key value (the assembly params carry it). */
    readonly authKey: Effect.Effect<string | null, NormalizeVendorError>;
    readonly createAssembly: (
      params: Record<string, unknown>,
    ) => Effect.Effect<
      { readonly assemblyId: string; readonly assemblySslUrl: string },
      NormalizeVendorError
    >;
    readonly getAssembly: (
      assemblyId: string,
    ) => Effect.Effect<unknown, NormalizeVendorError>;
  }
>()("medina-cloudflare/NormalizeVendor") {}

export class NormalizeNotebook extends Context.Service<
  NormalizeNotebook,
  {
    readonly record: (
      report: NormalizeReport,
    ) => Effect.Effect<void, NotebookError>;
    readonly cursor: Effect.Effect<number, NotebookError>;
    readonly setCursor: (
      cursor: number,
    ) => Effect.Effect<void, NotebookError>;
    readonly verdicts: Effect.Effect<
      ReadonlyMap<string, ProbeVerdict>,
      NotebookError
    >;
    readonly putVerdict: (
      captureId: string,
      verdict: ProbeVerdict,
    ) => Effect.Effect<void, NotebookError>;
  }
>()("medina-cloudflare/NormalizeNotebook") {}

interface SecretsStoreSecretLike {
  get(): Promise<unknown>;
}

export interface NormalizeEnv {
  /** Range reads over the artifact bucket (probe derivations). */
  readonly rangeGet: (
    key: string,
    offset: number,
    length: number,
  ) => Promise<Uint8Array | null>;
  readonly notebook: {
    idFromName(name: string): unknown;
    get(id: unknown): {
      fetch(request: Request): Promise<Response>;
    };
  };
  /** The Transloadit key binding; null until declared in the stack. */
  readonly transloaditApiKey: SecretsStoreSecretLike | null;
  /** The ARTIFACTS_S3 binding value (JSON string when deployed). */
  readonly s3Credentials: unknown;
}

export const NORMALIZE_SHADOW_DO_NAME = "normalize-shadow-v1";
const TRANSLOADIT_API_URL = "https://api2.transloadit.com";

const verdictJsonParse = (value: unknown): ProbeVerdict | null => {
  const body = record(value);
  if (typeof body["media"] !== "boolean") return null;
  return {
    media: body["media"],
    codec: text(body["codec"]),
    channels: number(body["channels"]),
    sampleRate: number(body["sampleRate"]),
    durationSeconds: number(body["durationSeconds"]),
  };
};

export const normalizePlatformLayer = (
  env: NormalizeEnv,
): Layer.Layer<
  NormalizeData | NormalizeVendor | NormalizeNotebook,
  never,
  ArtifactLedger | ArtifactCatalog
> =>
  Layer.effect(
    NormalizeData,
    Effect.gen(function* () {
      const ledger = yield* ArtifactLedger;
      const catalog = yield* ArtifactCatalog;
      const idsUnder = (
        prefix: string,
        stripSuffix: string,
      ): Effect.Effect<ReadonlyArray<string>, CatalogError> =>
        Effect.map(catalog.listAll(prefix), (objects) =>
          objects
            .map((object) => object.key.slice(prefix.length))
            .filter((rest) => !rest.includes("/"))
            .map((rest) =>
              stripSuffix.length > 0 && rest.endsWith(stripSuffix)
                ? rest.slice(0, -stripSuffix.length)
                : rest,
            )
            .filter((id) => id.length > 0)
            .sort(),
        );
      return {
        captureIds: Effect.map(
          catalog.listPrefixes("capture/"),
          (prefixes) =>
            prefixes
              .map((prefix) =>
                prefix.slice("capture/".length).replace(/\/$/, ""),
              )
              .filter((id) => id.length > 0)
              .sort(),
        ),
        manifestIds: idsUnder(`media/${MEDIA_VERSION}/`, ".json"),
        receiptIds: idsUnder("normalize/transloadit/", ".json"),
        settledIds: idsUnder(`normalize-settled/${MEDIA_VERSION}/`, ".json"),
        listFiles: (captureId) =>
          Effect.map(
            catalog.listAll(`${captureDir(captureId)}/`),
            (objects) =>
              objects.map((object) => ({
                name: object.key.slice(captureDir(captureId).length + 1),
                size: object.size,
                uploaded: object.uploaded,
              })),
          ),
        readText: (key) =>
          Effect.map(ledger.readText(key), (text) =>
            Option.isSome(text) ? text.value : null,
          ),
        head: (key) => catalog.head(key),
        listChunks: (prefix) =>
          Effect.map(catalog.listAll(prefix), (objects) =>
            objects.map((object) => ({
              key: object.key,
              size: object.size,
            })),
          ),
        rangeReader: (key, size) => ({
          size,
          read: (offset, length) =>
            Effect.tryPromise({
              try: async () => {
                const bytes = await env.rangeGet(key, offset, length);
                return bytes ?? new Uint8Array(0);
              },
              catch: (cause) =>
                new Error(`range read of ${key} failed: ${cause}`),
            }),
        }),
        s3Credentials: parseS3Credentials(env.s3Credentials),
      };
    }),
  ).pipe(
    Layer.merge(
      Layer.succeed(NormalizeVendor, {
        configured: env.transloaditApiKey !== null,
        authKey:
          env.transloaditApiKey === null
            ? Effect.succeed(null)
            : Effect.tryPromise({
                try: async () => {
                  const value = await env.transloaditApiKey!.get();
                  return typeof value === "string" && value.length > 0
                    ? value
                    : null;
                },
                catch: (cause) =>
                  new NormalizeVendorError({
                    message:
                      "reading the TRANSLOADIT_API_KEY binding failed",
                    cause,
                  }),
              }),
        createAssembly: (params) =>
          Effect.gen(function* () {
            const body = yield* Effect.tryPromise({
              try: async () => {
                const form = new FormData();
                form.set("params", JSON.stringify(params));
                const response = await fetch(
                  `${TRANSLOADIT_API_URL}/assemblies`,
                  { method: "POST", body: form },
                );
                const raw = await response.text();
                let parsed: unknown = null;
                try {
                  parsed = JSON.parse(raw) as unknown;
                } catch {
                  // handled below as an unreadable response
                }
                if (!response.ok) {
                  throw new Error(
                    `Transloadit create failed: ${
                      parsed !== null
                        ? transloaditErrorText(parsed)
                        : `HTTP ${response.status}`
                    }`,
                  );
                }
                if (parsed === null) {
                  throw new Error(
                    "Transloadit create returned unreadable JSON",
                  );
                }
                return parsed;
              },
              catch: (cause) =>
                new NormalizeVendorError({
                  message:
                    cause instanceof Error
                      ? cause.message
                      : "Transloadit create failed",
                  cause,
                }),
            });
            const assemblyId = text(record(body)["assembly_id"]);
            const assemblySslUrl = text(record(body)["assembly_ssl_url"]);
            if (assemblyId === null || assemblySslUrl === null) {
              return yield* Effect.fail(
                new NormalizeVendorError({
                  message: "Transloadit create returned no assembly receipt",
                  cause: body,
                }),
              );
            }
            return { assemblyId, assemblySslUrl };
          }),
        getAssembly: (assemblyId) =>
          Effect.tryPromise({
            try: async () => {
              const response = await fetch(
                `${TRANSLOADIT_API_URL}/assemblies/${encodeURIComponent(assemblyId)}`,
              );
              const raw = await response.text();
              let parsed: unknown = null;
              try {
                parsed = JSON.parse(raw) as unknown;
              } catch {
                // handled below
              }
              if (!response.ok) {
                throw new Error(
                  `Transloadit poll failed: ${
                    parsed !== null
                      ? transloaditErrorText(parsed)
                      : `HTTP ${response.status}`
                  }`,
                );
              }
              if (parsed === null) {
                throw new Error("Transloadit poll returned unreadable JSON");
              }
              return parsed;
            },
            catch: (cause) =>
              new NormalizeVendorError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Transloadit poll failed",
                cause,
              }),
          }),
      }),
    ),
    Layer.merge(
      Layer.succeed(NormalizeNotebook, {
        record: (report) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(NORMALIZE_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://normalize-shadow/report", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(report),
                }),
              );
              if (!response.ok) {
                throw new Error(
                  `notebook rejected a report: ${response.status}`,
                );
              }
            },
            catch: (cause) =>
              new NotebookError({
                message: "recording a normalize report failed",
                cause,
              }),
          }),
        cursor: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(NORMALIZE_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://normalize-shadow/cursor"),
            );
            if (!response.ok) {
              throw new Error(`notebook cursor answered ${response.status}`);
            }
            const body = (await response.json()) as { cursor?: unknown };
            return typeof body.cursor === "number" ? body.cursor : 0;
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading the normalize cursor failed",
              cause,
            }),
        }),
        setCursor: (cursor) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(NORMALIZE_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://normalize-shadow/cursor", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ cursor }),
                }),
              );
              if (!response.ok) {
                throw new Error(
                  `notebook cursor write answered ${response.status}`,
                );
              }
            },
            catch: (cause) =>
              new NotebookError({
                message: "writing the normalize cursor failed",
                cause,
              }),
          }),
        verdicts: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(NORMALIZE_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://normalize-shadow/verdicts"),
            );
            if (!response.ok) {
              throw new Error(
                `notebook verdicts answered ${response.status}`,
              );
            }
            const body = (await response.json()) as {
              verdicts?: Array<{ captureId?: unknown; verdict?: unknown }>;
            };
            const map = new Map<string, ProbeVerdict>();
            for (const row of body.verdicts ?? []) {
              if (typeof row.captureId !== "string") continue;
              const verdict = verdictJsonParse(row.verdict);
              if (verdict !== null) map.set(row.captureId, verdict);
            }
            return map as ReadonlyMap<string, ProbeVerdict>;
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading the normalize verdict cache failed",
              cause,
            }),
        }),
        putVerdict: (captureId, verdict) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(NORMALIZE_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://normalize-shadow/verdict", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ captureId, verdict }),
                }),
              );
              if (!response.ok) {
                throw new Error(
                  `notebook verdict write answered ${response.status}`,
                );
              }
            },
            catch: (cause) =>
              new NotebookError({
                message: "writing a normalize verdict failed",
                cause,
              }),
          }),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The reconciler: one capture at a time, every failure its own.
// ---------------------------------------------------------------------------

interface StageKeys {
  readonly manifestKey: string;
  readonly receiptKey: string;
  readonly settledKey: string;
  readonly chunkPrefix: string;
}

const productionKeys = (captureId: string): StageKeys => ({
  manifestKey: mediaManifestKey(captureId),
  receiptKey: transloaditReceiptKey(captureId),
  settledKey: normalizeSettledKey(captureId),
  chunkPrefix: mediaChunkPrefix(captureId),
});

const proofKeys = (captureId: string): StageKeys => ({
  manifestKey: `normalize-proof/${MEDIA_VERSION}/${captureId}.json`,
  receiptKey: `normalize-proof/transloadit/${captureId}.json`,
  settledKey: `normalize-proof/settled/${captureId}.json`,
  chunkPrefix: `normalize-proof/${MEDIA_VERSION}/${captureId}/`,
});

interface CaptureState {
  readonly blobName: string | null;
  readonly blobSize: number;
  readonly blobUploaded: Date | null;
  readonly stored: {
    readonly verdict: ProbeVerdict;
    readonly blobName: string | null;
  } | null;
  readonly settled: boolean;
  readonly manifestText: string | null;
  readonly receiptText: string | null;
}

const MAX_STORED_FINDINGS = 100;

type ItemOutcome =
  | { readonly kind: "matched"; readonly detail: string }
  | { readonly kind: "pending"; readonly detail: string }
  | { readonly kind: "mismatch"; readonly mismatchKind: string; readonly detail: string }
  | { readonly kind: "settled"; readonly detail: string }
  | { readonly kind: "not-media"; readonly detail: string }
  | { readonly kind: "no-blob"; readonly detail: string }
  | { readonly kind: "legacy"; readonly detail: string }
  | { readonly kind: "in-flight"; readonly detail: string }
  | { readonly kind: "cached"; readonly detail: string }
  | { readonly kind: "direct"; readonly detail: string }
  | { readonly kind: "fired"; readonly detail: string }
  | { readonly kind: "completed"; readonly detail: string }
  | { readonly kind: "unconfigured"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };

interface ItemContext {
  readonly state: CaptureState;
  readonly verdict: ProbeVerdict | null;
  readonly derivation: ProbeVerdict | null;
  readonly derived: boolean;
}

const gatherState = (
  captureId: string,
  keys: StageKeys,
  settledIds: ReadonlySet<string>,
): Effect.Effect<
  CaptureState,
  CatalogError | ArtifactReadError,
  NormalizeData
> =>
  Effect.gen(function* () {
    const data = yield* NormalizeData;
    const files = yield* data.listFiles(captureId);
    const blob = files.find(
      (file) =>
        !file.name.includes("/") &&
        !METADATA_NAMES.has(file.name) &&
        !/\.tmp-[^/]*$/.test(file.name),
    );
    const probeText = yield* data.readText(ffprobeKey(captureId));
    let stored: CaptureState["stored"] = null;
    if (probeText !== null) {
      try {
        stored = verdictFromStoredProbe(JSON.parse(probeText) as unknown);
      } catch {
        stored = null;
      }
    }
    return {
      blobName: blob?.name ?? null,
      blobSize: blob?.size ?? 0,
      blobUploaded: blob?.uploaded ?? null,
      stored,
      settled: settledIds.has(captureId),
      manifestText: yield* data.readText(keys.manifestKey),
      receiptText: yield* data.readText(keys.receiptKey),
    };
  });

/**
 * Resolve the capture's verdict: medina-dev's stored probe first,
 * the notebook's derivation cache second, a fresh derivation last
 * (cached into the notebook by the caller in live mode — and in
 * shadow mode too: the cache is the stage's own notebook, and
 * warming it is what makes the eventual flip cheap).
 */
const resolveVerdict = (
  captureId: string,
  state: CaptureState,
  cached: ReadonlyMap<string, ProbeVerdict>,
): Effect.Effect<
  {
    readonly verdict: ProbeVerdict | null;
    readonly derivation: ProbeVerdict | null;
  },
  CatalogError | ArtifactReadError,
  NormalizeData
> =>
  Effect.gen(function* () {
    const data = yield* NormalizeData;
    let derivation: ProbeVerdict | null = null;
    if (state.blobName !== null) {
      derivation = yield* deriveVerdict(
        state.blobName,
        data.rangeReader(
          `${captureDir(captureId)}/${state.blobName}`,
          state.blobSize,
        ),
      ).pipe(Effect.catch(() => Effect.succeed(null)));
    }
    if (state.stored !== null) {
      return { verdict: state.stored.verdict, derivation };
    }
    const fromCache = cached.get(captureId);
    if (fromCache !== undefined) {
      return { verdict: fromCache, derivation };
    }
    return { verdict: derivation, derivation };
  });

type PerformError =
  | NormalizeVendorError
  | NormalizeDataError
  | R2CredsError
  | CatalogError
  | ArtifactReadError
  | IndexRequestError;

/** Fire one chunk assembly and return its receipt (lib's
 * createChunkReceipt): mint the import credential and presign the
 * source, mint the prefix-scoped store credential, build the
 * params, create. */
const fireChunkReceipt = (options: {
  readonly captureId: string;
  readonly sourceKey: string;
  readonly originalKey: string;
  readonly durationSeconds: number;
  readonly previousAssemblyIds: ReadonlyArray<string>;
  readonly chunkPrefix: string;
  readonly now: Date;
}): Effect.Effect<
  TransloaditReceiptShape,
  PerformError,
  NormalizeData | NormalizeVendor
> =>
  Effect.gen(function* () {
    const data = yield* NormalizeData;
    const vendor = yield* NormalizeVendor;
    const s3 = data.s3Credentials;
    if (s3 === null) {
      return yield* Effect.fail(
        new NormalizeDataError({
          message:
            "the ARTIFACTS_S3 binding is missing or unreadable: cannot presign or mint R2 credentials",
          cause: null,
        }),
      );
    }
    const authKey = yield* vendor.authKey;
    if (authKey === null) {
      return yield* Effect.fail(
        new NormalizeVendorError({
          message: "the TRANSLOADIT_API_KEY binding is missing or empty",
          cause: null,
        }),
      );
    }
    const accountId = accountIdFromEndpoint(s3.endpoint);
    const importCreds = yield* mintTempCredentials({
      endpoint: s3.endpoint,
      accountId,
      parent: s3,
      bucket: s3.bucketName,
      permission: "object-read-only",
      ttlSeconds: JOB_TTL_SECONDS,
      objects: [options.sourceKey],
      now: options.now,
    });
    const importUrl = yield* presignGetUrl({
      endpoint: s3.endpoint,
      bucket: s3.bucketName,
      key: options.sourceKey,
      credentials: importCreds,
      ttlSeconds: JOB_TTL_SECONDS,
      now: options.now,
    });
    const storeCreds: TempCredentials = yield* mintTempCredentials({
      endpoint: s3.endpoint,
      accountId,
      parent: s3,
      bucket: s3.bucketName,
      permission: "object-read-write",
      ttlSeconds: JOB_TTL_SECONDS,
      prefixes: [options.chunkPrefix],
      now: options.now,
    });
    const params = buildChunkAssemblyParams({
      authKey,
      importUrl,
      store: storeCreds,
      bucket: s3.bucketName,
      endpoint: s3.endpoint,
      chunkPrefix: options.chunkPrefix,
      durationSeconds: options.durationSeconds,
    });
    const created = yield* vendor.createAssembly(params);
    return {
      assemblyId: created.assemblyId,
      assemblySslUrl: created.assemblySslUrl,
      createdAt: options.now.toISOString(),
      mediaVersion: MEDIA_VERSION,
      workflowVersion: WORKFLOW_VERSION,
      phase: "chunks",
      captureId: options.captureId,
      originalKey: options.originalKey,
      sourceDurationSeconds: options.durationSeconds,
      previousAssemblyIds: [...options.previousAssemblyIds],
    };
  });

/** The Transloadit half of a capture (lib's TransloaditNormalize.normalize). */
const transloaditFlow = (options: {
  readonly captureId: string;
  readonly blobName: string;
  readonly verdict: ProbeVerdict;
  readonly keys: StageKeys;
  readonly receiptText: string | null;
  readonly now: Date;
}): Effect.Effect<
  ItemOutcome,
  never,
  NormalizeData | NormalizeVendor | ArtifactLedger
> =>
  Effect.gen(function* () {
    const data = yield* NormalizeData;
    const vendor = yield* NormalizeVendor;
    const ledger = yield* ArtifactLedger;
    const { captureId, keys } = options;
    const originalKey = `${captureDir(captureId)}/${options.blobName}`;
    let receipt: TransloaditReceiptShape | null = null;
    if (options.receiptText !== null) {
      try {
        receipt = parseTransloaditReceipt(
          JSON.parse(options.receiptText) as unknown,
        );
      } catch {
        receipt = null;
      }
    }

    if (receipt === null) {
      const duration = options.verdict.durationSeconds;
      if (duration === null) {
        return {
          kind: "error" as const,
          detail: `no media duration available for ${captureId}`,
        };
      }
      const original = yield* data.head(originalKey);
      if (original === null) {
        return {
          kind: "error" as const,
          detail: `archived blob missing for ${captureId}: ${originalKey}`,
        };
      }
      const fired = yield* fireChunkReceipt({
        captureId,
        sourceKey: originalKey,
        originalKey,
        durationSeconds: duration,
        previousAssemblyIds: [],
        chunkPrefix: keys.chunkPrefix,
        now: options.now,
      });
      yield* ledger.writeText(keys.receiptKey, receiptJson(fired));
      return {
        kind: "fired" as const,
        detail: `assembly ${fired.assemblyId} fired for ${duration.toFixed(1)}s in ${Math.ceil(duration / CHUNK_SECONDS)} segment(s)`,
      };
    }

    if (receipt.phase === "completed") {
      // medina-dev returns "completed" here and never rebuilds a
      // missing manifest (its manifest check runs first and loops).
      // The Worker heals it instead: the chunks are the ground
      // truth, and rebuilding costs no provider spend.
      const duration = receipt.sourceDurationSeconds ?? null;
      if (duration === null) {
        return {
          kind: "error" as const,
          detail: `completed receipt for ${captureId} carries no duration`,
        };
      }
      const stored = yield* data.listChunks(keys.chunkPrefix);
      let manifest: MediaManifestShape;
      try {
        manifest = manifestFromChunkListing({
          captureId,
          durationSeconds: duration,
          chunkPrefix: keys.chunkPrefix,
          stored,
          createdAt: options.now.toISOString(),
        });
      } catch (cause) {
        return {
          kind: "error" as const,
          detail: `rebuilding the manifest for ${captureId} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
      yield* ledger.writeText(keys.manifestKey, manifestJson(manifest));
      return {
        kind: "completed" as const,
        detail: "receipt was completed; rebuilt the missing manifest from the stored chunks",
      };
    }

    const assembly = yield* vendor.getAssembly(receipt.assemblyId);
    const state = assemblyState(assembly);
    if (typeof state === "object") {
      return {
        kind: "error" as const,
        detail: `Transloadit assembly ${receipt.assemblyId} failed: ${state.error}`,
      };
    }
    if (state === "pending") {
      return {
        kind: "pending" as const,
        detail: `assembly ${receipt.assemblyId} still running`,
      };
    }

    // Completed. Legacy receipts (pre remote-media-v1) upgrade by
    // re-firing from the canonical output, as lib does.
    if (
      receipt.workflowVersion !== WORKFLOW_VERSION ||
      receipt.phase === undefined
    ) {
      const canonicalKey = canonicalMediaKey(captureId);
      const canonical = yield* data.head(canonicalKey);
      if (canonical === null || canonical.size <= 0) {
        return {
          kind: "error" as const,
          detail: `Transloadit completed without canonical output for ${captureId}`,
        };
      }
      const duration =
        options.verdict.durationSeconds ??
        resultDuration(assembly, ["encode", "store"]);
      if (duration === null) {
        return {
          kind: "error" as const,
          detail: `Transloadit returned no duration for ${captureId}`,
        };
      }
      const next = yield* fireChunkReceipt({
        captureId,
        sourceKey: canonicalKey,
        originalKey: receipt.originalKey ?? originalKey,
        durationSeconds: duration,
        previousAssemblyIds: [receipt.assemblyId],
        chunkPrefix: keys.chunkPrefix,
        now: options.now,
      });
      yield* ledger.writeText(keys.receiptKey, receiptJson(next));
      return {
        kind: "fired" as const,
        detail: `legacy receipt upgraded; assembly ${next.assemblyId} fired from the canonical output`,
      };
    }

    if (receipt.phase !== "chunks" || receipt.sourceDurationSeconds == null) {
      return {
        kind: "error" as const,
        detail: `invalid Transloadit receipt for ${captureId}: phase ${receipt.phase ?? "missing"}`,
      };
    }

    // Settle the completed chunk assembly (lib's settleCompletedChunks).
    const duration = receipt.sourceDurationSeconds;
    const stored = yield* data.listChunks(keys.chunkPrefix);
    let manifest: MediaManifestShape;
    try {
      manifest = manifestFromChunkListing({
        captureId,
        durationSeconds: duration,
        chunkPrefix: keys.chunkPrefix,
        stored,
        createdAt: options.now.toISOString(),
      });
    } catch (cause) {
      if (!(cause instanceof ChunkValidationError)) throw cause;
      const attempts = (receipt.previousAssemblyIds?.length ?? 0) + 1;
      if (attempts >= MAX_CHUNK_ATTEMPTS) {
        return {
          kind: "error" as const,
          detail:
            `Transloadit chunks for ${captureId} failed validation after ${attempts} attempts; ` +
            `not re-firing: ${cause.message}`,
        };
      }
      const next = yield* fireChunkReceipt({
        captureId,
        sourceKey: receipt.originalKey ?? originalKey,
        originalKey: receipt.originalKey ?? originalKey,
        durationSeconds: duration,
        previousAssemblyIds: [
          ...(receipt.previousAssemblyIds ?? []),
          receipt.assemblyId,
        ],
        chunkPrefix: keys.chunkPrefix,
        now: options.now,
      });
      yield* ledger.writeText(keys.receiptKey, receiptJson(next));
      return {
        kind: "fired" as const,
        detail: `stored chunks failed validation (${cause.message}); re-fired as assembly ${next.assemblyId}`,
      };
    }
    yield* ledger.writeText(keys.manifestKey, manifestJson(manifest));
    yield* ledger.writeText(
      keys.receiptKey,
      receiptJson({
        ...receipt,
        phase: "completed",
        completedAt: options.now.toISOString(),
      }),
    );
    return {
      kind: "completed" as const,
      detail: `manifest written from ${manifest.chunks.length} stored chunk(s)`,
    };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        kind: "error" as const,
        detail: String(error).slice(0, 300),
      }),
    ),
  );

/** Perform one capture (lib's mediaNormalizeSource ingest). */
const performCapture = (options: {
  readonly captureId: string;
  readonly keys: StageKeys;
  readonly state: CaptureState;
  readonly verdict: ProbeVerdict | null;
  readonly now: Date;
}): Effect.Effect<
  ItemOutcome,
  never,
  NormalizeData | NormalizeVendor | ArtifactLedger
> =>
  Effect.gen(function* () {
    const data = yield* NormalizeData;
    const vendor = yield* NormalizeVendor;
    const ledger = yield* ArtifactLedger;
    const { captureId, keys, state } = options;
    if (state.settled) {
      return { kind: "settled" as const, detail: "normalize-settled marker present" };
    }
    if (state.blobName === null) {
      return { kind: "no-blob" as const, detail: "capture has no blob" };
    }
    const verdict = options.verdict;
    if (verdict === null) {
      return {
        kind: "error" as const,
        detail:
          "probe underivable: no stored probe record and the container format is not one the Worker can read",
      };
    }
    if (!verdict.media) {
      return { kind: "not-media" as const, detail: "probe shows no audio stream" };
    }
    if (state.manifestText !== null) {
      let manifest: MediaManifestShape | null = null;
      try {
        manifest = parseMediaManifest(
          JSON.parse(state.manifestText) as unknown,
        );
      } catch {
        manifest = null;
      }
      if (manifest === null) {
        return {
          kind: "error" as const,
          detail: "stored manifest does not decode as a MediaManifest",
        };
      }
      for (const chunk of manifest.chunks) {
        const head = yield* data.head(chunk.key);
        if (head !== null && head.size > 0) continue;
        // Missing from the only store there is: the permanent
        // case medina-dev settles (its message names both stores;
        // post-migration they are the same bucket).
        const message = `media chunk is missing from R2 and local storage: ${chunk.key}`;
        yield* ledger.writeText(
          keys.settledKey,
          JSON.stringify({
            captureId,
            error: message,
            settledAt: options.now.toISOString(),
          }),
        );
        return {
          kind: "settled" as const,
          detail: `settled as impossible: ${message}`,
        };
      }
      return { kind: "cached" as const, detail: "manifest and chunks present" };
    }
    const direct = directChunkFor(verdict);
    if (direct !== null) {
      const blobKey = `${captureDir(captureId)}/${state.blobName}`;
      const manifest: MediaManifestShape = {
        captureId,
        version: MEDIA_VERSION,
        createdAt: options.now.toISOString(),
        sourceDurationSeconds: direct.durationSeconds,
        chunks: [
          {
            index: 0,
            key: blobKey,
            startSeconds: 0,
            durationSeconds: direct.durationSeconds,
          },
        ],
      };
      yield* ledger.writeText(keys.manifestKey, manifestJson(manifest));
      return {
        kind: "direct" as const,
        detail: `direct manifest written (${direct.durationSeconds.toFixed(1)}s ${verdict.codec ?? "?"} mono 16 kHz)`,
      };
    }
    if (!vendor.configured) {
      return {
        kind: "unconfigured" as const,
        detail:
          "needs the Transloadit path but TRANSLOADIT_API_KEY is not bound to this Worker",
      };
    }
    return yield* transloaditFlow({
      captureId,
      blobName: state.blobName,
      verdict,
      keys,
      receiptText: state.receiptText,
      now: options.now,
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        kind: "error" as const,
        detail: String(error).slice(0, 300),
      }),
    ),
  );

const DURATION_TOLERANCE = 0.51;

/** Diff one capture against what medina-dev produced (shadow). */
const diffCapture = (options: {
  readonly captureId: string;
  readonly state: CaptureState;
  readonly verdict: ProbeVerdict | null;
  readonly now: Date;
  readonly staleAfterMs: number;
}): Effect.Effect<
  ItemOutcome,
  never,
  NormalizeData
> =>
  Effect.gen(function* () {
    const data = yield* NormalizeData;
    const { captureId, state } = options;
    if (state.settled) {
      return { kind: "settled" as const, detail: "normalize-settled marker present" };
    }
    if (state.blobName === null) {
      return { kind: "no-blob" as const, detail: "capture has no blob" };
    }
    const verdict = options.verdict;
    if (verdict === null) {
      return {
        kind: "error" as const,
        detail:
          "no stored probe record and the Worker cannot derive a verdict from these bytes",
      };
    }
    const blobKey = `${captureDir(captureId)}/${state.blobName}`;
    const fresh =
      state.blobUploaded !== null &&
      options.now.getTime() - state.blobUploaded.getTime() <=
        options.staleAfterMs;
    let receipt: TransloaditReceiptShape | null = null;
    if (state.receiptText !== null) {
      try {
        receipt = parseTransloaditReceipt(
          JSON.parse(state.receiptText) as unknown,
        );
      } catch {
        receipt = null;
      }
    }
    if (!verdict.media) {
      if (state.manifestText !== null || receipt !== null) {
        return {
          kind: "mismatch" as const,
          mismatchKind: "not-media-with-artifacts",
          detail: "probe shows no audio stream, yet a manifest or Transloadit receipt exists",
        };
      }
      return { kind: "not-media" as const, detail: "probe shows no audio stream" };
    }
    const direct = directChunkFor(verdict);
    if (state.manifestText !== null) {
      let manifest: MediaManifestShape | null = null;
      try {
        manifest = parseMediaManifest(
          JSON.parse(state.manifestText) as unknown,
        );
      } catch {
        manifest = null;
      }
      if (manifest === null) {
        return {
          kind: "error" as const,
          detail: "stored manifest does not decode as a MediaManifest",
        };
      }
      // Every chunk the manifest names must be in the bucket.
      const chunks = yield* data.listChunks(mediaChunkPrefix(captureId));
      const presentKeys = new Set(chunks.map((chunk) => chunk.key));
      const missing = manifest.chunks.filter(
        (chunk) =>
          chunk.key !== blobKey &&
          (!presentKeys.has(chunk.key) ||
            (chunks.find((c) => c.key === chunk.key)?.size ?? 0) <= 0),
      );
      if (direct !== null) {
        const only = manifest.chunks[0];
        if (
          manifest.chunks.length !== 1 ||
          only === undefined ||
          only.key !== blobKey ||
          Math.abs(only.durationSeconds - direct.durationSeconds) >
            DURATION_TOLERANCE ||
          manifest.sourceDurationSeconds === null ||
          Math.abs(manifest.sourceDurationSeconds - direct.durationSeconds) >
            DURATION_TOLERANCE
        ) {
          return {
            kind: "mismatch" as const,
            mismatchKind: "direct-manifest-differs",
            detail: `direct plan (${direct.durationSeconds.toFixed(2)}s) vs stored manifest (${manifest.chunks.length} chunk(s), source ${manifest.sourceDurationSeconds ?? "null"}s)`,
          };
        }
        return { kind: "matched" as const, detail: "direct manifest agrees" };
      }
      const legacyLocal =
        receipt === null &&
        manifest.chunks.length > 0 &&
        manifest.chunks.every((chunk) =>
          /(^|\/)chunk-\d{3}\.ogg$/.test(chunk.key),
        );
      if (legacyLocal) {
        return {
          kind: "legacy" as const,
          detail: "manifest predates the Transloadit flow (local chunk names, no receipt)",
        };
      }
      if (receipt === null) {
        return {
          kind: "mismatch" as const,
          mismatchKind: "manifest-without-receipt",
          detail: "manifest exists but no Transloadit receipt, and the capture is not direct-eligible",
        };
      }
      if (receipt.originalKey !== undefined && receipt.originalKey !== blobKey) {
        return {
          kind: "mismatch" as const,
          mismatchKind: "receipt-original-differs",
          detail: `receipt original ${receipt.originalKey} vs blob ${blobKey}`,
        };
      }
      if (
        receipt.sourceDurationSeconds != null &&
        verdict.durationSeconds !== null &&
        Math.abs(receipt.sourceDurationSeconds - verdict.durationSeconds) >
          DURATION_TOLERANCE
      ) {
        return {
          kind: "mismatch" as const,
          mismatchKind: "receipt-duration-differs",
          detail: `receipt duration ${receipt.sourceDurationSeconds.toFixed(2)}s vs probe ${verdict.durationSeconds.toFixed(2)}s`,
        };
      }
      if (missing.length > 0) {
        return fresh
          ? {
              kind: "pending" as const,
              detail: `${missing.length} manifest chunk(s) not in the bucket yet`,
            }
          : {
              kind: "mismatch" as const,
              mismatchKind: "manifest-chunk-missing",
              detail: `${missing.length} manifest chunk(s) absent from the bucket: ${missing[0]!.key}`,
            };
      }
      if (receipt.phase === "completed") {
        const expected = segmentsFor(receipt.sourceDurationSeconds ?? 0);
        const gridOk =
          manifest.chunks.length === expected.length &&
          manifest.chunks.every((chunk, index) => {
            const segment = expected[index]!;
            return (
              chunk.index === index &&
              Math.abs(chunk.startSeconds - segment.from) < 0.01 &&
              Math.abs(chunk.durationSeconds - (segment.to - segment.from)) <
                0.01
            );
          });
        if (!gridOk) {
          return {
            kind: "mismatch" as const,
            mismatchKind: "manifest-grid-differs",
            detail: `manifest chunk grid vs the ${expected.length}-segment plan for ${receipt.sourceDurationSeconds ?? 0}s`,
          };
        }
        return { kind: "matched" as const, detail: "Transloadit manifest agrees (chunks, grid, duration)" };
      }
      return {
        kind: "matched" as const,
        detail: "manifest present while its receipt is still in flight (upgraded legacy receipt)",
      };
    }
    if (receipt !== null) {
      if (receipt.phase === "completed") {
        return {
          kind: "mismatch" as const,
          mismatchKind: "receipt-completed-no-manifest",
          detail: "receipt phase is completed but no manifest exists",
        };
      }
      if (receipt.originalKey !== undefined && receipt.originalKey !== blobKey) {
        return {
          kind: "mismatch" as const,
          mismatchKind: "receipt-original-differs",
          detail: `receipt original ${receipt.originalKey} vs blob ${blobKey}`,
        };
      }
      if (
        receipt.sourceDurationSeconds != null &&
        verdict.durationSeconds !== null &&
        Math.abs(receipt.sourceDurationSeconds - verdict.durationSeconds) >
          DURATION_TOLERANCE
      ) {
        return {
          kind: "mismatch" as const,
          mismatchKind: "receipt-duration-differs",
          detail: `receipt duration ${receipt.sourceDurationSeconds.toFixed(2)}s vs probe ${verdict.durationSeconds.toFixed(2)}s`,
        };
      }
      return {
        kind: "in-flight" as const,
        detail: `assembly ${receipt.assemblyId} in flight (phase ${receipt.phase ?? "legacy"})`,
      };
    }
    return fresh
      ? {
          kind: "pending" as const,
          detail: `awaiting medina-dev's normalize (${direct !== null ? "direct" : "Transloadit"} plan)`,
        }
      : {
          kind: "mismatch" as const,
          mismatchKind: "unprocessed",
          detail: `no manifest or receipt for a ${direct !== null ? "direct" : "Transloadit"}-plan capture older than the pending grace`,
        };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        kind: "error" as const,
        detail: String(error).slice(0, 300),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export const runNormalizePass = (
  options: NormalizePassOptions,
): Effect.Effect<
  NormalizeReport,
  NormalizeError,
  | NormalizeData
  | NormalizeVendor
  | NormalizeNotebook
  | ArtifactLedger
  | ArtifactCatalog
> =>
  Effect.gen(function* () {
    const data = yield* NormalizeData;
    const notebook = yield* NormalizeNotebook;
    const ids = yield* data.captureIds;
    const manifestIdSet = new Set(yield* data.manifestIds);
    const receiptIdSet = new Set(yield* data.receiptIds);
    const settledIdSet = new Set(yield* data.settledIds);
    const cachedVerdicts = yield* notebook.verdicts;

    // Work selection, mirroring the archive sweep's discipline:
    // a named capture when asked; live passes take in-flight
    // receipts first, then the unprocessed frontier, then a
    // rotating slice of the manifested census (the chunk ensure);
    // shadow passes rotate through the whole census.
    let selected: Array<string>;
    if (options.captureId !== undefined) {
      selected = [options.captureId];
    } else if (options.perform) {
      const inFlight = ids.filter(
        (id) => receiptIdSet.has(id) && !manifestIdSet.has(id),
      );
      const frontier = ids.filter(
        (id) =>
          !manifestIdSet.has(id) &&
          !receiptIdSet.has(id) &&
          !settledIdSet.has(id),
      );
      const manifested = ids.filter((id) => manifestIdSet.has(id));
      const start = yield* notebook.cursor;
      const picked: Array<string> = [];
      for (const id of [...inFlight, ...frontier]) {
        if (picked.length >= options.limit) break;
        picked.push(id);
      }
      const budget = options.limit - picked.length;
      const slice: Array<string> = [];
      for (let i = 0; i < manifested.length && slice.length < budget; i++) {
        slice.push(manifested[(start + i) % manifested.length]!);
      }
      if (manifested.length > 0) {
        yield* notebook.setCursor(
          (start + slice.length) % manifested.length,
        );
      }
      selected = [...picked, ...slice];
    } else {
      const offset = options.offset ?? (yield* notebook.cursor);
      selected = ids.slice(offset, offset + options.limit);
      if (options.mode === "cron" && ids.length > 0) {
        yield* notebook.setCursor(
          (offset + selected.length) % ids.length,
        );
      }
    }

    let matched = 0;
    let pending = 0;
    let mismatched = 0;
    let settled = 0;
    let notMedia = 0;
    let noBlob = 0;
    let legacy = 0;
    let inFlight = 0;
    let derivationsChecked = 0;
    let derivationsAgreeing = 0;
    let performedDirect = 0;
    let performedFired = 0;
    let performedPending = 0;
    let performedCompleted = 0;
    let performedCached = 0;
    let performedSettled = 0;
    let unconfigured = 0;
    const mismatches: Array<{
      captureId: string;
      kind: string;
      detail: string;
    }> = [];
    const errors: Array<{ captureId: string; detail: string }> = [];
    let proof: NormalizeReport["proof"] = null;

    for (const captureId of selected) {
      const keys =
        options.proof === true
          ? proofKeys(captureId)
          : productionKeys(captureId);
      const state = yield* gatherState(
        captureId,
        keys,
        options.proof === true ? new Set<string>() : settledIdSet,
      );
      const { verdict, derivation } = yield* resolveVerdict(
        captureId,
        state,
        cachedVerdicts,
      );
      // The derivation agreement check: the rehearsal's core
      // evidence that the Worker's own probe reads the containers
      // the way ffprobe does.
      if (state.stored !== null && derivation !== null) {
        derivationsChecked++;
        if (verdictsAgree(state.stored.verdict, derivation)) {
          derivationsAgreeing++;
        } else if (mismatches.length < MAX_STORED_FINDINGS) {
          mismatches.push({
            captureId,
            kind: "derivation-differs",
            detail: `stored: media=${state.stored.verdict.media} codec=${state.stored.verdict.codec} ch=${state.stored.verdict.channels} rate=${state.stored.verdict.sampleRate} dur=${state.stored.verdict.durationSeconds?.toFixed(2) ?? "null"}; derived: media=${derivation.media} codec=${derivation.codec} ch=${derivation.channels} rate=${derivation.sampleRate} dur=${derivation.durationSeconds?.toFixed(2) ?? "null"}`,
          });
        }
      }
      // Cache fresh derivations for captures medina-dev never
      // probed (the notebook is the stage's own state).
      if (
        state.stored === null &&
        derivation !== null &&
        verdict === derivation &&
        !cachedVerdicts.has(captureId)
      ) {
        yield* notebook
          .putVerdict(captureId, derivation)
          .pipe(Effect.catch(() => Effect.void));
      }

      const outcome =
        options.perform || options.proof === true
          ? yield* performCapture({
              captureId,
              keys,
              state,
              verdict,
              now: options.now,
            })
          : yield* diffCapture({
              captureId,
              state,
              verdict,
              now: options.now,
              staleAfterMs: options.staleAfterMs,
            });

      if (options.proof === true) {
        proof = {
          captureId,
          state: outcome.kind,
          detail: outcome.detail,
        };
      }
      switch (outcome.kind) {
        case "matched":
          matched++;
          break;
        case "pending":
          pending++;
          if (options.perform) performedPending++;
          break;
        case "mismatch":
          mismatched++;
          if (mismatches.length < MAX_STORED_FINDINGS) {
            mismatches.push({
              captureId,
              kind: outcome.mismatchKind,
              detail: outcome.detail,
            });
          }
          break;
        case "settled":
          settled++;
          if (options.perform) performedSettled++;
          break;
        case "not-media":
          notMedia++;
          break;
        case "no-blob":
          noBlob++;
          break;
        case "legacy":
          legacy++;
          matched++;
          break;
        case "in-flight":
          inFlight++;
          matched++;
          break;
        case "cached":
          performedCached++;
          matched++;
          break;
        case "direct":
          performedDirect++;
          matched++;
          break;
        case "fired":
          performedFired++;
          break;
        case "completed":
          performedCompleted++;
          matched++;
          break;
        case "unconfigured":
          unconfigured++;
          break;
        case "error":
          if (errors.length < MAX_STORED_FINDINGS) {
            errors.push({ captureId, detail: outcome.detail });
          }
          break;
      }
    }

    const report = new NormalizeReport({
      ranAt: options.now.toISOString(),
      mode: options.mode,
      perform: options.perform || options.proof === true,
      totalCaptures: ids.length,
      checked: selected.length,
      matched,
      pending,
      mismatched,
      settled,
      notMedia,
      noBlob,
      legacy,
      inFlight,
      derivationsChecked,
      derivationsAgreeing,
      performedDirect,
      performedFired,
      performedPending,
      performedCompleted,
      performedCached,
      performedSettled,
      unconfigured,
      mismatches,
      errors,
      proof,
    });
    yield* notebook.record(report);
    return report;
  });

// ---------------------------------------------------------------------------
// NormalizeShadow: the stage's notebook Durable Object — recent pass
// reports, the round-robin cursor, and the derived-probe verdict
// cache, in its own SQLite storage.
// ---------------------------------------------------------------------------

interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>;
}

interface SqlStorageLike {
  exec(
    query: string,
    ...bindings: Array<unknown>
  ): SqlCursorLike;
}

interface DurableObjectStateLike {
  readonly storage: { readonly sql: SqlStorageLike };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export class NormalizeShadow {
  private readonly sql: SqlStorageLike;

  constructor(state: DurableObjectStateLike) {
    this.sql = state.storage.sql;
    void state.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS reports (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ran_at TEXT NOT NULL,
           report TEXT NOT NULL
         )`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (
           k TEXT PRIMARY KEY,
           v TEXT NOT NULL
         )`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS verdicts (
           capture_id TEXT PRIMARY KEY,
           verdict TEXT NOT NULL
         )`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/report") {
      const body = await request.text();
      let ranAt = new Date().toISOString();
      try {
        const parsed = JSON.parse(body) as { ranAt?: unknown };
        if (typeof parsed.ranAt === "string") ranAt = parsed.ranAt;
      } catch {
        // keep the default; the body is still stored verbatim
      }
      this.sql.exec(
        `INSERT INTO reports (ran_at, report) VALUES (?, ?)`,
        ranAt,
        body,
      );
      this.sql.exec(
        `DELETE FROM reports WHERE id NOT IN (
           SELECT id FROM reports ORDER BY id DESC LIMIT 100
         )`,
      );
      return jsonResponse({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const rows = this.sql
        .exec(`SELECT report FROM reports ORDER BY id DESC LIMIT 1`)
        .toArray();
      const countRows = this.sql
        .exec(`SELECT COUNT(*) AS n FROM reports`)
        .toArray();
      const lastReport =
        rows.length > 0 && typeof rows[0]?.["report"] === "string"
          ? (JSON.parse(rows[0]["report"] as string) as unknown)
          : null;
      return jsonResponse({
        runCount: Number(countRows[0]?.["n"] ?? 0),
        lastReport,
      });
    }
    if (request.method === "GET" && url.pathname === "/cursor") {
      const rows = this.sql
        .exec(`SELECT v FROM meta WHERE k = 'cursor'`)
        .toArray();
      const cursor =
        rows.length > 0 && typeof rows[0]?.["v"] === "string"
          ? Number(rows[0]["v"])
          : 0;
      return jsonResponse({
        cursor: Number.isFinite(cursor) ? cursor : 0,
      });
    }
    if (request.method === "POST" && url.pathname === "/cursor") {
      const body = (await request.json().catch(() => ({}))) as {
        cursor?: unknown;
      };
      const cursor =
        typeof body.cursor === "number" && Number.isFinite(body.cursor)
          ? Math.max(0, Math.floor(body.cursor))
          : 0;
      this.sql.exec(
        `INSERT INTO meta (k, v) VALUES ('cursor', ?)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        String(cursor),
      );
      return jsonResponse({ ok: true, cursor });
    }
    if (request.method === "GET" && url.pathname === "/verdicts") {
      const rows = this.sql
        .exec(`SELECT capture_id, verdict FROM verdicts`)
        .toArray();
      const verdicts = rows
        .map((row) => {
          if (
            typeof row["capture_id"] !== "string" ||
            typeof row["verdict"] !== "string"
          ) {
            return null;
          }
          try {
            return {
              captureId: row["capture_id"],
              verdict: JSON.parse(row["verdict"] as string) as unknown,
            };
          } catch {
            return null;
          }
        })
        .filter((row) => row !== null);
      return jsonResponse({ verdicts });
    }
    if (request.method === "POST" && url.pathname === "/verdict") {
      const body = (await request.json().catch(() => ({}))) as {
        captureId?: unknown;
        verdict?: unknown;
      };
      if (
        typeof body.captureId !== "string" ||
        typeof body.verdict !== "object" ||
        body.verdict === null
      ) {
        return jsonResponse({ error: "bad verdict" }, 400);
      }
      this.sql.exec(
        `INSERT INTO verdicts (capture_id, verdict) VALUES (?, ?)
           ON CONFLICT(capture_id) DO UPDATE SET verdict = excluded.verdict`,
        body.captureId,
        JSON.stringify(body.verdict),
      );
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: "not found" }, 404);
  }
}
