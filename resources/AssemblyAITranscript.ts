import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { readJson, writeJson } from "../lib/artifact";
import { createAssemblyAITranscript, getAssemblyAITranscript, uploadToAssemblyAI, type AssemblyAITranscript as AssemblyAITranscriptResponse } from "../lib/assemblyai";
import type { Ingest } from "../lib/ingest";
import { stream } from "../lib/stream";

const VERSION = "assemblyai-u35p-v1";

export type TranscriptUtterance = {
  speaker: string | null;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
};

export type AssemblyAITranscriptResult = {
  provider: "assemblyai";
  version: typeof VERSION;
  ingestId: string;
  inputKey: string;
  transcriptId: string | null;
  vendorKey: string | null;
  status: "completed" | "error";
  completedAt: string;
  text: string | null;
  utterances: TranscriptUtterance[];
  error: string | null;
};

function keys(ingest: Ingest) {
  const prefix = `transcript/${VERSION}/${ingest.id}`;
  return { result: `${prefix}.json`, vendor: `${prefix}.assemblyai.json` };
}

function journalDay(ingest: Ingest) {
  return ingest.receivedAt.slice(0, 10);
}

function result(ingest: Ingest, partial: Omit<AssemblyAITranscriptResult, "provider" | "version" | "ingestId" | "inputKey" | "completedAt">): AssemblyAITranscriptResult {
  return {
    provider: "assemblyai",
    version: VERSION,
    ingestId: ingest.id,
    inputKey: ingest.key,
    completedAt: new Date().toISOString(),
    ...partial,
  };
}

function normalize(ingest: Ingest, transcript: AssemblyAITranscriptResponse, vendorKey: string): AssemblyAITranscriptResult {
  return result(ingest, {
    transcriptId: transcript.id,
    vendorKey,
    status: "completed",
    text: transcript.text ?? "",
    utterances: (transcript.utterances ?? []).map((utterance) => ({
      speaker: utterance.speaker ?? null,
      startMs: utterance.start,
      endMs: utterance.end,
      text: utterance.text,
      confidence: utterance.confidence ?? null,
    })),
    error: null,
  });
}

/**
 * Derives a normalized transcript from one immutable ingest. Uploading, polling,
 * and vendor payload storage are implementation details of this resource.
 */
export class AssemblyAITranscript extends WorkflowEntrypoint<Env, Ingest> {
  async run(event: WorkflowEvent<Ingest>, step: WorkflowStep) {
    const ingest = event.payload;
    const key = keys(ingest);
    const existing = await step.do("read existing transcript", () => readJson<AssemblyAITranscriptResult>(this.env.ARTIFACTS, key.result));
    if (existing) return existing;

    if (!ingest.contentType.startsWith("audio/")) {
      const failed = result(ingest, {
        transcriptId: null,
        vendorKey: null,
        status: "error",
        text: null,
        utterances: [],
        error: `AssemblyAI transcript requires audio, got ${ingest.contentType || "unknown"}`,
      });
      await step.do("write unsupported-media result", () => writeJson(this.env.ARTIFACTS, key.result, failed));
      return failed;
    }

    const uploadUrl = await step.do("upload ingest to AssemblyAI", async () => {
      const object = await this.env.ARTIFACTS.get(ingest.key);
      if (!object?.body) throw new Error(`Missing ingest artifact ${ingest.key}`);
      return uploadToAssemblyAI(this.env, object.body);
    });
    const submitted = await step.do("submit AssemblyAI transcript", () =>
      createAssemblyAITranscript(this.env, {
        audio_url: uploadUrl,
        speech_models: ["universal-3-5-pro"],
        speaker_labels: true,
        language_detection: true,
      }),
    );

    let transcript = submitted;
    for (let attempt = 1; transcript.status !== "completed" && transcript.status !== "error"; attempt += 1) {
      if (attempt > 120) throw new Error(`AssemblyAI transcript ${submitted.id} did not finish within two hours`);
      await step.sleep(`wait for AssemblyAI transcript (${attempt})`, "1 minute");
      transcript = await step.do(`get AssemblyAI transcript (${attempt})`, () => getAssemblyAITranscript(this.env, submitted.id));
    }

    return step.do("store AssemblyAI transcript", async () => {
      await writeJson(this.env.ARTIFACTS, key.vendor, transcript);
      const normalized =
        transcript.status === "completed"
          ? normalize(ingest, transcript, key.vendor)
          : result(ingest, {
              transcriptId: transcript.id,
              vendorKey: key.vendor,
              status: "error",
              text: null,
              utterances: [],
              error: transcript.error ?? "AssemblyAI transcription failed",
            });
      await writeJson(this.env.ARTIFACTS, key.result, normalized);
      if (normalized.status === "completed") {
        await stream(this.env).recordJournalTranscript(journalDay(ingest), {
          ingestId: ingest.id,
          transcriptKey: key.result,
          completedAt: normalized.completedAt,
        });
      }
      return normalized;
    });
  }
}

export async function startAssemblyAITranscript(env: Env, ingest: Ingest) {
  return env.ASSEMBLYAI_TRANSCRIPT.create({ id: `${VERSION}-${ingest.id}`, params: ingest });
}
