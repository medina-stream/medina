import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { readJson, writeJson } from "../lib/artifact";
import { type RootItem, stream } from "../lib/stream";
import { type TriageResult } from "./Triage";

function kind(type: string) {
  return type.startsWith("audio/") ? "audio" : type.startsWith("image/") ? "image" : type;
}

function startEstimate(filename: string) {
  const match = filename.match(/(\d{5})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return {
    at: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))).toISOString(),
    confidence: 0.8,
    basis: "filename",
  };
}

function summary(triage: TriageResult): RootItem {
  return {
    triageId: triage.id,
    kind: kind(triage.detectedType),
    durationSeconds: null,
    start: startEstimate(triage.filename),
    source: `${triage.metadata["x-medina-source"] ?? "ingest"}:${triage.filename}`,
  };
}

export class Root extends WorkflowEntrypoint<Env, { triageKey: string }> {
  async run(event: WorkflowEvent<{ triageKey: string }>, step: WorkflowStep) {
    const item = await step.do("summarize triage", async () => {
      const triage = await readJson<TriageResult>(this.env.ARTIFACTS, event.payload.triageKey);
      if (!triage) throw new Error(`Missing triage artifact ${event.payload.triageKey}`);
      return summary(triage);
    });
    const root = await step.do("prepare root", async () => {
      const next = await stream(this.env).prepareRoot(item);
      return { generation: next.generation, items: next.items };
    });
    const key = `root/${root.generation}.json`;
    await step.do("write root", async () => {
      await writeJson(this.env.ARTIFACTS, key, { items: root.items });
      return { key };
    });
    return step.do("publish root", async () => {
      await stream(this.env).commitRoot(root.generation, key);
      return { key, generation: root.generation };
    });
  }
}

export async function rootArtifact(env: Env, key: string) {
  return readJson<{ items: RootItem[] }>(env.ARTIFACTS, key);
}
