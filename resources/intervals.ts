#!/usr/bin/env bun

import { createBucketFromEnv } from "../lib/bucket-bun";
import {
  bucketObject,
  defineResource,
  parseResourceArgs,
  runResource,
  writeBucketJson,
} from "../lib/resource";
import {
  checkInterval,
  createInterval,
  getIntervalChunkKeys,
  getIntervalRecordings,
  normalizeIntervalIdInput,
  parseIntervalId,
} from "./interval";

type IntervalsState =
  { intervalId: string; intervalKey: string; intervalValue: ReturnType<typeof createInterval> };

export const intervalsDefinition = defineResource<IntervalsState>({
  async materialize({ bucket, plan }) {
    const issues = checkInterval(plan.state.intervalValue);
    if (issues.length > 0) {
      throw new Error(`Interval check failed: ${JSON.stringify(issues)}`);
    }

    await writeBucketJson(plan.state.intervalKey, plan.state.intervalValue, bucket);
  },
  name: "intervals",
  async plan({ bucket, inputKey, now }) {
    const intervalId = normalizeIntervalIdInput(inputKey);
    const parsedInterval = parseIntervalId(intervalId);

    const chunkKeys = await getIntervalChunkKeys(intervalId, { bucket });
    const recordings = await getIntervalRecordings(chunkKeys, { bucket });
    const intervalValue = createInterval({ interval: parsedInterval, recordings });

    return {
      dependencies: chunkKeys.map(bucketObject),
      outputs: [parsedInterval.key],
      state: {
        intervalId: parsedInterval.id,
        intervalKey: parsedInterval.key,
        intervalValue,
      },
    };
  },
  version: "2",
});

if (import.meta.main) {
  const bucket = createBucketFromEnv();
  const { force, inputKey } = parseResourceArgs();
  const result = await runResource(intervalsDefinition, { bucket, force, inputKey });
  console.log(JSON.stringify(result.outputs));
}
