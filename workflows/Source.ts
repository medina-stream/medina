import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { listDriveFiles, type DriveFile } from "../lib/gdrive";
import type { Source } from "../resources/EasyVoice";

export type ProcessRequest = { source: Source; file: DriveFile };

function id(source: Source, file: DriveFile) {
  return `${source.name}-${file.id}-${file.md5Checksum ?? file.modifiedTime}`.replace(/[^a-zA-Z0-9_-]/g, "");
}

/** Discover a source and hand each immutable file version to the shared ingest workflow. */
export class SourceRun extends WorkflowEntrypoint<Env, Source> {
  async run(event: WorkflowEvent<Source>, step: WorkflowStep) {
    const files = await step.do("discover source", () => listDriveFiles(this.env, event.payload.folderId));
    const started = await step.do("start ingest workflows", async () => {
      let count = 0;
      for (const file of files) {
        try {
          await this.env.PROCESS_INGEST.create({ id: id(event.payload, file), params: { source: event.payload, file } });
          count += 1;
        } catch (error) {
          if (!(error instanceof Error) || !/already exists/i.test(error.message)) throw error;
        }
      }
      return count;
    });
    return { discovered: files.length, started };
  }
}
