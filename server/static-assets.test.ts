import { describe, expect, test } from "bun:test";
import { staticAssetFile } from "./static-assets";

describe("static asset fallback", () => {
  test("maps public paths to the static asset root", () => {
    const asset = staticAssetFile("/icon.svg");
    expect(asset?.key).toBe("icon.svg");
    expect(asset?.contentType).toBe("image/svg+xml");
  });

  test("does not expose a /static URL namespace", () => {
    const asset = staticAssetFile("/static/icon.svg");
    expect(asset?.key).toBe("static/icon.svg");
  });
});
