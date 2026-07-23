import type { ArtifactRef } from "./artifact";
import type { TriageContentKind } from "./ingest-classification";

export type TriageDisposition = "delete" | "dispatch" | "retain";

export type TriageResult = {
  artifact: ArtifactRef;
  classifiedAt: string;
  content: {
    confidence: number;
    contentType?: string;
    eventTime?: string;
    facts?: Record<string, unknown>;
    kind: TriageContentKind;
  };
  disposition: TriageDisposition;
  duplicateOf?: ArtifactRef;
  ingestKey: string;
  labels: string[];
  policy: {
    reasons: string[];
    ruleIds: string[];
  };
  version: 1;
};
