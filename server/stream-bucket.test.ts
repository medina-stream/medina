import { describe, expect, test } from "bun:test";
import { getBucketForStream, toBucketId } from "./stream-bucket";
import type { Stream } from "#lib/stream";

function stream(bucketName: string): Stream {
  return {
    buckets: { default: { bucketName, endpoint: "https://storage.example", region: "auto" } },
    host: "example.test",
    users: [{ username: "default", profile_pic_url: "/default-profile.jpg", credentials: [], tokens: [] }],
  };
}

describe("stream bucket helpers", () => {
  test("formats bucket identity from stream credentials", () => {
    expect(toBucketId(stream("demo").buckets.default!)).toBe("s3://demo@storage.example/auto");
  });

  test("requires streams to have a bucket", () => {
    expect(() => getBucketForStream({ buckets: {}, users: [{ username: "default", profile_pic_url: "/default-profile.jpg", credentials: [], tokens: [] }], host: "example.test" })).toThrow("has no bucket");
  });

  test("caches the selected bucket for stable credentials", () => {
    const selected = stream("demo");
    expect(getBucketForStream(selected)).toBe(getBucketForStream(selected));
  });
});
