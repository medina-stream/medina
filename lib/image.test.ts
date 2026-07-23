import { describe, expect, test } from "bun:test";

import { createMemoryBucket } from "./bucket.test";
import { runResource } from "./resource";
import {
  createMaskableSvg,
  defineImageResource,
  extractSvg,
  getImageOutputKey,
  getImageSpecVersion,
  getSourceSvgKey,
} from "./image";

const SOURCE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#5b21b6"/></svg>`;

describe("image resources", () => {
  test("extractSvg pulls the svg root out of surrounding prose", () => {
    expect(extractSvg("sure! <svg></svg>")).toBe("<svg></svg>");
    expect(() => extractSvg("no svg here")).toThrow("No <svg>");
  });

  test("getImageSpecVersion changes when any spec field changes", () => {
    const base = {
      name: "app-icon",
      content: SOURCE_SVG,
      outputs: [{ key: "icon.svg", contentType: "image/svg+xml" }],
    };
    const a = getImageSpecVersion(base);
    const b = getImageSpecVersion({ ...base, content: SOURCE_SVG + " " });
    const c = getImageSpecVersion({ ...base, outputs: [{ key: "icon.svg", contentType: "image/svg+xml", variant: "maskable" as const }] });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(getImageSpecVersion(base)).toBe(a);
  });

  test("createMaskableSvg wraps the source with a background rect and inset svg", () => {
    const wrapped = createMaskableSvg(SOURCE_SVG, "#1e1b4b");
    expect(wrapped).toContain('<rect width="1000" height="1000" fill="#1e1b4b"/>');
    expect(wrapped).toContain("<svg x=\"100\" y=\"100\"");
    expect(wrapped).not.toContain(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect`);
  });

  test("defineImageResource materializes svg and png outputs into the bucket", async () => {
    const bucket = createMemoryBucket();
    const [svgOutput, pngOutput] = defineImageResource({
      name: "app-icon",
      content: SOURCE_SVG,
      outputs: [
        { key: "icon.svg", contentType: "image/svg+xml" },
        { key: "icon-192.png", contentType: "image/png", size: 192 },
      ],
    });

    await runResource(svgOutput.definition, { bucket, inputKey: svgOutput.outputKey });
    await runResource(pngOutput.definition, { bucket, inputKey: pngOutput.outputKey });

    expect(await bucket.exists(getSourceSvgKey("app-icon"))).toBe(true);
    expect(await bucket.exists(getImageOutputKey("app-icon", "icon.svg"))).toBe(true);
    expect(await bucket.exists(getImageOutputKey("app-icon", "icon-192.png"))).toBe(true);
    const stats = await bucket.stat(getImageOutputKey("app-icon", "icon-192.png"));
    expect(stats.type).toBe("image/png");
    expect(stats.size).toBeGreaterThan(100);
  });

  test("maskable png outputs use the wrapped svg", async () => {
    const bucket = createMemoryBucket();
    const [svgOutput, maskableOutput] = defineImageResource({
      name: "app-icon",
      content: SOURCE_SVG,
      background: "#1e1b4b",
      outputs: [
        { key: "icon.svg", contentType: "image/svg+xml" },
        { key: "icon-maskable-192.png", contentType: "image/png", size: 192, variant: "maskable" },
      ],
    });
    await runResource(svgOutput.definition, { bucket, inputKey: svgOutput.outputKey });
    await runResource(maskableOutput.definition, { bucket, inputKey: maskableOutput.outputKey });

    const maskableSvgKey = getImageOutputKey("app-icon", "icon-maskable-192.png");
    expect(await bucket.exists(maskableSvgKey)).toBe(true);
  });

  test("generateSvg is invoked and cached when no inline content is provided", async () => {
    const bucket = createMemoryBucket();
    const calls: string[] = [];
    const [svgOutput] = defineImageResource({
      name: "app-icon",
      prompt: "a purple M",
      generateSvg: async (prompt) => {
        calls.push(prompt);
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><!-- ${prompt} --></svg>`;
      },
      outputs: [{ key: "icon.svg", contentType: "image/svg+xml" }],
    });
    await runResource(svgOutput.definition, { bucket, inputKey: svgOutput.outputKey });
    await runResource(svgOutput.definition, { bucket, inputKey: svgOutput.outputKey });
    expect(calls).toHaveLength(1);
    expect(await bucket.readText(getSourceSvgKey("app-icon"))).toContain("a purple M");
  });

  test("output-specific content overrides the source for that output only", async () => {
    const bucket = createMemoryBucket();
    const [svgOutput, monoOutput] = defineImageResource({
      name: "app-icon",
      content: SOURCE_SVG,
      outputs: [
        { key: "icon.svg", contentType: "image/svg+xml" },
        { key: "icon-monochrome.svg", contentType: "image/svg+xml", content: "<svg></svg>" },
      ],
    });
    await runResource(svgOutput.definition, { bucket, inputKey: svgOutput.outputKey });
    await runResource(monoOutput.definition, { bucket, inputKey: monoOutput.outputKey });
    expect(await bucket.readText(svgOutput.outputKey)).toBe(SOURCE_SVG);
    expect(await bucket.readText(monoOutput.outputKey)).toBe("<svg></svg>");
  });
});
