import { describe, expect, test } from "bun:test";

import {
  checkIngestAnalysis,
  createIngestAnalysis,
  estimateIngestStartTime,
  getIngestAnalysisKey,
  getIngestAudioAnalysis,
  getIngestMediaKind,
  hasAudioStream,
} from "./ingest";

describe("ingest analysis", () => {
  test("detects audio streams and extracts basic audio facts", () => {
    const probe = {
      format: {
        duration: "12.5",
      },
      streams: [
        { codec_type: "video" },
        {
          bit_rate: "128000",
          channel_layout: "mono",
          channels: 1,
          codec_name: "aac",
          codec_type: "audio",
          duration: "12.5",
          sample_rate: "44100",
        },
      ],
    };

    expect(hasAudioStream(probe)).toBe(true);
    expect(getIngestMediaKind({ contentType: "audio/mp4", probe })).toBe("audio");
    expect(getIngestAudioAnalysis(probe)).toEqual({
      bitRate: 128000,
      channelLayout: "mono",
      channels: 1,
      codecName: "aac",
      durationSeconds: 12.5,
      sampleRate: 44100,
    });
  });

  test("estimates start time from metadata before falling back to ingest time", () => {
    expect(estimateIngestStartTime({
      ingestedAt: "2026-05-15T14:00:00.000Z",
      metadata: {
        "recording-started-at": "2026-05-15T13:45:00.000Z",
      },
      probe: null,
    })).toEqual({
      estimatedAt: "2026-05-15T13:45:00.000Z",
      source: "metadata:recording-started-at",
    });

    expect(estimateIngestStartTime({
      ingestedAt: "2026-05-15T14:00:00.000Z",
      metadata: {},
      probe: null,
    })).toEqual({
      estimatedAt: "2026-05-15T14:00:00.000Z",
      source: "ingested-at",
    });
  });

  test("builds a stable ingest analysis document", () => {
    const analysis = createIngestAnalysis({
      contentType: "audio/mpeg",
      ingestKey: "in/test-key",
      ingestedAt: "2026-05-15T14:00:00.000Z",
      metadata: {
        "original-filename": "clip.mp3",
      },
      probe: {
        format: {
          duration: "30.0",
          format_name: "mp3",
        },
        streams: [
          {
            codec_name: "mp3",
            codec_type: "audio",
            sample_rate: "48000",
          },
        ],
      },
      sizeBytes: 1234,
      type: "audio/mpeg",
    });

    expect(analysis).toMatchObject({
      analysisKey: getIngestAnalysisKey("in/test-key", "2026-05-15T14:00:00.000Z"),
      ingestKey: "in/test-key",
      media: {
        durationSeconds: 30,
        formatName: "mp3",
        hasAudioStream: true,
        kind: "audio",
        sizeBytes: 1234,
      },
      originalFileName: "clip.mp3",
      startTime: {
        estimatedAt: "2026-05-15T14:00:00.000Z",
        source: "ingested-at",
      },
      type: "audio/mpeg",
    });
    expect(checkIngestAnalysis(analysis)).toEqual([]);
  });
});
