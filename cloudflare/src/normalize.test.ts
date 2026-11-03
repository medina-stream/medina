/**
 * Domain tests for src/normalize.ts: the probe derivations are
 * pinned against synthetic containers built byte-by-byte; the
 * Transloadit params/receipt/manifest shapes are pinned against
 * the lib constructions they mirror (lib/capture/Media.ts,
 * lib/capture/TransloaditNormalize.ts). The live agreement
 * evidence is the shadow pass itself.
 */
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  assemblyState,
  buildChunkAssemblyParams,
  ChunkValidationError,
  deriveFlacVerdict,
  deriveMp3Verdict,
  deriveMp4Verdict,
  deriveVerdict,
  deriveWavVerdict,
  directChunkFor,
  manifestFromChunkListing,
  manifestJson,
  parseMediaManifest,
  parseTransloaditReceipt,
  receiptJson,
  resultDuration,
  segmentsFor,
  transloaditErrorText,
  verdictFromStoredProbe,
  verdictsAgree,
  type ProbeVerdict,
  type RangeReader,
} from "./normalize.ts";

const readerFor = (bytes: Uint8Array): RangeReader => ({
  size: bytes.length,
  read: (offset, length) =>
    Effect.succeed(bytes.subarray(offset, offset + length)),
});

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const box = (type: string, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, 8 + body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
};

const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};

/** A minimal but structurally real M4A: ftyp + moov(mvhd, trak). */
const syntheticM4a = (options: {
  readonly handler: string;
  readonly codecType: string;
  readonly channels: number;
  readonly sampleRate: number;
  readonly durationUnits: number;
  readonly timescale: number;
}): Uint8Array => {
  const mvhdBody = new Uint8Array(20);
  const mvhdView = new DataView(mvhdBody.buffer);
  mvhdView.setUint32(12, options.timescale);
  mvhdView.setUint32(16, options.durationUnits);
  const hdlrBody = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    hdlrBody[8 + i] = options.handler.charCodeAt(i);
  }
  const entry = new Uint8Array(36);
  const entryView = new DataView(entry.buffer);
  entryView.setUint32(0, 36);
  for (let i = 0; i < 4; i++) entry[4 + i] = options.codecType.charCodeAt(i);
  entryView.setUint16(24, options.channels);
  entryView.setUint32(32, options.sampleRate * 65536);
  const stsdBody = concat(u32(0), u32(1), entry);
  const trak = box(
    "trak",
    box(
      "mdia",
      concat(
        box("hdlr", hdlrBody),
        box("minf", box("stbl", box("stsd", stsdBody))),
      ),
    ),
  );
  const ftypBody = new Uint8Array(8);
  for (let i = 0; i < 4; i++) ftypBody[i] = "M4A ".charCodeAt(i);
  return concat(
    box("ftyp", ftypBody),
    box("moov", concat(box("mvhd", mvhdBody), trak)),
  );
};

describe("deriveMp4Verdict", () => {
  test("reads a recorder-shaped M4A (AAC mono 16 kHz)", async () => {
    const bytes = syntheticM4a({
      handler: "soun",
      codecType: "mp4a",
      channels: 1,
      sampleRate: 16000,
      durationUnits: 900_000,
      timescale: 1000,
    });
    const verdict = await Effect.runPromise(deriveMp4Verdict(readerFor(bytes)));
    expect(verdict).toEqual({
      media: true,
      codec: "aac",
      channels: 1,
      sampleRate: 16000,
      durationSeconds: 900,
    });
    expect(directChunkFor(verdict!)).toEqual({ durationSeconds: 900 });
  });

  test("a video-only MP4 is not media", async () => {
    const bytes = syntheticM4a({
      handler: "vide",
      codecType: "avc1",
      channels: 2,
      sampleRate: 48000,
      durationUnits: 60_000,
      timescale: 1000,
    });
    const verdict = await Effect.runPromise(deriveMp4Verdict(readerFor(bytes)));
    expect(verdict?.media).toBe(false);
  });

  test("non-MP4 bytes return null (not a verdict)", async () => {
    const verdict = await Effect.runPromise(
      deriveMp4Verdict(readerFor(new TextEncoder().encode("hello world, plain text"))),
    );
    expect(verdict).toBeNull();
  });
});

