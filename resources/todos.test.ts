import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMemoryBucket } from "../lib/bucket.test";
import { runResource } from "../lib/resource";
import { extractTranscriptTodos, todosDefinition, type TodosList } from "./todos";

describe("todos resource", () => {
  test("extracts direct to-do phrases from transcript text", () => {
    expect(extractTranscriptTodos("So, to do, send me a notification when you first hear about this moment. And then continue.")).toEqual([
      "send me a notification when you first hear about this moment",
    ]);
    expect(extractTranscriptTodos("Todo: buy coffee. To-do - call Alex tomorrow.")).toEqual([
      "buy coffee",
      "call Alex tomorrow",
    ]);
    expect(extractTranscriptTodos("I don't know what to do. I want to do this later. What are we gonna do here?")).toEqual([]);
  });

  test("materializes a list tied to source transcript time and chunk", async () => {
    const root = mkdtempSync(join(tmpdir(), "medina-todos-"));
    const bucket = createMemoryBucket();
    try {
      await bucket.write("chunks/0202606050950/recording-1/transcript.json", `${JSON.stringify({
        chunkId: "0202606050950",
        chunkKey: "chunks/0202606050950/recording-1.ogg",
        createdAt: "2026-06-05T20:00:00.000Z",
        endTime: "2026-06-05T10:00:00.000Z",
        model: "test",
        provider: "openai",
        recordingId: "recording-1",
        response: { text: "So, to do, send me a notification when you first hear about this moment. Okay stop." },
        startTime: "2026-06-05T09:50:00.000Z",
        text: "So, to do, send me a notification when you first hear about this moment. Okay stop.",
        transcriptKey: "chunks/0202606050950/recording-1/transcript.json",
      }, null, 2)}\n`, { type: "application/json; charset=utf-8" });
      await bucket.write("chunks/0202606051000/recording-1/transcript.json", `${JSON.stringify({
        chunkId: "0202606051000",
        chunkKey: "chunks/0202606051000/recording-1.ogg",
        createdAt: "2026-06-05T20:00:00.000Z",
        endTime: "2026-06-05T10:10:00.000Z",
        model: "test",
        provider: "openai",
        recordingId: "recording-1",
        response: { text: "No speech detected." },
        startTime: "2026-06-05T10:00:00.000Z",
        text: "No speech detected.",
        transcriptKey: "chunks/0202606051000/recording-1/transcript.json",
      }, null, 2)}\n`, { type: "application/json; charset=utf-8" });

      const result = await runResource(todosDefinition, {
        bucket,
        inputKey: "todos/list.json",
        now: new Date("2026-06-05T21:00:00.000Z"),
      });

      expect(result.materialized).toBe(true);
      const list = await bucket.readJson<TodosList>("todos/list.json");
      expect(list.todos).toHaveLength(1);
      expect(list.todos[0]).toMatchObject({
        chunkKey: "chunks/0202606050950/recording-1.ogg",
        completed: false,
        sourceTranscriptKey: "chunks/0202606050950/recording-1/transcript.json",
        text: "send me a notification when you first hear about this moment",
        time: "2026-06-05T09:50:00.000Z",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
