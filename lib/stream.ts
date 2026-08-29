import { DurableObject } from "cloudflare:workers";

export type JournalInput = { ingestId: string; transcriptKey: string; capturedAt: string };
export type JournalReport = { day: string; journalKey: string; generatedAt: string };

/**
 * Person-scoped SQLite catalog: pointers into R2 and nothing else. Every row is
 * rebuildable from the artifacts, so the schema can be dropped and re-derived.
 */
export class Stream extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      DROP TABLE IF EXISTS journal_transcripts; -- superseded by journal_inputs
      CREATE TABLE IF NOT EXISTS journal_inputs (
        day TEXT NOT NULL,
        ingest_id TEXT PRIMARY KEY,
        transcript_key TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_inputs_by_day ON journal_inputs(day, captured_at, ingest_id);
      CREATE TABLE IF NOT EXISTS journal_reports (
        day TEXT PRIMARY KEY,
        journal_key TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
    `);
  }

  /** Indexes one transcript under the day it was recorded. */
  async recordJournalInput(day: string, input: JournalInput) {
    this.ctx.storage.sql.exec(
      `INSERT INTO journal_inputs (day, ingest_id, transcript_key, captured_at, indexed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ingest_id) DO UPDATE SET day = excluded.day, transcript_key = excluded.transcript_key, captured_at = excluded.captured_at`,
      day, input.ingestId, input.transcriptKey, input.capturedAt, new Date().toISOString(),
    );
  }

  async journalInputs(day: string): Promise<JournalInput[]> {
    return this.ctx.storage.sql.exec<JournalInput>(
      "SELECT ingest_id AS ingestId, transcript_key AS transcriptKey, captured_at AS capturedAt FROM journal_inputs WHERE day = ? ORDER BY captured_at, ingest_id", day,
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

  /** Days whose transcripts have no current report: never journaled, journaled before newer input arrived, or journaled by an older Journal version. */
  async journalDaysNeedingReport(throughDay: string, keyPrefix: string): Promise<string[]> {
    return this.ctx.storage.sql.exec<{ day: string }>(
      `SELECT inputs.day FROM journal_inputs AS inputs
       LEFT JOIN journal_reports AS reports ON reports.day = inputs.day
       WHERE inputs.day <= ? GROUP BY inputs.day
       HAVING reports.day IS NULL OR MAX(inputs.indexed_at) > reports.generated_at OR reports.journal_key NOT LIKE ? || '%'
       ORDER BY inputs.day DESC LIMIT 31`, throughDay, keyPrefix,
    ).toArray().map((row) => row.day);
  }

  /** Unpublishes reports for days that no longer have any transcript input. */
  async pruneJournalReports() {
    this.ctx.storage.sql.exec("DELETE FROM journal_reports WHERE day NOT IN (SELECT day FROM journal_inputs)");
  }
}

export function stream(env: Env) {
  return env.STREAM.getByName("default");
}