describe("deriveWavVerdict", () => {
  test("PCM WAV: fmt fields and data-size duration", async () => {
    const fmt = new Uint8Array(16);
    const fmtView = new DataView(fmt.buffer);
    fmtView.setUint16(0, 1, true); // PCM
    fmtView.setUint16(2, 1, true); // mono
    fmtView.setUint32(4, 16000, true);
    fmtView.setUint32(8, 32000, true); // byte rate
    // RIFF chunks carry little-endian sizes (unlike MP4 boxes).
    const riffChunk = (type: string, body: Uint8Array): Uint8Array => {
      const out = new Uint8Array(8 + body.length);
      out.set(new TextEncoder().encode(type), 0);
      new DataView(out.buffer).setUint32(4, body.length, true);
      out.set(body, 8);
      return out;
    };
    const riffBody = concat(
      new TextEncoder().encode("WAVE"),
      riffChunk("fmt ", fmt),
      riffChunk("data", new Uint8Array(32000)),
    );
    const bytes = new Uint8Array(8 + riffBody.length);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    new DataView(bytes.buffer).setUint32(4, riffBody.length, true);
    bytes.set(riffBody, 8);
    const verdict = await Effect.runPromise(deriveWavVerdict(readerFor(bytes)));
    expect(verdict).toEqual({
      media: true,
      codec: "pcm",
      channels: 1,
      sampleRate: 16000,
      durationSeconds: 1,
    });
  });
});

describe("deriveMp3Verdict", () => {
  test("CBR estimate from the first frame header", async () => {
    const bytes = new Uint8Array(128 * 1000); // ~1 s at 128 kbps… (bytes*8/128000)
    bytes[0] = 0xff;
    bytes[1] = 0xfb; // sync, MPEG-1, Layer III
    bytes[2] = 0x90; // 128 kbps, 44100 Hz
    bytes[3] = 0x00; // joint stereo → 2 channels
    const verdict = await Effect.runPromise(deriveMp3Verdict(readerFor(bytes)));
    expect(verdict?.codec).toBe("mp3");
    expect(verdict?.sampleRate).toBe(44100);
    expect(verdict?.channels).toBe(2);
    expect(verdict?.durationSeconds).toBeCloseTo(8, 0);
  });
});

describe("deriveFlacVerdict", () => {
  test("STREAMINFO rate/channels/total samples", async () => {
    const bytes = new Uint8Array(42);
    bytes.set(new TextEncoder().encode("fLaC"), 0);
    bytes[4] = 0x00; // STREAMINFO, not last
    const info = bytes.subarray(8, 42);
    // sample rate 16000 = 0x03E80 as a 20-bit field: bytes 03 E8,
    // then the low nibble in the top of byte 12; channels-1 = 0.
    info[10] = 0x03;
    info[11] = 0xe8;
    info[12] = 0x00;
    info[13] = 0x00;
    const total = 16000 * 10;
    info[14] = (total >> 24) & 0xff;
    info[15] = (total >> 16) & 0xff;
    info[16] = (total >> 8) & 0xff;
    info[17] = total & 0xff;
    const verdict = await Effect.runPromise(deriveFlacVerdict(readerFor(bytes)));
    expect(verdict?.codec).toBe("flac");
    expect(verdict?.channels).toBe(1);
    expect(verdict?.sampleRate).toBe(16000);
    expect(verdict?.durationSeconds).toBe(10);
  });
});

describe("deriveVerdict dispatch", () => {
  test("text extensions are not media without reading", async () => {
    const verdict = await Effect.runPromise(
      deriveVerdict("points.ndjson", readerFor(new TextEncoder().encode("{}"))),
    );
    expect(verdict?.media).toBe(false);
  });
});

describe("verdictFromStoredProbe + directChunkFor", () => {
  const stored = (ffprobe: unknown, media = true) => ({
    captureId: "cap",
    probedAt: "2026-11-03T00:00:00.000Z",
    blobName: "rec.m4a",
    media,
    ffprobe,
  });

  test("recorder probe: aac mono 16k, format duration", () => {
    const parsed = verdictFromStoredProbe(
      stored({
        streams: [
          { codec_type: "audio", codec_name: "aac", channels: 1, sample_rate: "16000" },
        ],
        format: { duration: "900.000000" },
      }),
    );
    expect(parsed?.verdict).toEqual({
      media: true,
      codec: "aac",
      channels: 1,
      sampleRate: 16000,
      durationSeconds: 900,
    });
    expect(directChunkFor(parsed!.verdict)).toEqual({ durationSeconds: 900 });
  });

  test("long or wide audio is not direct", () => {
    const parsed = verdictFromStoredProbe(
      stored({
        streams: [
          { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "44100" },
        ],
        format: { duration: "5000.0" },
      }),
    );
    expect(directChunkFor(parsed!.verdict)).toBeNull();
  });

  test("an ffprobe error record is not media", () => {
    const parsed = verdictFromStoredProbe(stored({ error: "Invalid data" }, false));
    expect(parsed?.verdict.media).toBe(false);
  });
});

