import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMemoryBucket } from "../lib/bucket.test";
import { cosineSimilarity, identifyDiarizedSpeakers, speakerCentroidKey } from "./speaker-embeddings";

const originalEnv = { ...process.env };

describe("speaker embeddings", () => {
  let root: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    root = mkdtempSync(join(tmpdir(), "medina-speaker-embed-test-"));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(root, { force: true, recursive: true });
  });

  test("cosine similarity behaves", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  test("matches diarized speakers against stored centroids", async () => {
    const bucket = createMemoryBucket();
    await bucket.write("speakers/1/info.json", JSON.stringify({
      createdAt: "2026-06-26T00:00:00.000Z",
      id: "1",
      name: "Sco",
      sampleCount: 1,
      samples: [],
      updatedAt: "2026-06-26T00:00:00.000Z",
    }), { type: "application/json" });
    await bucket.write("speakers/1/sample.ogg", "sample-audio", { type: "audio/ogg" });
    await bucket.write(speakerCentroidKey("1"), JSON.stringify({
      createdAt: "2026-06-26T00:00:00.000Z",
      dims: 3,
      embedding: [1, 0, 0],
      model: "speechbrain/spkrec-ecapa-voxceleb",
      samples: [{ name: "sample.ogg", size: 12 }],
      speakerId: "1",
    }), { type: "application/json" });

    const fakeFfmpeg = join(root, "ffmpeg");
    writeFileSync(fakeFfmpeg, `#!/usr/bin/env bash\nfor last; do :; done\nif [ "$last" = "-y" ]; then prev=""; for arg; do [ "$arg" = "-y" ] && break; prev="$arg"; done; touch "$prev"; fi\n`, { mode: 0o755 });
    process.env.FFMPEG_PATH = fakeFfmpeg;

    const fakeEmbed = join(root, "embed");
    writeFileSync(fakeEmbed, `#!/usr/bin/env bash\ngroups=0\nfor arg; do [ "$arg" = "--group" ] && groups=$((groups+1)); done\nfirst='[0.99, 0.01, 0]'\nsecond='[0, 1, 0]'\nif [ "$groups" -ge 2 ]; then embeddings="[$first, $second]"; else embeddings="[$first]"; fi\nprintf '{"model": "speechbrain/spkrec-ecapa-voxceleb", "embeddings": %s}' "$embeddings"\n`, { mode: 0o755 });
    process.env.SPEAKER_EMBED_COMMAND = fakeEmbed;

    const audioPath = join(root, "chunk.ogg");
    writeFileSync(audioPath, "chunk-audio");

    const matches = await identifyDiarizedSpeakers({
      audioPath,
      bucket,
      spans: [
        { end: 5, speaker: 0, start: 0 },
        { end: 12, speaker: 1, start: 6 },
      ],
    });

    expect(matches).toEqual([
      { diarizedSpeaker: 0, similarity: expect.closeTo(0.9999, 2), speakerId: "1", speechSeconds: 5 },
      { diarizedSpeaker: 1, similarity: expect.closeTo(0, 2), speakerId: null, speechSeconds: 6 },
    ]);
  });

  test("skips embedding when no centroids exist", async () => {
    const bucket = createMemoryBucket();
    const matches = await identifyDiarizedSpeakers({
      audioPath: "/nonexistent.ogg",
      bucket,
      spans: [{ end: 5, speaker: 0, start: 0 }],
    });
    expect(matches).toEqual([
      { diarizedSpeaker: 0, similarity: null, speakerId: null, speechSeconds: 5 },
    ]);
  });
});
