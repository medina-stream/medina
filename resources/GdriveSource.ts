import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { downloadDriveFile, listDriveFiles } from "../lib/gdrive";
import { createIngest } from "../lib/ingest";
import { stream } from "../lib/stream";
import { startTriage } from "./Triage";

export class GdriveSource extends WorkflowEntrypoint<Env, Record<string, never>> {
  async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
    const files = await step.do("discover Drive files", () => listDriveFiles(this.env));
    await step.do("observe Drive files", async () => {
      const result = await stream(this.env).observeDrive(files);
      return { observed: result.observed, pending: result.pending };
    });
    return step.do("start download", async () => {
      const instance = await this.env.GDRIVE_INGEST.create({ params: {} });
      return { id: instance.id };
    });
  }
}

export class GdriveIngest extends WorkflowEntrypoint<Env, Record<string, never>> {
  async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
    const candidate = await step.do("claim Drive file", async () => {
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

    return step.do("download Drive file", async () => {
      const response = await downloadDriveFile(this.env, candidate.id);
      if (!response.body) throw new Error(`Drive file ${candidate.id} has no body`);
      const ingest = await createIngest(this.env, response.body, {
        id: `gdrive-${candidate.id}-${(candidate.md5Checksum ?? candidate.modifiedTime).replace(/[^a-zA-Z0-9_-]/g, "")}`,
        filename: candidate.name,
        contentType: candidate.mimeType,
        size: Number(candidate.size ?? 0),
        metadata: {
          "x-medina-source": "gdrive",
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
