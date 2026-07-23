import { setIngestHandler } from "../lib/ingest-handlers";
import { ensureIngestWorkFromTriage, ingestWorkDefinition } from "./ingest-scheduler";

export const audioIngestHandler = setIngestHandler({
  accepts: (result) => result.content.kind === "audio" || result.content.kind === "av-candidate",
  async ensureWork({ bucket, membership, now, result }) {
    return await ensureIngestWorkFromTriage({
      bucket,
      now,
      priority: membership.priority,
      triage: result,
    });
  },
  groupKey: (result) => result.ingestKey,
  inputKey: (result) => result.ingestKey,
  name: "ingests",
  priority: (result) => {
    const timestamp = new Date(result.content.eventTime ?? result.artifact.createdAt ?? result.classifiedAt).getTime();
    return Number.isFinite(timestamp) ? -timestamp : 0;
  },
  schedule: { mode: "immediate" },
  work: ingestWorkDefinition,
});
