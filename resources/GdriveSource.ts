import { createIngest } from "../lib/ingest";
import { startTriage } from "./Triage";

export const GdriveSource = {
  directory: "/home/exedev/medina-data/google-drive-rethink",
  refreshEverySeconds: 3600,
};

type GdriveFile = {
  filename: string;
  contentType: string;
  metadata: Record<string, string>;
};

export async function ingestGdriveFile(env: Env, body: ArrayBuffer, file: GdriveFile) {
  const ingest = await createIngest(env, body, file);
  const workflow = await startTriage(env, ingest);
  return { id: workflow.id, key: ingest.key, status: "triage-pending" };
}
