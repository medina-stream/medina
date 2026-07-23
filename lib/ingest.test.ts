import { describe, expect, test } from "bun:test";

import * as ingest from "./ingest";

describe("ingest metadata", () => {
  test("normalizes metadata pairs into S3-safe keys", () => {
    expect(
      ingest.normalizeIngestMetadata({
        createdAt: "2026-04-07T12:00:00.000Z",
        originalFilename: "clip.m4a",
        sdkVersion: "medina-sdk/0.1.0",
      }),
    ).toEqual({
      "created-at": "2026-04-07T12:00:00.000Z",
      "original-filename": "clip.m4a",
      "sdk-version": "medina-sdk/0.1.0",
    });
  });

  test("requires standard metadata keys before presigning", () => {
    expect(() =>
      ingest.prepareIngestMetadata({
        "sdk-version": "medina-sdk/0.1.0",
        "original-filename": "clip.m4a",
      }),
    ).toThrow("Missing required ingest metadata: created-at");
  });

  test("preserves additional metadata when there is room", () => {
    expect(
      ingest.prepareIngestMetadata({
        "created-at": "2026-04-07T12:00:00.000Z",
        "original-filename": "clip.m4a",
        "sdk-version": "medina-sdk/0.1.0",
        "recording-started-at": "2026-04-07T11:59:58.000Z",
        device: "pixel",
      }),
    ).toEqual({
      "created-at": "2026-04-07T12:00:00.000Z",
      "original-filename": "clip.m4a",
      "sdk-version": "medina-sdk/0.1.0",
      "recording-started-at": "2026-04-07T11:59:58.000Z",
      device: "pixel",
    });
  });

  test("drops non-standard metadata that does not fit in the metadata budget", () => {
    const prepared = ingest.prepareIngestMetadata({
      "created-at": "2026-04-07T12:00:00.000Z",
      "original-filename": "clip.m4a",
      "sdk-version": "medina-sdk/0.1.0",
      extra: "x".repeat(4000),
      kept: "small",
    });

    expect(prepared).toEqual({
      "created-at": "2026-04-07T12:00:00.000Z",
      "original-filename": "clip.m4a",
      "sdk-version": "medina-sdk/0.1.0",
      kept: "small",
    });
  });

  test("builds headers from prepared metadata", () => {
    expect(
      ingest.getIngestMetadataHeaders({
        "created-at": "2026-04-07T12:00:00.000Z",
        "original-filename": "clip.m4a",
        "sdk-version": "medina-sdk/0.1.0",
        source: "sdk-test",
      }),
    ).toEqual({
      "x-amz-meta-created-at": "2026-04-07T12:00:00.000Z",
      "x-amz-meta-original-filename": "clip.m4a",
      "x-amz-meta-sdk-version": "medina-sdk/0.1.0",
      "x-amz-meta-source": "sdk-test",
    });
  });

  test("reads prepared metadata from request headers", () => {
    expect(
      ingest.getIngestMetadataFromHeaders(new Headers({
        "content-type": "audio/mpeg",
        "x-amz-meta-created-at": "2026-04-07T12:00:00.000Z",
        "x-amz-meta-original-filename": "clip.mp3",
        "x-amz-meta-sdk-version": "medina-sdk/0.1.0",
        "x-amz-meta-source": "sdk-test",
      })),
    ).toEqual({
      "created-at": "2026-04-07T12:00:00.000Z",
      "original-filename": "clip.mp3",
      "sdk-version": "medina-sdk/0.1.0",
      source: "sdk-test",
    });
  });
});

describe("presignIngestUpload", () => {
  test("signs content type and metadata headers for PUT uploads", async () => {
    const presignIngestUpload = ingest.createPresignIngestUpload({
      accessKeyId: "test-access-key",
      bucket: "test-bucket",
      endpoint: "https://s3.example.test",
      secretAccessKey: "test-secret-key",
    });
    const action = await presignIngestUpload({
      expiresIn: 3600,
      key: "in/test-key",
      metadata: {
        "created-at": "2026-04-07T12:00:00.000Z",
        "original-filename": "clip.m4a",
        "sdk-version": "medina-sdk/0.1.0",
        source: "sdk-test",
      },
      type: "audio/m4a",
    });

    const signedHeaders = new URL(action).searchParams.get("X-Amz-SignedHeaders");

    expect(signedHeaders).toBe(
      "content-type;host;x-amz-meta-created-at;x-amz-meta-original-filename;x-amz-meta-sdk-version;x-amz-meta-source",
    );
  });
});
