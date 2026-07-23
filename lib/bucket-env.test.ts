import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("bucket environment", () => {
  test("requires S3_BUCKET when resolving a required bucket name", async () => {
    delete process.env.S3_BUCKET;

    const bucketEnvModuleUrl = new URL(`./bucket.ts?bucket-env-test=${Date.now()}`, import.meta.url).href;
    const { getRequiredBucketName } = await import(bucketEnvModuleUrl);

    expect(() => getRequiredBucketName()).toThrow("Missing S3_BUCKET");
  });

  test("createBucketFromEnv requires S3_BUCKET", async () => {
    delete process.env.S3_BUCKET;

    const bucketBunModuleUrl = new URL(`./bucket-bun.ts?bucket-env-test=${Date.now()}`, import.meta.url).href;
    const { createBucketFromEnv } = await import(bucketBunModuleUrl);

    expect(() => createBucketFromEnv()).toThrow("Missing S3_BUCKET");
  });
});
