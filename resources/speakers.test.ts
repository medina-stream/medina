import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMemoryBucket } from "../lib/bucket.test";
import { createSpeaker, deleteSpeakerSample, listSpeakers, readSpeaker, updateSpeaker, writeSpeakerSample } from "./speakers";

describe("speaker resources", () => {
  test("stores speaker info and sample audio in bucket-backed objects", async () => {
    const root = mkdtempSync(join(tmpdir(), "medina-speakers-"));
    const bucket = createMemoryBucket();
    try {
      const created = await createSpeaker({ bucket, name: "Scott", notes: "phone mic", now: new Date("2026-06-25T00:00:00.000Z") });
      expect(created).toMatchObject({ id: "1", name: "Scott", sampleCount: 0 });
      expect(await bucket.exists("speakers/1/info.json")).toBe(true);

      const updated = await updateSpeaker({ bucket, id: "1", name: "Sco", notes: "clean samples", now: new Date("2026-06-25T01:00:00.000Z") });
      expect(updated).toMatchObject({ id: "1", name: "Sco", notes: "clean samples" });

      const sampled = await writeSpeakerSample({
        bucket,
        contentType: "audio/ogg",
        data: new TextEncoder().encode("fake ogg").buffer,
        filename: "sample 1.ogg",
        id: "1",
      });
      expect(sampled?.samples).toHaveLength(1);
      expect(sampled?.samples[0]).toMatchObject({ contentType: "audio/ogg", key: "speakers/1/sample-1.ogg", name: "sample-1.ogg" });
      expect(await bucket.readText("speakers/1/sample-1.ogg")).toBe("fake ogg");

      expect(await listSpeakers({ bucket })).toHaveLength(1);
      const afterDelete = await deleteSpeakerSample({ bucket, id: "1", sampleName: "sample-1.ogg" });
      expect(afterDelete?.samples).toHaveLength(0);
      expect(await readSpeaker({ bucket, id: "1" })).toMatchObject({ id: "1", sampleCount: 0 });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
