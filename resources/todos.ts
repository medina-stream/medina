#!/usr/bin/env bun

import { listAllBucketKeys, normalizeBucketKey, type Bucket } from "../lib/bucket";
import { createBucketFromEnv } from "../lib/bucket-bun";
import { bucketObject, defineResource, parseResourceArgs, runResource, writeBucketJson } from "../lib/resource";
import type { ChunkTranscript } from "./transcripts";

export type TodoItem = {
  chunkKey: string;
  completed: boolean;
  createdAt: string;
  id: string;
  recordingId: string;
  sourceText: string;
  sourceTranscriptKey: string;
  text: string;
  time: string;
};

export type TodosList = {
  generatedAt: string;
  sourceTranscriptCount: number;
  todos: TodoItem[];
  version: 1;
};

type TodosState = {
  outputKey: string;
  transcriptKeys: string[];
};

const todosOutputKey = "todos/list.json";

function normalizeTodoText(text: string) {
  return text
    .replace(/^[-:,.\s]+/, "")
    .replace(/\s+/g, " ")
    .replace(/[.?!,;:\s]+$/, "")
    .trim();
}

function splitTodoClause(text: string) {
  const match = text.match(/^(.+?)(?:\b(?:and then|then|okay|ok|checking out|stop)\b|[.!?]|$)/i);
  return normalizeTodoText(match?.[1] ?? text);
}

export function extractTranscriptTodos(text: string): string[] {
  const todos: string[] = [];
  const normalized = text.replace(/\s+/g, " ").trim();
  const pattern = /(?:^|[.!?]\s+|(?:^|[.!?]\s+|,\s+)(?:so|okay|ok),?\s*)to[-\s]?do\s*(?::|,|-)\s+/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(normalized)) !== null) {
    const after = normalized.slice(match.index + match[0].length);
    const item = splitTodoClause(after);
    if (item.length > 0) todos.push(item);
  }

  return todos;
}

async function todoId(input: { sourceTranscriptKey: string; index: number; text: string }) {
  const data = new TextEncoder().encode(`${input.sourceTranscriptKey}\n${input.index}\n${input.text}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function buildTodoItems(transcripts: ChunkTranscript[], generatedAt: string): Promise<TodoItem[]> {
  const items: TodoItem[] = [];
  for (const transcript of transcripts) {
    const extracted = extractTranscriptTodos(transcript.text ?? "");
    for (const [index, text] of extracted.entries()) {
      items.push({
        chunkKey: transcript.chunkKey,
        completed: false,
        createdAt: generatedAt,
        id: await todoId({ sourceTranscriptKey: transcript.transcriptKey, index, text }),
        recordingId: transcript.recordingId,
        sourceText: transcript.text,
        sourceTranscriptKey: transcript.transcriptKey,
        text,
        time: transcript.startTime,
      });
    }
  }

  return items.sort((left, right) => left.time.localeCompare(right.time) || left.id.localeCompare(right.id));
}

export const todosDefinition = defineResource<TodosState>({
  async materialize({ bucket, now, plan }) {
    const transcripts = await Promise.all(
      plan.state.transcriptKeys.map((key) => bucket.readJson<ChunkTranscript>(key)),
    );
    const generatedAt = now.toISOString();
    const list: TodosList = {
      generatedAt,
      sourceTranscriptCount: transcripts.length,
      todos: await buildTodoItems(transcripts, generatedAt),
      version: 1,
    };
    await writeBucketJson(plan.state.outputKey, list, bucket);
  },
  name: "todos",
  async plan({ bucket, inputKey }) {
    const outputKey = normalizeBucketKey(inputKey || todosOutputKey);
    const transcriptKeys = (await listAllBucketKeys(bucket, { prefix: "chunks/" }))
      .filter((key) => /^chunks\/\d{13}\/[^/]+\/transcript\.json$/.test(key))
      .sort();

    return {
      dependencies: transcriptKeys.map(bucketObject),
      outputs: [outputKey],
      state: {
        outputKey,
        transcriptKeys,
      },
    };
  },
  version: "2",
});

export async function materializeTodos(options: { bucket: Bucket; force?: boolean }) {
  await runResource(todosDefinition, {
    bucket: options.bucket,
    force: options.force,
    inputKey: todosOutputKey,
  });
  return await options.bucket.readJson<TodosList>(todosOutputKey);
}

if (import.meta.main) {
  const { force, inputKey } = parseResourceArgs();
  const bucket = createBucketFromEnv();
  const result = await runResource(todosDefinition, { bucket, force, inputKey });
  console.log(JSON.stringify(result.outputs, null, 2));
}
