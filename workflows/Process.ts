import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { downloadDriveFile } from "../lib/gdrive";
import { createIngest } from "../lib/ingest";
import { startAssemblyAITranscript } from "../resources/AssemblyAITranscript";
import { inspectIngest } from "../resources/Triage";
import type { ProcessRequest } from "./Source";

/** The durable, retryable path from one source item to its derived artifacts. */
export class ProcessIngest extends WorkflowEntrypoint<Env, ProcessRequest> {
  async run(event: WorkflowEvent<ProcessRequest>, step: WorkflowStep) {
    const { source, file } = event.payload;
    const ingest = await step.do("download and store ingest", async () => {
      const response = await downloadDriveFile(this.env, file.id);
      if (!response.body) throw new Error(`Source file ${file.id} has no body`);
      return createIngest(this.env, response.body, {
        id: `${source.name}-${file.id}-${(file.md5Checksum ?? file.modifiedTime).replace(/[^a-zA-Z0-9_-]/g, "")}`,
        filename: file.name,
        contentType: file.mimeType,
        size: Number(file.size ?? 0),
        metadata: { "x-medina-source": source.name, "x-medina-gdrive-id": file.id, "x-medina-gdrive-modified-at": file.modifiedTime },
      });
    });
    const inspection = await step.do("inspect ingest", () => inspectIngest(this.env, ingest));
    if (inspection.status !== "accepted" || !inspection.detectedType.startsWith("audio/")) return inspection;
    const transcript = await step.do("start transcript", () => startAssemblyAITranscript(this.env, { ...ingest, contentType: inspection.detectedType }));
    return { inspection, transcriptId: transcript.id };
  }
}
