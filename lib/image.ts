import { Resvg } from "@resvg/resvg-js";

import { normalizeBucketKey, type Bucket } from "./bucket";
import { bucketObject, defineResource, type ResourceDefinition } from "./resource";

export type ImageVariant = "any" | "maskable";

export type ImageOutputSpec = {
  key: string;
  contentType: string;
  content?: string;
  size?: number;
  variant?: ImageVariant;
};

export type ImageResourceSpec = {
  name: string;
  prompt?: string;
  content?: string;
  background?: string;
  outputs: ImageOutputSpec[];
  generateSvg?: (prompt: string) => Promise<string>;
};

type ImageState = {
  output: ImageOutputSpec;
  sourceKey: string;
  sourceSvg: string;
};



const SVG_CONTENT_TYPE = "image/svg+xml; charset=utf-8";
const SVG_ROOT_RE = /<svg[\s\S]*<\/svg>/;

export function getImageOutputKey(name: string, outputKey: string) {
  return `${normalizeBucketKey(name)}/${normalizeBucketKey(outputKey)}`;
}

export function getSourceSvgKey(name: string) {
  return `${normalizeBucketKey(name)}/source.svg`;
}

export function extractSvg(text: string) {
  const match = SVG_ROOT_RE.exec(text);
  if (!match) throw new Error("No <svg> element found in generated image content.");
  return match[0];
}

function hashStringDjb2(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => key !== "generateSvg")
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function getImageSpecVersion(spec: ImageResourceSpec) {
  return hashStringDjb2(stableStringify(spec));
}

export function createMaskableSvg(sourceSvg: string, background: string, paddingRatio = 0.1) {
  const inset = Math.round(paddingRatio * 1000);
  const innerSize = 1000 - 2 * inset;
  const inner = sourceSvg.replace(/^\s*<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">
  <rect width="1000" height="1000" fill="${background}"/>
  <svg x="${inset}" y="${inset}" width="${innerSize}" height="${innerSize}" viewBox="0 0 1024 1024" preserveAspectRatio="xMidYMid meet">
    ${inner}
  </svg>
</svg>`;
}

function rasterize(svg: string, size: number) {
  return new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
}

function renderOutputSvg(output: ImageOutputSpec, sourceSvg: string, background?: string) {
  const svg = output.content ?? sourceSvg;
  if (output.variant === "maskable" && background) return createMaskableSvg(svg, background);
  return svg;
}

async function writeOutput(
  bucket: Bucket,
  outputKey: string,
  output: ImageOutputSpec,
  sourceSvg: string,
  background?: string,
) {
  if (output.contentType.startsWith("image/svg")) {
    await bucket.write(outputKey, renderOutputSvg(output, sourceSvg, background), { type: SVG_CONTENT_TYPE });
    return;
  }
  if (output.contentType === "image/png") {
    if (!output.size) throw new Error(`PNG output ${output.key} requires a size.`);
    await bucket.write(outputKey, rasterize(renderOutputSvg(output, sourceSvg, background), output.size), { type: "image/png" });
    return;
  }
  throw new Error(`Unsupported image content type for ${output.key}: ${output.contentType}`);
}

async function ensureSourceSvg(spec: ImageResourceSpec, bucket: Bucket, sourceKey: string): Promise<string> {
  if (spec.content) {
    if (!(await bucket.exists(sourceKey))) {
      await bucket.write(sourceKey, spec.content, { type: SVG_CONTENT_TYPE });
    }
    return spec.content;
  }
  if (await bucket.exists(sourceKey)) return await bucket.readText(sourceKey);
  const generate = spec.generateSvg ?? defaultGenerateSvg;
  const svg = extractSvg(await generate(spec.prompt ?? ""));
  await bucket.write(sourceKey, svg, { type: SVG_CONTENT_TYPE });
  return svg;
}

function getOpenAiProvider() {
  const baseURL = process.env.MEDINA_IMAGE_OPENAI_BASE_URL?.trim()
    || process.env.OPENAI_BASE_URL?.trim()
    || undefined;
  const apiKey = process.env.MEDINA_IMAGE_OPENAI_API_KEY?.trim()
    || process.env.OPENAI_API_KEY?.trim()
    || "unused";
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createOpenAI } = require("@ai-sdk/openai") as typeof import("@ai-sdk/openai");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateText } = require("ai") as typeof import("ai");
  return { generateText, provider: createOpenAI({ apiKey, baseURL }) };
}

async function defaultGenerateSvg(prompt: string): Promise<string> {
  const { generateText, provider } = getOpenAiProvider();
  const model = process.env.MEDINA_IMAGE_MODEL?.trim() || "gpt-4o-mini";
  const result = await generateText({
    model: provider(model),
    prompt: `Return ONLY the SVG markup (no prose, no code fence) for an app icon. ${prompt}`,
  });
  return result.text;
}

export function defineImageResource(spec: ImageResourceSpec): {
  definition: ResourceDefinition<ImageState>;
  output: ImageOutputSpec;
  outputKey: string;
  route: string;
}[] {
  const name = normalizeBucketKey(spec.name);
  const version = getImageSpecVersion(spec);
  const sourceKey = getSourceSvgKey(name);

  return spec.outputs.map((output) => {
    const outputKey = getImageOutputKey(name, output.key);
    const definition = defineResource<ImageState>({
      async materialize({ bucket, plan }) {
        const sourceSvg = await ensureSourceSvg(spec, bucket, sourceKey);
        await writeOutput(bucket, outputKey, plan.state.output, sourceSvg, spec.background);
      },
      name: `${name}/${output.key}`,
      async plan({ bucket, inputKey }) {
        if (normalizeBucketKey(inputKey) !== outputKey) {
          throw new Error(`Image resource ${outputKey} received unexpected input key ${inputKey}.`);
        }
        const sourceSvg = spec.content ?? (await bucket.exists(sourceKey) ? await bucket.readText(sourceKey) : "");
        return {
          dependencies: spec.content ? [] : [bucketObject(sourceKey)],
          outputs: [outputKey],
          state: { output, sourceKey, sourceSvg },
        };
      },
      version,
    });
    return { definition, output, outputKey, route: output.key };
  });
}