describe("segmentsFor", () => {
  test("spans and the safety cap", () => {
    expect(segmentsFor(3600)).toEqual([{ from: 0, to: 3600 }]);
    expect(segmentsFor(14401)).toEqual([
      { from: 0, to: 14400 },
      { from: 14400, to: 14401 },
    ]);
    expect(() => segmentsFor(0)).toThrow();
    expect(() => segmentsFor(14400 * 201)).toThrow();
  });
});

describe("buildChunkAssemblyParams", () => {
  test("matches lib's createChunkReceipt steps", () => {
    const params = buildChunkAssemblyParams({
      authKey: "KEY",
      importUrl: "https://signed.example/blob",
      store: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" },
      bucket: "sco-lifelog",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      chunkPrefix: "media/media-v1/cap/",
      durationSeconds: 15000,
    });
    expect(params).toEqual({
      auth: { key: "KEY" },
      steps: {
        import: { robot: "/http/import", url: "https://signed.example/blob", result: true },
        split: {
          robot: "/audio/split",
          use: "import",
          ffmpeg_stack: "v7",
          preset: "empty",
          ffmpeg: { "c:a": "libopus", "b:a": "24k", ar: 16000, ac: 1, f: "ogg", vn: true },
          segments: [
            { from: 0, to: 14400 },
            { from: 14400, to: 15000 },
          ],
          result: true,
        },
        store_chunks: {
          robot: "/s3/store",
          use: "split",
          bucket: "sco-lifelog",
          bucket_region: "auto",
          host: "https://acct.r2.cloudflarestorage.com",
          no_vhost: true,
          key: "AK",
          secret: "SK",
          session_token: "ST",
          acl: "bucket-default",
          path: "media/media-v1/cap/${file.name}",
          result: true,
        },
      },
    });
  });
});

describe("assemblyState + error text + durations", () => {
  test("states", () => {
    expect(assemblyState({ ok: "ASSEMBLY_EXECUTING" })).toBe("pending");
    expect(assemblyState({ ok: "ASSEMBLY_COMPLETED" })).toBe("completed");
    expect(assemblyState({ ok: "ASSEMBLY_CANCELED" })).toEqual({
      error: "ASSEMBLY_CANCELED",
    });
    expect(
      assemblyState({ ok: "ASSEMBLY_EXECUTING", error: "IMPORT_ERROR", message: "fetch failed" }),
    ).toEqual({ error: "IMPORT_ERROR: fetch failed" });
    expect(assemblyState({})).toBe("pending");
  });

  test("error text prefers error, then code, then ok", () => {
    expect(transloaditErrorText({ code: "C", ok: "O", message: "m" })).toBe("C: m");
    expect(transloaditErrorText({})).toBe("unknown Transloadit error");
  });

  test("resultDuration reads rows, meta, then uploads", () => {
    expect(
      resultDuration({ results: { import: [{ meta: { duration: 42 } }] } }, ["import"]),
    ).toBe(42);
    expect(resultDuration({ uploads: [{ meta: { duration: 7 } }] }, ["import"])).toBe(7);
    expect(resultDuration({}, ["import"])).toBeNull();
  });
});

