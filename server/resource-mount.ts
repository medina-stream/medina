import type { Hono } from "hono";

import type { Bucket } from "../lib/bucket";
import { runResource, type ResourceDefinition } from "../lib/resource";
import { getRequestBucket, registerPublicPaths } from "./stream-middleware";

export type MountResourceOptions = {
  prefix: string;
  public?: boolean;
  cacheControl?: string;
};

const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";

export type MountedResourceOutput<State> = {
  definition: ResourceDefinition<State>;
  outputKey: string;
  route: string;
  contentType: string;
};

const inFlight = new WeakMap<Bucket, Map<string, Promise<void>>>();

async function ensureMaterialized<State>(
  bucket: Bucket,
  definition: ResourceDefinition<State>,
  outputKey: string,
) {
  if (await bucket.exists(outputKey)) return;
  let bucketMap = inFlight.get(bucket);
  if (!bucketMap) {
    bucketMap = new Map();
    inFlight.set(bucket, bucketMap);
  }
  let run = bucketMap.get(outputKey);
  if (!run) {
    run = runResource(definition, { bucket, inputKey: outputKey }).then(() => undefined);
    bucketMap.set(outputKey, run);
    run.finally(() => bucketMap?.delete(outputKey));
  }
  await run;
}

export function mountResource<State>(
  app: Hono,
  outputs: MountedResourceOutput<State>[],
  options: MountResourceOptions,
) {
  const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL;

  if (options.public) {
    registerPublicPaths(outputs.map((output) => output.route));
  }

  for (const output of outputs) {
    app.get(output.route, async (c) => {
      const bucket = getRequestBucket(c);
      await ensureMaterialized(bucket, output.definition, output.outputKey);
      if (!(await bucket.exists(output.outputKey))) return c.notFound();

      const stats = await bucket.stat(output.outputKey);
      const data = await bucket.readArrayBuffer(output.outputKey);
      return new Response(data, {
        headers: {
          "cache-control": cacheControl,
          "content-type": stats.type ?? output.contentType,
          ...(stats.lastModified ? { "last-modified": stats.lastModified.toUTCString() } : {}),
        },
      });
    });
  }
}
