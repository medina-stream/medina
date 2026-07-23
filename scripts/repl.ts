import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { listObjects } from "../lib/bucket";
import { createBucketFromEnv } from "../lib/bucket-bun";
import {
  fetchBucketObjectToTempFile,
  writeBucketJson,
} from "../lib/resource";

const bucket = createBucketFromEnv();
const listBucketObjects = () => listObjects(bucket);

Object.assign(globalThis, {
  bucket,
  listObjects: listBucketObjects,
  fetchBucketObjectToTempFile,
  writeBucketJson,
});

console.log("Loaded: bucket, listObjects, fetchBucketObjectToTempFile, writeBucketJson");
console.log("Type .exit or press Ctrl+D to exit.");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (scope: typeof globalThis) => Promise<unknown>;

const rl = createInterface({ input: stdin, output: stdout });

while (true) {
  const line = await rl.question("medina> ").catch(() => ".exit");
  const source = line.trim();

  if (!source) {
    continue;
  }

  if (source === ".exit") {
    rl.close();
    break;
  }

  try {
    const run = new AsyncFunction("scope", `with (scope) { return (${source}); }`);
    const result = await run(globalThis);
    if (result !== undefined) {
      console.log(result);
    }
  } catch (error) {
    console.error(error);
  }
}
