import { DurableObject } from "cloudflare:workers";

export type JournalTranscript = { ingestId: string; transcriptKey: string; completedAt: string };
export type JournalReport = { day: string; journalKey: string; generatedAt: string };

/** Person-scoped SQLite catalog. Artifact payloads stay in R2. */
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
    `);
  }

  async recordJournalTranscript(day: string, transcript: JournalTranscript) {
    this.ctx.storage.sql.exec(
      `INSERT INTO journal_transcripts (day, ingest_id, transcript_key, completed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ingest_id) DO UPDATE SET day = excluded.day, transcript_key = excluded.transcript_key, completed_at = excluded.completed_at`,
      day, transcript.ingestId, transcript.transcriptKey, transcript.completedAt,
    );
  }

  async journalTranscripts(day: string): Promise<JournalTranscript[]> {
    return this.ctx.storage.sql.exec<JournalTranscript>(
      "SELECT ingest_id AS ingestId, transcript_key AS transcriptKey, completed_at AS completedAt FROM journal_transcripts WHERE day = ? ORDER BY completed_at, ingest_id", day,
    ).toArray();
  }

  async recordJournalReport(report: JournalReport) {
    this.ctx.storage.sql.exec(
      `INSERT INTO journal_reports (day, journal_key, generated_at) VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET journal_key = excluded.journal_key, generated_at = excluded.generated_at`,
      report.day, report.journalKey, report.generatedAt,
    );
  }

  async journalReports(): Promise<JournalReport[]> {
    return this.ctx.storage.sql.exec<JournalReport>(
      "SELECT day, journal_key AS journalKey, generated_at AS generatedAt FROM journal_reports ORDER BY day DESC",
    ).toArray();
  }

  async journalDaysNeedingReport(beforeDay: string): Promise<string[]> {
    return this.ctx.storage.sql.exec<{ day: string }>(
      `SELECT transcripts.day FROM journal_transcripts AS transcripts
       LEFT JOIN journal_reports AS reports ON reports.day = transcripts.day
       WHERE transcripts.day < ? GROUP BY transcripts.day
       HAVING reports.day IS NULL OR MAX(transcripts.completed_at) > reports.generated_at
       ORDER BY transcripts.day LIMIT 31`, beforeDay,
    ).toArray().map((row) => row.day);
  }
}

export function stream(env: Env) {
  return env.STREAM.getByName("default");
}
