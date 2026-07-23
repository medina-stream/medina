import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMemoryBucket } from "../lib/bucket.test";
import { runResource } from "../lib/resource";
import { generateAudioFixture } from "./audio-fixture";
import { getSpeakerAnalysisKey, speakerAnalysisDefinition, type SpeakerAnalysis } from "./speaker-analysis";

describe("speaker analysis resource", () => {
  test("creates one JSON analysis object per chunk", async () => {
    const root = mkdtempSync(join(tmpdir(), "medina-speaker-analysis-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "medina-speaker-fixture-"));
    const previousProvider = process.env.SPEECH_ANALYSIS_PROVIDER;
    process.env.SPEECH_ANALYSIS_PROVIDER = "ffmpeg";
    try {
      const bucket = createMemoryBucket();
      const fixture = generateAudioFixture({ outDir: fixtureDir, text: "This is a speaker analysis fixture." });
      const chunkKey = "chunks/0202606251200/recording-1.ogg";
      await bucket.write(chunkKey, await Bun.file(fixture.outputPath).arrayBuffer(), { type: "audio/ogg" });

      const result = await runResource(speakerAnalysisDefinition, { bucket, inputKey: chunkKey, now: new Date("2026-06-25T12:10:00.000Z") });
      expect(result.outputs).toEqual([getSpeakerAnalysisKey(chunkKey)]);
      expect(result.materialized).toBe(true);
      const analysis = await bucket.readJson<SpeakerAnalysis>(getSpeakerAnalysisKey(chunkKey));
      expect(analysis).toMatchObject({
        chunkId: "0202606251200",
        chunkKey,
        method: "speech-vad-only",
        model: "none",
        recognizedSpeakers: [],
        recordingId: "recording-1",
      });
      expect(analysis.speechSeconds).toBeGreaterThan(0);
      expect(await bucket.exists("speech-analysis/0202606251200/recording-1.json")).toBe(true);
    } finally {
      if (previousProvider === undefined) delete process.env.SPEECH_ANALYSIS_PROVIDER;
      else process.env.SPEECH_ANALYSIS_PROVIDER = previousProvider;
      rmSync(root, { force: true, recursive: true });
      rmSync(fixtureDir, { force: true, recursive: true });
    }
  });
});
