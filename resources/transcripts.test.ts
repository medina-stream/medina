import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMemoryBucket } from "../lib/bucket.test";
import { runResource } from "../lib/resource";
import { createGpsHour, getGpsHourKey } from "./gps-hour";
import {
  callDeepgramTranscription,
  classifyUtteranceProvenance,
  getDayTranscriptKey,
  isDayTranscriptFinal,
  listTranscripts,
  materializeDayTranscripts,
  readDayTranscripts,
  resolveChunkTimeZone,
  transcriptChunksDefinition,
  type ChunkTranscript,
  type TranscriptUtterance,
} from "./transcripts";

function startMockDeepgram(options?: { utterances?: unknown[]; transcript?: string }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    metadata: { duration: 600, request_id: "mock-request" },
    results: {
      channels: [{ alternatives: [{ transcript: options?.transcript ?? "hello from deepgram" }] }],
      utterances: options?.utterances ?? [
        { confidence: 0.98, end: 2.5, speaker: 0, start: 0.5, transcript: "hello from deepgram" },
      ],
    },
  })) as typeof fetch;
  process.env.DEEPGRAM_API_KEY = "test-key";
  process.env.DEEPGRAM_MODEL = "nova-3";
  process.env.DEEPGRAM_BASE_URL = "http://deepgram.test";
  return {
    stop() {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("transcript resources", () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      MEDINA_GPS_TIME_ZONE: "UTC",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("day transcripts become final once past the transcription window", () => {
    const now = new Date("2026-07-21T13:59:59Z");
    expect(isDayTranscriptFinal("020260714", now)).toBe(true);
    expect(isDayTranscriptFinal("020260715", now)).toBe(true);
    expect(isDayTranscriptFinal("020260716", now)).toBe(false);
    expect(isDayTranscriptFinal("020260720", now)).toBe(false);
    expect(isDayTranscriptFinal("not-a-day", now)).toBe(false);
  });

  test("day transcripts wait for a 14-hour local-day margin before becoming final", () => {
    const beforeMargin = new Date("2026-07-21T13:59:59Z");
    const afterMargin = new Date("2026-07-21T14:00:01Z");
    expect(isDayTranscriptFinal("020260716", beforeMargin)).toBe(false);
    expect(isDayTranscriptFinal("020260716", afterMargin)).toBe(true);
  });

  test("calls Deepgram and captures transcript text with diarized utterances", async () => {
    const root = mkdtempSync(join(tmpdir(), "medina-deepgram-test-"));
    const input = join(root, "audio.ogg");
    writeFileSync(input, "audio");
    const server = startMockDeepgram();
    try {
      const result = await callDeepgramTranscription(input);
      expect(result).toMatchObject({
        model: "deepgram/nova-3",
        provider: "deepgram",
        text: "hello from deepgram",
        utterances: [{ speaker: 0, text: "hello from deepgram" }],
      });
      expect(result.response.requestId).toBe("mock-request");
    } finally {
      server.stop(true);
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("classifies utterance provenance relative to the self speaker", () => {
    const utterances: TranscriptUtterance[] = [
      { confidence: 1, end: 5, speaker: 0, start: 0, text: "me talking" },
      { confidence: 1, end: 12, speaker: 1, start: 6, text: "reply to me" },
      { confidence: 1, end: 300, speaker: 2, start: 290, text: "tv in the distance" },
    ];
    const classified = classifyUtteranceProvenance({
      selfSpeakerId: "1",
      speakers: [
        { diarizedSpeaker: 0, similarity: 0.8, speakerId: "1", speechSeconds: 5 },
        { diarizedSpeaker: 1, similarity: 0.2, speakerId: null, speechSeconds: 6 },
        { diarizedSpeaker: 2, similarity: null, speakerId: null, speechSeconds: 10 },
      ],
      utterances,
    });
    expect(classified.map((utterance) => utterance.provenance)).toEqual(["me", "to-me", "ambient"]);
    expect(classified[0]).toMatchObject({ speakerId: "1" });
  });

  test("everything is ambient when the self speaker is absent", () => {
    const classified = classifyUtteranceProvenance({
      selfSpeakerId: "1",
      speakers: [{ diarizedSpeaker: 0, similarity: 0.1, speakerId: null, speechSeconds: 60 }],
      utterances: [{ confidence: 1, end: 60, speaker: 0, start: 0, text: "podcast audio" }],
    });
    expect(classified[0]!.provenance).toBe("ambient");
  });


  test("lists transcripts with a time-range prefix scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "medina-transcripts-list-test-"));
    const bucket = createMemoryBucket();
    try {
      await bucket.write("chunks/0202606050950/recording-1/transcript.json", JSON.stringify({
        chunkId: "0202606050950",
        chunkKey: "chunks/0202606050950/recording-1.ogg",
        createdAt: "2026-06-05T10:00:00.000Z",
        endTime: "2026-06-05T10:00:00.000Z",
        model: "test-model",
        provider: "deepgram",
        recordingId: "recording-1",
        response: {},
        startTime: "2026-06-05T09:50:00.000Z",
        text: "matching transcript",
        transcriptKey: "chunks/0202606050950/recording-1/transcript.json",
      }));
      await bucket.write("chunks/0202606060950/recording-2/transcript.json", JSON.stringify({
        chunkId: "0202606060950",
        chunkKey: "chunks/0202606060950/recording-2.ogg",
        createdAt: "2026-06-06T10:00:00.000Z",
        endTime: "2026-06-06T10:00:00.000Z",
        model: "test-model",
        provider: "deepgram",
        recordingId: "recording-2",
        response: {},
        startTime: "2026-06-06T09:50:00.000Z",
        text: "other day",
        transcriptKey: "chunks/0202606060950/recording-2/transcript.json",
      }));

      const transcripts = await listTranscripts({
        bucket,
        from: new Date("2026-06-05T00:00:00.000Z"),
        to: new Date("2026-06-06T00:00:00.000Z"),
      });

      expect(transcripts.map((transcript) => transcript.text)).toEqual(["matching transcript"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("resolves chunk timezone from nearby GPS points, carry-forward, and default fallback", async () => {
    const bucket = createMemoryBucket();
    await bucket.write(getGpsHourKey("02026060509"), `${JSON.stringify(createGpsHour("02026060509", [
      { ingestKey: "in/gps-1", latitude: 37.78, longitude: -122.42, speed: 0, time: "2026-06-05T09:40:00.000Z", timeZone: "America/Los_Angeles" },
    ]), null, 2)}\n`, { type: "application/json; charset=utf-8" });
    await bucket.write(getGpsHourKey("02026060503"), `${JSON.stringify(createGpsHour("02026060503", [
      { ingestKey: "in/gps-2", latitude: 40.71, longitude: -74.0, speed: 0, time: "2026-06-05T03:00:00.000Z", timeZone: "America/New_York" },
    ]), null, 2)}\n`, { type: "application/json; charset=utf-8" });

    expect(await resolveChunkTimeZone(bucket, "2026-06-05T09:50:00.000Z")).toEqual({
      timeZone: "America/Los_Angeles",
      timeZoneSource: "gps",
    });
    expect(await resolveChunkTimeZone(bucket, "2026-06-05T08:29:59.000Z")).toEqual({
      timeZone: "America/New_York",
      timeZoneSource: "carry-forward",
    });
    expect(await resolveChunkTimeZone(bucket, "2026-06-07T00:00:00.000Z")).toEqual({
      timeZone: "UTC",
      timeZoneSource: "default",
    });
  });

  test("rejects nearby GPS joins beyond 30 minutes before carrying forward", async () => {
    const bucket = createMemoryBucket();
    await bucket.write(getGpsHourKey("02026060509"), `${JSON.stringify(createGpsHour("02026060509", [
      { ingestKey: "in/gps-1", latitude: 37.78, longitude: -122.42, speed: 0, time: "2026-06-05T09:00:00.000Z", timeZone: "America/Los_Angeles" },
    ]), null, 2)}\n`, { type: "application/json; charset=utf-8" });

    expect(await resolveChunkTimeZone(bucket, "2026-06-05T09:30:01.000Z")).toEqual({
      timeZone: "America/Los_Angeles",
      timeZoneSource: "carry-forward",
    });
  });

  test("materializes and reads day transcript resources by local-day membership", async () => {
    const root = mkdtempSync(join(tmpdir(), "medina-day-transcripts-test-"));
    const bucket = createMemoryBucket();
    try {
      await bucket.write(getGpsHourKey("02026060501"), `${JSON.stringify(createGpsHour("02026060501", [
        { ingestKey: "in/gps-la", latitude: 34.05, longitude: -118.24, speed: 0, time: "2026-06-05T01:00:00.000Z", timeZone: "America/Los_Angeles" },
      ]), null, 2)}\n`, { type: "application/json; charset=utf-8" });
      await bucket.write("chunks/0202606050950/recording-1/transcript.json", JSON.stringify({
        chunkId: "0202606050950",
        chunkKey: "chunks/0202606050950/recording-1.ogg",
        createdAt: "2026-06-05T10:00:00.000Z",
        endTime: "2026-06-05T10:00:00.000Z",
        model: "test-model",
        provider: "deepgram",
        recordingId: "recording-1",
        response: {},
        startTime: "2026-06-05T09:50:00.000Z",
        text: "day transcript",
        transcriptKey: "chunks/0202606050950/recording-1/transcript.json",
      }));
      await bucket.write("chunks/0202606061800/recording-default/transcript.json", JSON.stringify({
        chunkId: "0202606061800",
        chunkKey: "chunks/0202606061800/recording-default.ogg",
        createdAt: "2026-06-06T18:10:00.000Z",
        endTime: "2026-06-06T18:15:00.000Z",
        model: "test-model",
        provider: "deepgram",
        recordingId: "recording-default",
        response: {},
        startTime: "2026-06-06T18:00:00.000Z",
        text: "default zone day",
        transcriptKey: "chunks/0202606061800/recording-default/transcript.json",
      }));
      await bucket.write("chunks/0202606050105/recording-la/transcript.json", JSON.stringify({
        chunkId: "0202606050105",
        chunkKey: "chunks/0202606050105/recording-la.ogg",
        createdAt: "2026-06-05T01:10:00.000Z",
        endTime: "2026-06-05T01:15:00.000Z",
        model: "test-model",
        provider: "deepgram",
        recordingId: "recording-la",
        response: {},
        startTime: "2026-06-05T01:05:00.000Z",
        text: "previous local day",
        transcriptKey: "chunks/0202606050105/recording-la/transcript.json",
      }));

      expect(await readDayTranscripts("020260605", { bucket })).toBeNull();
      await materializeDayTranscripts("020260604", { bucket });
      await materializeDayTranscripts("020260605", { bucket });
      await materializeDayTranscripts("020260606", { bucket });

      const previousDay = await readDayTranscripts("020260604", { bucket });
      const transcripts = await readDayTranscripts("020260605", { bucket });
      const defaultDay = await readDayTranscripts("020260606", { bucket });
      expect(await bucket.exists(getDayTranscriptKey("020260605"))).toBe(true);
      expect(previousDay).toMatchObject([{
        text: "previous local day",
        timeZone: "America/Los_Angeles",
        timeZoneSource: "gps",
      }]);
      expect(transcripts).toMatchObject([
        {
          text: "day transcript",
          timeZone: "America/Los_Angeles",
          timeZoneSource: "carry-forward",
        },
      ]);
      expect(defaultDay).toMatchObject([{
        text: "default zone day",
        timeZone: "UTC",
        timeZoneSource: "default",
      }]);
      expect(transcripts?.map((transcript) => transcript.text)).toEqual(["day transcript"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("materializes chunk transcripts through Deepgram with provenance", async () => {
    const bucket = createMemoryBucket();
    const server = startMockDeepgram();
    try {
      await bucket.write("chunks/0202606050950/recording-1.ogg", "audio", { type: "audio/ogg" });
      const result = await runResource(transcriptChunksDefinition, {
        bucket,
        inputKey: "chunks/0202606050950/recording-1.ogg",
        now: new Date("2026-06-05T10:00:00.000Z"),
      });

      expect(result.materialized).toBe(true);
      const transcript = await bucket.readJson<ChunkTranscript>("chunks/0202606050950/recording-1/transcript.json");
      expect(transcript).toMatchObject({
        model: "deepgram/nova-3",
        provider: "deepgram",
        text: "hello from deepgram",
        utterances: [{ provenance: "ambient", speaker: 0, text: "hello from deepgram" }],
      });
      expect(transcript.speakers).toEqual([
        { diarizedSpeaker: 0, similarity: null, speakerId: null, speechSeconds: 2 },
      ]);
    } finally {
      server.stop(true);
    }
  });
});
