import { beforeEach, describe, expect, test } from "bun:test";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

describe("getStatus", () => {
  test("reports a request-derived hostname and s3 bucket identity", async () => {
    process.env.S3_BUCKET = "medina-prod";
    process.env.S3_ENDPOINT = "https://s3.example.test";
    process.env.S3_REGION = "auto";

    const statusModuleUrl = new URL(`./status.ts?status-test=${Date.now()}`, import.meta.url).href;
    const { getStatus } = await import(statusModuleUrl);

    expect(getStatus("https://medina.example.com/status.json")).toEqual({
      bucket_id: "s3://medina-prod@s3.example.test/auto",
      capabilities: expect.any(Object),
      current_user: null,
      hostname: "medina.example.com",
      message: "all systems go (streams-v1)",
      ok: true,
    });
  });

  test("reports env-derived hostname when no request URL is provided", async () => {
    process.env.S3_BUCKET = "medina-prod";
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_REGION;
    process.env.MEDINA_ROOT = "https://hosted.example.app";

    const statusModuleUrl = new URL(`./status.ts?status-test-env-host=${Date.now()}`, import.meta.url).href;
    const { getStatus } = await import(statusModuleUrl);

    expect(getStatus()).toEqual({
      bucket_id: "s3://medina-prod/auto",
      capabilities: expect.any(Object),
      current_user: null,
      hostname: "hosted.example.app",
      message: "all systems go (streams-v1)",
      ok: true,
    });
  });

  test("reports the current tailscale user when provided", async () => {
    process.env.S3_BUCKET = "medina-prod";
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_REGION;

    const statusModuleUrl = new URL(`./status.ts?status-test-current-user=${Date.now()}`, import.meta.url).href;
    const { getStatus } = await import(statusModuleUrl);

    expect(getStatus("https://medina.example.com/status.json", {
      auth_method: "tailscale",
      credentials: [{ type: "tailscale", value: "dev@example.com" }],
      profile_pic_url: "https://example.com/scott.jpg",
      tokens: [{ label: "default", token: "must-not-leak" }],
      username: "Scott Raymond",
    })).toEqual({
      bucket_id: "s3://medina-prod/auto",
      capabilities: expect.any(Object),
      current_user: {
        auth_method: "tailscale",
        credentials: [{ type: "tailscale", value: "dev@example.com" }],
        profile_pic_url: "https://example.com/scott.jpg",
        username: "Scott Raymond",
      },
      hostname: "medina.example.com",
      message: "all systems go (streams-v1)",
      ok: true,
    });
  });

  test("accepts an explicit request-scoped bucket identity override", async () => {
    process.env.S3_BUCKET = "medina-prod";
    process.env.S3_ENDPOINT = "https://s3.example.test";
    process.env.S3_REGION = "auto";

    const statusModuleUrl = new URL(`./status.ts?status-test-bucket-override=${Date.now()}`, import.meta.url).href;
    const { getStatus } = await import(statusModuleUrl);

    expect(getStatus("https://alice.stream.example/status.json", null, {
      bucketId: "s3://medina-alice@s3.example.test/auto",
    })).toMatchObject({
      bucket_id: "s3://medina-alice@s3.example.test/auto",
      hostname: "alice.stream.example",
    });
  });
});
