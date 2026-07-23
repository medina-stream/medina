#!/usr/bin/env bun

import { listAllBucketKeys, normalizeBucketKey } from "../lib/bucket";
import { createBucketFromEnv } from "../lib/bucket-bun";
import { analyzeChunkSpeakers, getSpeakerAnalysisKey } from "../resources/speaker-analysis";

function usage() {
  return `
usage: bun scripts/analyze-speaker-chunks.ts [--prefix chunks/] [--limit n] [--force]

Creates speaker-analysis/<chunk-id>/<recording-id>.json for each Ogg chunk.
Currently this is a cheap VAD-backed scan; recognized speaker matching is added later.
`;
}

function parseArgs(argv: string[]) {
  let prefix = "chunks/";
  let limit = 25;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") throw new Error(usage());
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--prefix") {
      prefix = argv[++index] ?? prefix;
      continue;
    }
    if (arg === "--limit") {
      limit = Number(argv[++index] ?? limit);
      continue;
    }
    throw new Error(`unknown argument: ${arg}\n${usage()}`);
  }
  return { force, limit: Math.max(1, Math.trunc(limit)), prefix: normalizeBucketKey(prefix) };
}

const options = parseArgs(process.argv.slice(2));
const bucket = createBucketFromEnv();
const chunkKeys = (await listAllBucketKeys(bucket, { prefix: options.prefix }))
  .filter((key) => key.endsWith(".ogg"))
  .sort((left, right) => right.localeCompare(left));

let analyzed = 0;
let skipped = 0;
for (const chunkKey of chunkKeys) {
  if (analyzed >= options.limit) break;
  const outputKey = getSpeakerAnalysisKey(chunkKey);
  if (!options.force && await bucket.exists(outputKey)) {
    skipped += 1;
    continue;
  }
  const result = await analyzeChunkSpeakers(chunkKey, { bucket, force: options.force });
  analyzed += 1;
  console.log(JSON.stringify({ chunkKey, outputKey, speechSeconds: result.speechSeconds, speechLikelihood: result.speechLikelihood }));
}

console.log(JSON.stringify({ analyzed, scanned: chunkKeys.length, skipped }));
