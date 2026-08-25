import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { downloadDriveFile, listDriveFiles } from "../lib/gdrive";
import { createIngest } from "../lib/ingest";
import { stream } from "../lib/stream";
import type { Source } from "../resources/EasyVoice";
import { startTriage } from "../resources/Triage";

export class SourceRefresh extends WorkflowEntrypoint<Env, Source> {
  async run(event: WorkflowEvent<Source>, step: WorkflowStep) {
    const files = await step.do("discover source", () => listDriveFiles(this.env, event.payload.folderId));
    await step.do("observe source", async () => {
      const result = await stream(this.env).observeDrive(files);
      return { observed: result.observed, pending: result.pending };
    });
    return step.do("start ingest", async () => {
      const instance = await this.env.SOURCE_INGEST.create({ params: event.payload });
      return { id: instance.id };
    });
  }
}

export class SourceIngest extends WorkflowEntrypoint<Env, Source> {
  async run(event: WorkflowEvent<Source>, step: WorkflowStep) {
    const candidate = await step.do("claim source file", async () => {
      const claimed = await stream(this.env).claimDrive();
      if (!claimed) return null;
      return {
        candidateId: claimed.candidateId,
        id: claimed.id,
        name: claimed.name,
        mimeType: claimed.mimeType,
        modifiedTime: claimed.modifiedTime,
        md5Checksum: claimed.md5Checksum,
        size: claimed.size,
      };
    });
    if (!candidate) return { status: "idle" };

    return step.do("download source file", async () => {
      const response = await downloadDriveFile(this.env, candidate.id);
      if (!response.body) throw new Error(`Source file ${candidate.id} has no body`);
      const ingest = await createIngest(this.env, response.body, {
        id: `${event.payload.name}-${candidate.id}-${(candidate.md5Checksum ?? candidate.modifiedTime).replace(/[^a-zA-Z0-9_-]/g, "")}`,
        filename: candidate.name,
        contentType: candidate.mimeType,
        size: Number(candidate.size ?? 0),
        metadata: {
          "x-medina-source": event.payload.name,
          "x-medina-gdrive-id": candidate.id,
          "x-medina-gdrive-modified-at": candidate.modifiedTime,
        },
      });
      const triage = await startTriage(this.env, ingest);
      await stream(this.env).finishDrive(candidate.candidateId, ingest.id);
      return { ingestId: ingest.id, triageId: triage.id };
    });
  }
}
