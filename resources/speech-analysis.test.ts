import { describe, expect, test } from "bun:test";

import { createSpeechWindows, parseSilencedetect, summarizeSpeech } from "./speech-analysis";

describe("speech analysis", () => {
  test("parses ffmpeg silencedetect output", () => {
    const parsed = parseSilencedetect(`
[silencedetect @ 0x1] silence_start: 0
[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 2.5
[silencedetect @ 0x1] silence_start: 8
`, 10);

    expect(parsed).toEqual([
      { durationSeconds: 2.5, endSeconds: 2.5, startSeconds: 0 },
      { durationSeconds: 2, endSeconds: 10, startSeconds: 8 },
    ]);
  });

  test("summarizes whether a chunk is worth transcribing", () => {
    expect(summarizeSpeech({
      durationSeconds: 10,
      minSpeechSeconds: 1.5,
      silence: [{ durationSeconds: 9.2, endSeconds: 9.2, startSeconds: 0 }],
    })).toMatchObject({
      shouldTranscribe: false,
      speechSeconds: 0.8000000000000007,
    });

    expect(summarizeSpeech({
      durationSeconds: 10,
      minSpeechSeconds: 1.5,
      silence: [{ durationSeconds: 8, endSeconds: 8, startSeconds: 0 }],
    })).toMatchObject({
      shouldTranscribe: true,
      speechSeconds: 2,
    });
  });

  test("rolls speech spans up into fixed 100 second windows", () => {
    expect(createSpeechWindows({
      durationSeconds: 250,
      speech: [
        { durationSeconds: 30, startSeconds: 10, endSeconds: 40 },
        { durationSeconds: 50, startSeconds: 90, endSeconds: 140 },
        { durationSeconds: 5, startSeconds: 220, endSeconds: 225 },
      ],
      windowSeconds: 100,
    })).toEqual([
      { durationSeconds: 100, endSeconds: 100, speechLikelihood: 0.4, speechSeconds: 40, startSeconds: 0 },
      { durationSeconds: 100, endSeconds: 200, speechLikelihood: 0.4, speechSeconds: 40, startSeconds: 100 },
      { durationSeconds: 50, endSeconds: 250, speechLikelihood: 0.1, speechSeconds: 5, startSeconds: 200 },
    ]);
  });
});
