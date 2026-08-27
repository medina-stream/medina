import { DurableObject } from "cloudflare:workers";
import type { DriveFile } from "./gdrive";

export type JournalTranscript = {
  ingestId: string;
  transcriptKey: string;
  completedAt: string;
};

export type JournalReport = {
  day: string;
  journalKey: string;
  generatedAt: string;
};

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

export type RootItem = {
  triageId: string;
  kind: string;
  durationSeconds: number | null;
  start: { at: string; confidence: number; basis: string } | null;
  source: string;
};

type RootState = { generation: number; items: RootItem[]; head: { key: string; generation: number } | null };

type StreamState = {
  ingests: { count: number; accepted: number; retained: number; last: IngestSummary | null };
  gdrive: { lastObservedAt: string | null; candidates: DriveCandidate[] };
  root: RootState;
};

function initialState(): StreamState {
  return {
    ingests: { count: 0, accepted: 0, retained: 0, last: null },
    gdrive: { lastObservedAt: null, candidates: [] },
    root: { generation: 0, items: [], head: null },
  };
}

function candidateId(file: DriveFile) {
  return `${file.id}:${file.md5Checksum ?? file.modifiedTime}`;
}

export class Stream extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS journal_transcripts (
        day TEXT NOT NULL,
        ingest_id TEXT PRIMARY KEY,
        transcript_key TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_transcripts_by_day ON journal_transcripts(day, completed_at, ingest_id);
      CREATE TABLE IF NOT EXISTS journal_reports (
        day TEXT PRIMARY KEY,
        journal_key TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_reports_by_generated_at ON journal_reports(generated_at DESC);
    `);
  }

  async state(): Promise<StreamState> {
    const stored = await this.ctx.storage.get<Partial<StreamState>>("state");
    return {
      ingests: { ...initialState().ingests, ...stored?.ingests },
      gdrive: { ...initialState().gdrive, ...stored?.gdrive },
      root: { ...initialState().root, ...stored?.root },
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

  async prepareRoot(item: RootItem) {
    const state = await this.state();
    const items = [item, ...state.root.items.filter((current) => current.triageId !== item.triageId)].slice(0, 100);
    const root = { ...state.root, generation: state.root.generation + 1, items };
    await this.ctx.storage.put("state", { ...state, root });
    return { generation: root.generation, items: root.items };
  }

  async commitRoot(generation: number, key: string) {
    const state = await this.state();
    if (generation < state.root.generation) return state.root.head;
    const root = { ...state.root, head: { key, generation } };
    await this.ctx.storage.put("state", { ...state, root });
    return root.head;
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

  async recordJournalTranscript(day: string, transcript: JournalTranscript) {
    this.ctx.storage.sql.exec(
      `INSERT INTO journal_transcripts (day, ingest_id, transcript_key, completed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ingest_id) DO UPDATE SET
         day = excluded.day,
         transcript_key = excluded.transcript_key,
         completed_at = excluded.completed_at`,
      day,
      transcript.ingestId,
      transcript.transcriptKey,
      transcript.completedAt,
    );
  }

  async journalTranscripts(day: string): Promise<JournalTranscript[]> {
    return this.ctx.storage.sql
      .exec<JournalTranscript>(
        "SELECT ingest_id AS ingestId, transcript_key AS transcriptKey, completed_at AS completedAt FROM journal_transcripts WHERE day = ? ORDER BY completed_at, ingest_id",
        day,
      )
      .toArray();
  }

  async recordJournalReport(report: JournalReport) {
    this.ctx.storage.sql.exec(
      `INSERT INTO journal_reports (day, journal_key, generated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         journal_key = excluded.journal_key,
         generated_at = excluded.generated_at`,
      report.day,
      report.journalKey,
      report.generatedAt,
    );
  }

  async journalReports(): Promise<JournalReport[]> {
    return this.ctx.storage.sql
      .exec<JournalReport>(
        "SELECT day, journal_key AS journalKey, generated_at AS generatedAt FROM journal_reports ORDER BY day DESC",
      )
      .toArray();
  }
}

export function stream(env: Env) {
  return env.STREAM.getByName("default");
}
