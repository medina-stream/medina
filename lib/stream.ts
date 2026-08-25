import { DurableObject } from "cloudflare:workers";
import type { DriveFile } from "./gdrive";

export type IngestSummary = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  hash: string;
  triageKey: string;
  status: "accepted" | "retained";
  triagedAt: string;
};

type DriveCandidate = DriveFile & {
  candidateId: string;
  status: "pending" | "downloading" | "ingested";
  observedAt: string;
  leaseExpiresAt: string | null;
  ingestId: string | null;
};

type StreamState = {
  ingests: { count: number; accepted: number; retained: number; last: IngestSummary | null };
  gdrive: { lastObservedAt: string | null; candidates: DriveCandidate[] };
};

function initialState(): StreamState {
  return {
    ingests: { count: 0, accepted: 0, retained: 0, last: null },
    gdrive: { lastObservedAt: null, candidates: [] },
  };
}

function candidateId(file: DriveFile) {
  return `${file.id}:${file.md5Checksum ?? file.modifiedTime}`;
}

export class Stream extends DurableObject<Env> {
  async state(): Promise<StreamState> {
    const stored = await this.ctx.storage.get<Partial<StreamState>>("state");
    return {
      ingests: { ...initialState().ingests, ...stored?.ingests },
      gdrive: { ...initialState().gdrive, ...stored?.gdrive },
    };
  }

  async observeDrive(files: DriveFile[]) {
    const state = await this.state();
    const now = new Date().toISOString();
    const existing = new Map(state.gdrive.candidates.map((candidate) => [candidate.candidateId, candidate]));
    const candidates = [...state.gdrive.candidates];
    for (const file of files) {
      const id = candidateId(file);
      if (!existing.has(id)) candidates.push({ ...file, candidateId: id, status: "pending", observedAt: now, leaseExpiresAt: null, ingestId: null });
    }
    const refreshed = candidates.map((candidate) =>
      candidate.status === "downloading" && candidate.leaseExpiresAt && candidate.leaseExpiresAt < now
        ? { ...candidate, status: "pending" as const, leaseExpiresAt: null }
        : candidate,
    );
    refreshed.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
    const next = { ...state, gdrive: { lastObservedAt: now, candidates: refreshed.slice(0, 100) } };
    await this.ctx.storage.put("state", next);
    return { observed: files.length, pending: next.gdrive.candidates.filter((candidate) => candidate.status === "pending").length };
  }

  async claimDrive() {
    const state = await this.state();
    const now = new Date();
    const candidates = state.gdrive.candidates.map((candidate) =>
      candidate.status === "downloading" && candidate.leaseExpiresAt && candidate.leaseExpiresAt < now.toISOString()
        ? { ...candidate, status: "pending" as const, leaseExpiresAt: null }
        : candidate,
    );
    const index = candidates.findIndex((candidate) => candidate.status === "pending");
    if (index < 0) {
      await this.ctx.storage.put("state", { ...state, gdrive: { ...state.gdrive, candidates } });
      return null;
    }
    const claimed = { ...candidates[index], status: "downloading" as const, leaseExpiresAt: new Date(now.getTime() + 10 * 60_000).toISOString() };
    candidates[index] = claimed;
    await this.ctx.storage.put("state", { ...state, gdrive: { ...state.gdrive, candidates } });
    return claimed;
  }

  async finishDrive(candidateId: string, ingestId: string) {
    const state = await this.state();
    const candidates = state.gdrive.candidates.map((candidate) =>
      candidate.candidateId === candidateId ? { ...candidate, status: "ingested" as const, leaseExpiresAt: null, ingestId } : candidate,
    );
    await this.ctx.storage.put("state", { ...state, gdrive: { ...state.gdrive, candidates } });
  }

  async commitTriage(summary: IngestSummary): Promise<IngestSummary> {
    const state = await this.state();
    const ingests = {
      count: state.ingests.count + 1,
      accepted: state.ingests.accepted + (summary.status === "accepted" ? 1 : 0),
      retained: state.ingests.retained + (summary.status === "retained" ? 1 : 0),
      last: summary,
    };
    await this.ctx.storage.put("state", { ...state, ingests });
    return summary;
  }
}

export function stream(env: Env) {
  return env.STREAM.getByName("default");
}
