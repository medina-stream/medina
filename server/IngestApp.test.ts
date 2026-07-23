import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryBucket } from "../lib/bucket.test";
import { createIngestService } from "../lib/ingest";

const originalEnv = { ...process.env };

describe("ingest upload handler", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("stores request bodies under the provided ingest key", async () => {
    const bucket = createMemoryBucket();
    const { storeIncomingIngest } = createIngestService({
      bucket,
      presignIngestUpload: async () => {
        throw new Error("presignIngestUpload should not be called when storing an incoming ingest");
      },
    });

    expect(await storeIncomingIngest(new Request("http://localhost/in", {
      method: "POST",
      headers: {
        "content-type": "audio/mpeg",
        "x-amz-meta-created-at": "2026-04-07T12:00:00.000Z",
        "x-amz-meta-original-filename": "foo.mp3",
        "x-amz-meta-sdk-version": "medina-sdk/0.1.0",
        "x-medina-ingest-key": "in/test-key",
      },
      body: "hello world",
    }))).toEqual({
      key: "in/test-key",
      metadata: {
        "created-at": "2026-04-07T12:00:00.000Z",
        "original-filename": "foo.mp3",
        "sdk-version": "medina-sdk/0.1.0",
      },
    });

    expect(await bucket.readText("in/test-key")).toBe("hello world");

    expect(await bucket.stat("in/test-key")).toMatchObject({
      headers: {
        "content-type": "audio/mpeg",
        "x-amz-meta-created-at": "2026-04-07T12:00:00.000Z",
        "x-amz-meta-original-filename": "foo.mp3",
        "x-amz-meta-sdk-version": "medina-sdk/0.1.0",
        "x-medina-ingest-key": "in/test-key",
      },
      metadata: {
        "created-at": "2026-04-07T12:00:00.000Z",
        "original-filename": "foo.mp3",
        "sdk-version": "medina-sdk/0.1.0",
      },
      type: "audio/mpeg",
    });
  });
});