describe("manifestFromChunkListing", () => {
  const base = {
    captureId: "cap",
    durationSeconds: 15000,
    chunkPrefix: "media/media-v1/cap/",
    createdAt: "2026-11-03T00:00:00.000Z",
  };

  test("builds the segment grid from the stored names", () => {
    const manifest = manifestFromChunkListing({
      ...base,
      stored: [
        { key: "media/media-v1/cap/rec_0.ogg", size: 100 },
        { key: "media/media-v1/cap/rec_1.ogg", size: 90 },
      ],
    });
    expect(manifest.chunks).toEqual([
      { index: 0, key: "media/media-v1/cap/rec_0.ogg", startSeconds: 0, durationSeconds: 14400 },
      { index: 1, key: "media/media-v1/cap/rec_1.ogg", startSeconds: 14400, durationSeconds: 600 },
    ]);
    expect(manifest.sourceDurationSeconds).toBe(15000);
  });

  test("duplicates, gaps, empties, and malformed names are poison", () => {
    expect(() =>
      manifestFromChunkListing({
        ...base,
        stored: [
          { key: "media/media-v1/cap/rec_0.ogg", size: 1 },
          { key: "media/media-v1/cap/other_0.ogg", size: 1 },
          { key: "media/media-v1/cap/rec_1.ogg", size: 1 },
        ],
      }),
    ).toThrow(ChunkValidationError);
    expect(() =>
      manifestFromChunkListing({
        ...base,
        stored: [{ key: "media/media-v1/cap/rec_0.ogg", size: 1 }],
      }),
    ).toThrow(ChunkValidationError);
    expect(() =>
      manifestFromChunkListing({
        ...base,
        stored: [
          { key: "media/media-v1/cap/rec_0.ogg", size: 0 },
          { key: "media/media-v1/cap/rec_1.ogg", size: 1 },
        ],
      }),
    ).toThrow(ChunkValidationError);
    expect(() =>
      manifestFromChunkListing({
        ...base,
        stored: [
          { key: "media/media-v1/cap/plain.ogg", size: 1 },
          { key: "media/media-v1/cap/rec_1.ogg", size: 1 },
        ],
      }),
    ).toThrow(ChunkValidationError);
  });
});

describe("receipt + manifest JSON shapes", () => {
  test("receipt round-trips with schema field order", () => {
    const json = receiptJson({
      assemblyId: "a1",
      assemblySslUrl: "https://api2.transloadit.com/assemblies/a1",
      createdAt: "2026-11-03T00:00:00.000Z",
      mediaVersion: "media-v1",
      workflowVersion: "remote-media-v1",
      phase: "chunks",
      captureId: "cap",
      originalKey: "capture/cap/rec.m4a",
      sourceDurationSeconds: 900,
      previousAssemblyIds: [],
    });
    expect(json.startsWith('{"assemblyId":"a1","assemblySslUrl"')).toBe(true);
    expect(parseTransloaditReceipt(JSON.parse(json))).toEqual({
      assemblyId: "a1",
      assemblySslUrl: "https://api2.transloadit.com/assemblies/a1",
      createdAt: "2026-11-03T00:00:00.000Z",
      mediaVersion: "media-v1",
      workflowVersion: "remote-media-v1",
      phase: "chunks",
      captureId: "cap",
      originalKey: "capture/cap/rec.m4a",
      sourceDurationSeconds: 900,
      previousAssemblyIds: [],
    });
  });

  test("manifest round-trips with schema field order", () => {
    const json = manifestJson({
      captureId: "cap",
      version: "media-v1",
      createdAt: "2026-11-03T00:00:00.000Z",
      sourceDurationSeconds: 900,
      chunks: [{ index: 0, key: "capture/cap/rec.m4a", startSeconds: 0, durationSeconds: 900 }],
    });
    expect(json.startsWith('{"captureId":"cap","version":"media-v1","createdAt"')).toBe(true);
    expect(parseMediaManifest(JSON.parse(json))?.chunks[0]?.key).toBe("capture/cap/rec.m4a");
  });
});

describe("verdictsAgree", () => {
  const verdict = (patch: Partial<ProbeVerdict>): ProbeVerdict => ({
    media: true,
    codec: "aac",
    channels: 1,
    sampleRate: 16000,
    durationSeconds: 900,
    ...patch,
  });

  test("decision-level agreement", () => {
    expect(verdictsAgree(verdict({}), verdict({ durationSeconds: 900.4 }))).toBe(true);
    expect(verdictsAgree(verdict({}), verdict({ channels: 2 }))).toBe(false);
    expect(
      verdictsAgree(
        verdict({ codec: "pcm", durationSeconds: 15000 }),
        verdict({ codec: "pcm", durationSeconds: 28801 }),
      ),
    ).toBe(false);
    expect(verdictsAgree(verdict({ media: false }), verdict({}))).toBe(false);
  });
});
