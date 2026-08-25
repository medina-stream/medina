import type { Hono } from "hono";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { readJson, writeJson } from "../lib/artifact";
import { type IngestSummary, stream } from "../stream";

export type Ingest = {
  id: string;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  receivedAt: string;
  metadata: Record<string, string>;
};
export type Triage = IngestSummary & {
  receivedAt: string;
  detectedType: string;
  signals: string[];
  metadata: Record<string, string>;
};

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function detectType(bytes: Uint8Array, declared: string) {
  const text = new TextDecoder().decode(bytes.slice(0, 32));
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") return "audio/wav";
  if (text.startsWith("ID3")) return "audio/mpeg";
  if (text.startsWith("OggS")) return "audio/ogg";
  if (text.startsWith("\u0089PNG")) return "image/png";
  if (text.startsWith("%PDF")) return "application/pdf";
  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) return "application/json";
  if (bytes.slice(4, 8).every((byte, index) => "ftyp".charCodeAt(index) === byte)) return "audio/mp4";
  return declared || "application/octet-stream";
}

function signals(ingest: Ingest, detectedType: string, hash: string) {
  const result: string[] = [];
  if (ingest.size === 0) result.push("empty");
  if (/\.(exe|dll|bat|cmd|sh|ps1)$/i.test(ingest.filename)) result.push("executable-name");
  if (ingest.filename.includes("..") || /[\\/]/.test(ingest.filename)) result.push("unsafe-filename");
  if (ingest.contentType && ingest.contentType !== "application/octet-stream" && ingest.contentType !== detectedType) result.push("declared-type-mismatch");
  if (/^0+$/.test(hash)) result.push("impossible-hash");
  return result;
}

function metadata(request: Request) {
  return Object.fromEntries([...request.headers].filter(([name]) => name.startsWith("x-medina-")));
}

export class IngestWorkflow extends WorkflowEntrypoint<Env, Ingest> {
  async run(event: WorkflowEvent<Ingest>, step: WorkflowStep) {
    const triage = await step.do("triage ingest", async () => {
      const object = await this.env.ARTIFACTS.get(event.payload.key);
      if (!object) throw new Error(`Missing ingest artifact ${event.payload.key}`);
      const body = await object.arrayBuffer();
      const hash = hex(await crypto.subtle.digest("SHA-256", body));
      const detectedType = detectType(new Uint8Array(body), event.payload.contentType);
      const findings = signals(event.payload, detectedType, hash);
      const status = findings.includes("executable-name") || findings.includes("unsafe-filename") ? "retained" : "accepted";
      const triageKey = `triage/${event.payload.id}.json`;
      const result: Triage = {
        id: event.payload.id,
        filename: event.payload.filename,
        contentType: event.payload.contentType,
        size: event.payload.size,
        hash,
        triageKey,
        status,
        triagedAt: new Date().toISOString(),
        receivedAt: event.payload.receivedAt,
        detectedType,
        signals: findings,
        metadata: event.payload.metadata,
      };
      await writeJson(this.env.ARTIFACTS, triageKey, result);
      return result;
    });
    return step.do("route triage", async () => {
      const summary = await stream(this.env).commitTriage(triage);
      return { id: summary.id, status: summary.status, triageKey: summary.triageKey };
    });
  }
}

export async function triageArtifact(env: Env, key: string) {
  return readJson<Triage>(env.ARTIFACTS, key);
}

export function mountTriageSdr(app: Hono<{ Bindings: Env }>) {
  app.post("/ingests", async (c) => {
    const body = await c.req.raw.arrayBuffer();
    if (!body.byteLength) return c.json({ error: "ingest body is required" }, 400);
    const ingest: Ingest = {
      id: crypto.randomUUID(),
      key: "",
      filename: c.req.header("x-medina-filename") ?? "upload.bin",
      contentType: c.req.header("content-type") ?? "application/octet-stream",
      size: body.byteLength,
      receivedAt: new Date().toISOString(),
      metadata: metadata(c.req.raw),
    };
    ingest.key = `in/${ingest.id}`;
    await c.env.ARTIFACTS.put(ingest.key, body, {
      httpMetadata: { contentType: ingest.contentType },
      customMetadata: { filename: ingest.filename, receivedAt: ingest.receivedAt },
    });
    const instance = await c.env.INGEST.create({ id: ingest.id, params: ingest });
    return c.json({ id: instance.id, key: ingest.key, status: "triage-pending" }, 202);
  });

  app.get("/ingests/:id", async (c) => {
    const triage = await triageArtifact(c.env, `triage/${c.req.param("id")}.json`);
    return triage ? c.json(triage) : c.json({ error: "Unknown ingest." }, 404);
  });
}
