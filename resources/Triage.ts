import { readJson, writeJson } from "../lib/artifact";
import { captureTime, type Ingest } from "../lib/ingest";

export type TriageResult = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  hash: string;
  triageKey: string;
  status: "accepted" | "retained";
  triagedAt: string;
  receivedAt: string;
  capturedAt: string;
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

export async function inspectIngest(env: Env, ingest: Ingest): Promise<TriageResult> {
  const object = await env.ARTIFACTS.get(ingest.key);
  if (!object) throw new Error(`Missing ingest artifact ${ingest.key}`);
  const body = await object.arrayBuffer();
  const hash = hex(await crypto.subtle.digest("SHA-256", body));
  const detectedType = detectType(new Uint8Array(body), ingest.contentType);
  const signals: string[] = [];
  if (ingest.size === 0) signals.push("empty");
  if (/\.(exe|dll|bat|cmd|sh|ps1)$/i.test(ingest.filename)) signals.push("executable-name");
  if (ingest.filename.includes("..") || /[\\/]/.test(ingest.filename)) signals.push("unsafe-filename");
  if (ingest.contentType && ingest.contentType !== "application/octet-stream" && ingest.contentType !== detectedType) signals.push("declared-type-mismatch");
  const status = signals.includes("executable-name") || signals.includes("unsafe-filename") ? "retained" : "accepted";
  const triageKey = `triage/${ingest.id}.json`;
  const result: TriageResult = { id: ingest.id, filename: ingest.filename, contentType: ingest.contentType, size: ingest.size, hash, triageKey, status, triagedAt: new Date().toISOString(), receivedAt: ingest.receivedAt, capturedAt: ingest.capturedAt || captureTime(ingest), detectedType, signals, metadata: ingest.metadata };
  await writeJson(env.ARTIFACTS, triageKey, result);
  return result;
}

export function triageArtifact(env: Env, key: string) {
  return readJson<TriageResult>(env.ARTIFACTS, key);
}
