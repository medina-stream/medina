/**
 * The transcript-search resource on the Medina Worker (migration
 * milestone 4, step 8 — docs/cloudflare-migration.md §4.3 step 8,
 * the transcript-search piece): full-text search over every
 * transcript utterance in the corpus, served by the journal's
 * SearchTranscripts RPC. Ported from lib/lifelog/TranscriptSearch.ts.
 *
 * The server's design is a pipeline-built SQLite FTS5 file,
 * published at a content-addressed key derived from the day-index
 * basis, which its RPC opens from local disk. That shape cannot
 * cross to a Worker (no disk, and a corpus-wide rebuild per basis
 * change is the "DayIndex tax" shape §5 rules out), so the Worker
 * keeps the index in a Durable Object's SQLite storage instead —
 * the same two tables, the same FTS5 configuration, the same
 * query text and ordering, so answers agree with the server's by
 * construction and the rehearsal only has to prove it.
 *
 * What the Worker adds is the incremental bookkeeping: the
 * notebook records, per capture, a content token over (day,
 * startTime, timeZone, selected transcript key, and the transcript
 * object's listing token). A pass reads the current day-index
 * snapshot (the same selection the journal serving makes), diffs
 * the tokens, and re-indexes only the captures that moved —
 * steady state is two listings and a handful of transcript reads,
 * exactly the day-index pass's shape one resource over.
 *
 * SHADOW AND LIVE differ only in who answers: the notebook build
 * is identical in both modes (it is the rehearsal), SEARCH_MODE
 * gates whether the journal serving's SearchTranscripts reads
 * this index or keeps answering that search has not moved. At the
 * flip, medina-dev's transcript-search resource stands down
 * (MEDINA_SOURCES without "transcript-search"); its own RPC read
 * keeps serving the last index it built itself — frozen at the
 * flip's basis, like every stood-down stage's fallback. Rollback
 * is the reverse.
 *
 * The server's search metadata (`search/transcript-search-v1/
 * latest.json` and the per-basis JSON beside it) is deliberately
 * NOT written from here: it points at a SQLite file on medina-dev's
 * disk, and moving the pointer without the file would break the
 * server's read outright. The notebook's report carries this
 * index's basis instead.
 *
 * Structure, as in src/dayindex.ts: the domain sits above the
 * platform layer.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ArtifactLedger,
  NotebookError,
  sha256Hex,
  type ArtifactReadError,
  type DurableObjectNamespaceLike,
} from "./capture.ts";
import {
  ArtifactCatalog,
  type CatalogBucketLike,
  type CatalogError,
} from "./catalog.ts";

// ---------------------------------------------------------------------------
// Domain: keys, shapes, and the server's exact query construction
// (ports of lib/lifelog/Resources.ts + lib/lifelog/TranscriptSearch.ts)
// ---------------------------------------------------------------------------

export const TRANSCRIPT_SEARCH_VERSION = "transcript-search-v1";
export const DAY_INDEX_PREFIX = "index/days-v1";
export const TRANSCRIPT_PREFIX = "transcript/assemblyai-u35p-v1";

export const searchIndexKey = (inputHash: string): string =>
  `search/${TRANSCRIPT_SEARCH_VERSION}/${inputHash}.json`;
export const searchLatestKey = `search/${TRANSCRIPT_SEARCH_VERSION}/latest.json`;

/** The search basis over a day-index basis — the server's formula. */
export const searchInputHash = (dayIndexInputHash: string) =>
  sha256Hex(`${TRANSCRIPT_SEARCH_VERSION}\n${dayIndexInputHash}`);

const MAX_RESULTS = 50;

export interface SearchPassage {
  readonly day: string;
  readonly captureId: string;
  readonly startTime: string;
  readonly timeZone: string;
  readonly speaker: string | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface SearchHit {
  readonly day: string;
  readonly captureId: string;
  readonly startTime: string;
  readonly timeZone: string;
  readonly speaker: string | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly excerpt: string;
}

/**
 * Turns untrusted user text into FTS terms rather than accepting
 * FTS query syntax — the server's construction, verbatim: quoted
 * phrases or word terms, each re-quoted, ANDed together. Predictable
 * AND semantics, no malformed queries.
 */
export const ftsQuery = (query: string): string =>
  query
    .match(/"[^"\r\n]+"|[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)
    ?.map((part) => {
      const term = part.startsWith('"') ? part.slice(1, -1) : part;
      return `"${term.replaceAll('"', '""')}"`;
    })
    .join(" AND ") ?? "";

/** The server's result cap rule: default 20, clamped to [1, 50]. */
export const searchLimit = (requestedLimit?: number): number =>
  Math.max(1, Math.min(Math.floor(requestedLimit ?? 20), MAX_RESULTS));

// ---------------------------------------------------------------------------
// Domain: reading the day-index snapshot and transcripts structurally
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export interface SnapshotEntry {
  readonly day: string;
  readonly captureId: string;
  readonly startTime: string;
  readonly timeZone: string;
  readonly transcriptKey: string;
}

export interface DaySnapshot {
  readonly key: string;
  readonly inputHash: string;
  readonly builtAt: string;
  readonly entries: ReadonlyArray<SnapshotEntry>;
}

/** Structural read of a day-index snapshot artifact (the DayIndex
 * schema's fields, read the way the Worker reads everything). */
export const parseDaySnapshot = (
  key: string,
  parsed: unknown,
): DaySnapshot | null => {
  if (!isRecord(parsed)) return null;
  const inputHash = optionalString(parsed["inputHash"]);
  const builtAt = optionalString(parsed["builtAt"]);
  const days = parsed["days"];
  if (inputHash === undefined || builtAt === undefined || !isRecord(days)) {
    return null;
  }
  const entries: Array<SnapshotEntry> = [];
  for (const [day, dayEntries] of Object.entries(days)) {
    if (!Array.isArray(dayEntries)) continue;
    for (const entry of dayEntries) {
      if (!isRecord(entry)) continue;
      const captureId = optionalString(entry["captureId"]);
      const transcriptKey = optionalString(entry["transcriptKey"]);
      const startTime = optionalString(entry["startTime"]);
      const timeZone = optionalString(entry["timeZone"]);
      if (
        captureId === undefined ||
        transcriptKey === undefined ||
        startTime === undefined ||
        timeZone === undefined
      ) {
        continue;
      }
      entries.push({ day, captureId, startTime, timeZone, transcriptKey });
    }
  }
  return { key, inputHash, builtAt, entries };
};

export interface TranscriptShape {
  readonly text: string | null;
  readonly utterances: ReadonlyArray<{
    readonly speaker: string | null;
    readonly startMs: number;
    readonly endMs: number;
    readonly text: string;
  }>;
}

/** Structural read of a transcript artifact's search-relevant half. */
export const parseTranscript = (parsed: unknown): TranscriptShape | null => {
  if (!isRecord(parsed)) return null;
  const rawUtterances = parsed["utterances"];
  const utterances: TranscriptShape["utterances"][number][] = [];
  if (Array.isArray(rawUtterances)) {
    for (const utterance of rawUtterances) {
      if (!isRecord(utterance)) return null;
      const text = utterance["text"];
      const startMs = utterance["startMs"];
      const endMs = utterance["endMs"];
      if (
        typeof text !== "string" ||
        typeof startMs !== "number" ||
        typeof endMs !== "number"
      ) {
        return null;
      }
      utterances.push({
        speaker:
          typeof utterance["speaker"] === "string"
            ? (utterance["speaker"] as string)
            : null,
        startMs,
        endMs,
        text,
      });
    }
  }
  return {
    text: typeof parsed["text"] === "string" ? (parsed["text"] as string) : null,
    utterances,
  };
};

/**
 * The server's document rule (documentsForIndex), per capture: one
 * passage per utterance with non-blank text; when the transcript
 * has no utterances at all, one passage carrying the whole text.
 */
export const passagesFor = (
  entry: SnapshotEntry,
  transcript: TranscriptShape,
): ReadonlyArray<SearchPassage> => {
  const base = {
    day: entry.day,
    captureId: entry.captureId,
    startTime: entry.startTime,
    timeZone: entry.timeZone,
  };
  if (transcript.utterances.length > 0) {
    return transcript.utterances
      .filter((utterance) => utterance.text.trim() !== "")
      .map((utterance) => ({
        ...base,
        speaker: utterance.speaker,
        startMs: utterance.startMs,
        endMs: utterance.endMs,
        text: utterance.text,
      }));
  }
  return transcript.text !== null && transcript.text.trim() !== ""
    ? [{ ...base, speaker: null, startMs: 0, endMs: 0, text: transcript.text }]
    : [];
};

/** A capture's index token: everything that can change its passages. */
export const captureToken = (
  entry: SnapshotEntry,
  listingToken: string,
): Promise<string> =>
  sha256Hex(
    [entry.day, entry.startTime, entry.timeZone, entry.transcriptKey, listingToken].join("\n"),
  );

// ---------------------------------------------------------------------------
// Reports and notebook rows
// ---------------------------------------------------------------------------

export interface CaptureIndexRow {
  readonly captureId: string;
  readonly token: string;
  readonly day: string;
  readonly passages: number;
}

export interface SearchUpsert {
  readonly captureId: string;
  readonly token: string;
  readonly day: string;
  readonly rows: ReadonlyArray<SearchPassage>;
}

export class SearchReport extends Schema.Class<SearchReport>("SearchReport")({
  ranAt: Schema.String,
  mode: Schema.Literals(["cron", "manual"]),
  live: Schema.Boolean,
  /** The day-index snapshot this index was built from. */
  snapshotKey: Schema.String,
  inputHash: Schema.String,
  searchInputHash: Schema.String,
  capturesExpected: Schema.Number,
  capturesIndexed: Schema.Number,
  upserts: Schema.Number,
  deletes: Schema.Number,
  passages: Schema.Number,
  errors: Schema.Array(
    Schema.Struct({ item: Schema.String, detail: Schema.String }),
  ),
}) {}

export interface SearchPassOptions {
  readonly mode: "cron" | "manual";
  readonly now: Date;
  /** True when SEARCH_MODE is live (serving reads this index). The
   * build itself is identical either way; the flag is recorded so a
   * status read shows which side of the flip the pass ran on. */
  readonly perform: boolean;
  /** Pin the build to one day-index snapshot key (rehearsal against
   * the server's exact basis). Cron and normal manual runs omit it
   * and take the current snapshot. */
  readonly snapshotKey?: string;
}

// ---------------------------------------------------------------------------
// Platform: services
// ---------------------------------------------------------------------------

export interface SearchDataShape {
  /** Snapshot candidates under index/days-v1 with upload times. */
  readonly listSnapshots: Effect.Effect<
    ReadonlyArray<{ readonly key: string; readonly uploaded: Date }>,
    CatalogError
  >;
  /** Transcript directory tokens by full key (`size:etag`). */
  readonly listTranscriptTokens: Effect.Effect<
    ReadonlyMap<string, string>,
    CatalogError
  >;
  /** Parsed JSON at a key; null when absent or undecodable. */
  readonly readJson: (
    key: string,
  ) => Effect.Effect<unknown | null, ArtifactReadError>;
}

export class SearchData extends Context.Service<SearchData, SearchDataShape>()(
  "medina-cloudflare/SearchData",
) {}

export class SearchNotebook extends Context.Service<
  SearchNotebook,
  {
    readonly record: (
      report: SearchReport,
    ) => Effect.Effect<void, NotebookError>;
    readonly latest: Effect.Effect<
      Option.Option<SearchReport>,
      NotebookError
    >;
    readonly captures: Effect.Effect<
      ReadonlyArray<CaptureIndexRow>,
      NotebookError
    >;
    readonly apply: (
      upserts: ReadonlyArray<SearchUpsert>,
      deletes: ReadonlyArray<string>,
    ) => Effect.Effect<void, NotebookError>;
    readonly query: (
      fts: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<SearchHit>, NotebookError>;
    readonly counts: Effect.Effect<
      { readonly captures: number; readonly passages: number },
      NotebookError
    >;
  }
>()("medina-cloudflare/SearchNotebook") {}

export interface SearchEnv {
  readonly artifacts: CatalogBucketLike;
  readonly notebook: DurableObjectNamespaceLike;
}

export const SEARCH_DO_NAME = "transcript-search-v1";

export const searchPlatformLayer = (
  env: SearchEnv,
): Layer.Layer<
  SearchData | SearchNotebook,
  never,
  ArtifactLedger | ArtifactCatalog
> =>
  Layer.effect(
    SearchData,
    Effect.gen(function* () {
      const ledger = yield* ArtifactLedger;
      const catalog = yield* ArtifactCatalog;
      return {
        listSnapshots: Effect.map(
          catalog.listAll(DAY_INDEX_PREFIX),
          (objects) =>
            objects
              .filter((object) => object.key.endsWith(".json"))
              .map((object) => ({ key: object.key, uploaded: object.uploaded })),
        ),
        listTranscriptTokens: Effect.map(
          catalog.listAll(TRANSCRIPT_PREFIX),
          (objects) =>
            new Map(
              objects.map((object) => [
                object.key,
                `${object.size}:${object.etag}`,
              ] as const),
            ),
        ),
        readJson: (key) =>
          Effect.map(ledger.readText(key), (text) => {
            if (Option.isNone(text)) return null;
            try {
              return JSON.parse(text.value) as unknown;
            } catch {
              return null;
            }
          }),
      };
    }),
  ).pipe(
    Layer.merge(
      Layer.succeed(SearchNotebook, {
        record: (report) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(SEARCH_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://transcript-search/report", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(report),
                }),
              );
              if (!response.ok) {
                throw new Error(
                  `notebook rejected a report: ${response.status}`,
                );
              }
            },
            catch: (cause) =>
              new NotebookError({
                message: "recording a search report failed",
                cause,
              }),
          }),
        latest: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(SEARCH_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://transcript-search/status"),
            );
            if (!response.ok) {
              throw new Error(`notebook status answered ${response.status}`);
            }
            const body = (await response.json()) as {
              lastReport?: SearchReport | null;
            };
            return body.lastReport != null
              ? Option.some(body.lastReport)
              : Option.none<SearchReport>();
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading the search notebook failed",
              cause,
            }),
        }),
        captures: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(SEARCH_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://transcript-search/captures"),
            );
            if (!response.ok) {
              throw new Error(
                `notebook captures answered ${response.status}`,
              );
            }
            const body = (await response.json()) as {
              captures?: ReadonlyArray<CaptureIndexRow>;
            };
            return body.captures ?? [];
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading search captures failed",
              cause,
            }),
        }),
        apply: (upserts, deletes) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(SEARCH_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://transcript-search/apply", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ upserts, deletes }),
                }),
              );
              if (!response.ok) {
                throw new Error(
                  `notebook apply answered ${response.status}`,
                );
              }
            },
            catch: (cause) =>
              new NotebookError({
                message: "applying search index changes failed",
                cause,
              }),
          }),
        query: (fts, limit) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(SEARCH_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://transcript-search/query", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ fts, limit }),
                }),
              );
              if (!response.ok) {
                throw new Error(`notebook query answered ${response.status}`);
              }
              const body = (await response.json()) as {
                hits?: ReadonlyArray<SearchHit>;
              };
              return body.hits ?? [];
            },
            catch: (cause) =>
              new NotebookError({
                message: "querying the search index failed",
                cause,
              }),
          }),
        counts: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(SEARCH_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://transcript-search/status"),
            );
            if (!response.ok) {
              throw new Error(`notebook status answered ${response.status}`);
            }
            const body = (await response.json()) as {
              captures?: number;
              passages?: number;
            };
            return {
              captures: body.captures ?? 0,
              passages: body.passages ?? 0,
            };
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading search counts failed",
              cause,
            }),
        }),
      }),
    ),
  );

/**
 * The serving query: the SearchTranscripts handler's whole job,
 * shared by the journal RPC and the gated parity endpoint so both
 * exercise the same code. Empty FTS (no terms in the query) is an
 * empty result, never an error — the server's behavior.
 */
export const querySearchIndex = (
  notebook: DurableObjectNamespaceLike,
  query: string,
  requestedLimit?: number,
): Effect.Effect<ReadonlyArray<SearchHit>, NotebookError> =>
  Effect.gen(function* () {
    const fts = ftsQuery(query);
    if (fts === "") return [];
    const stub = notebook.get(notebook.idFromName(SEARCH_DO_NAME));
    const response = yield* Effect.tryPromise({
      try: () =>
        stub.fetch(
          new Request("http://transcript-search/query", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fts, limit: searchLimit(requestedLimit) }),
          }),
        ),
      catch: (cause) =>
        new NotebookError({ message: "querying the search index failed", cause }),
    });
    if (!response.ok) {
      return yield* new NotebookError({
        message: `notebook query answered ${response.status}`,
        cause: null,
      });
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<{ hits?: ReadonlyArray<SearchHit> }>,
      catch: (cause) =>
        new NotebookError({ message: "reading search hits failed", cause }),
    });
    return body.hits ?? [];
  });

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

type SearchError = CatalogError | ArtifactReadError | NotebookError;

/** The current snapshot, selected the way journal serving selects
 * it: among the most recently uploaded generations, the greatest
 * builtAt. */
const currentSnapshot = (
  data: SearchDataShape,
  pinnedKey?: string,
): Effect.Effect<DaySnapshot | null, SearchError> =>
  Effect.gen(function* () {
    const listed = yield* data.listSnapshots;
    const candidates =
      pinnedKey !== undefined
        ? listed.filter((object) => object.key === pinnedKey)
        : [...listed]
            .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
            .slice(0, 3);
    let best: DaySnapshot | null = null;
    for (const candidate of candidates) {
      const parsed = parseDaySnapshot(
        candidate.key,
        yield* data.readJson(candidate.key),
      );
      if (parsed !== null && (best === null || parsed.builtAt > best.builtAt)) {
        best = parsed;
      }
    }
    return best;
  });

export const runSearchPass = (
  options: SearchPassOptions,
): Effect.Effect<
  SearchReport,
  SearchError,
  ArtifactLedger | ArtifactCatalog | SearchData | SearchNotebook
> =>
  Effect.gen(function* () {
    const data = yield* SearchData;
    const notebook = yield* SearchNotebook;
    const errors: Array<{ item: string; detail: string }> = [];

    const snapshot = yield* currentSnapshot(data, options.snapshotKey);
    if (snapshot === null) {
      const report = new SearchReport({
        ranAt: options.now.toISOString(),
        mode: options.mode,
        live: options.perform,
        snapshotKey: options.snapshotKey ?? "",
        inputHash: "",
        searchInputHash: "",
        capturesExpected: 0,
        capturesIndexed: 0,
        upserts: 0,
        deletes: 0,
        passages: 0,
        errors: [{ item: "snapshot", detail: "no readable day-index snapshot" }],
      });
      yield* notebook.record(report);
      return report;
    }

    const tokens = yield* data.listTranscriptTokens;
    const indexed = new Map(
      (yield* notebook.captures).map((row) => [row.captureId, row] as const),
    );

    // Diff: an entry whose token moved is re-indexed; an indexed
    // capture with no entry is deleted. Reads are per capture and
    // independent, with bounded concurrency like the day-index pass.
    interface Change {
      readonly entry: SnapshotEntry;
      readonly token: string;
    }
    const expected = new Map<string, SnapshotEntry>();
    for (const entry of snapshot.entries) expected.set(entry.captureId, entry);
    const changes: Array<Change> = [];
    yield* Effect.forEach(
      [...expected.values()],
      (entry) =>
        Effect.gen(function* () {
          const token = yield* Effect.promise(() =>
            captureToken(entry, tokens.get(entry.transcriptKey) ?? ""),
          );
          const current = indexed.get(entry.captureId);
          if (current === undefined || current.token !== token) {
            changes.push({ entry, token });
          }
        }),
      { concurrency: 16 },
    );
    const deletes = [...indexed.keys()].filter(
      (captureId) => !expected.has(captureId),
    );

    // Apply in flushed batches, like the day-index pass: a pass
    // that dies mid-corpus keeps the progress it already made (a
    // capture's token is only recorded with its rows, so an
    // interrupted batch is simply re-applied next pass).
    let upsertCount = 0;
    let batch: Array<SearchUpsert> = [];
    const flush = Effect.gen(function* () {
      if (batch.length === 0) return;
      const applying = batch;
      batch = [];
      yield* notebook.apply(applying, []);
      upsertCount += applying.length;
    });
    const outcomes = yield* Effect.forEach(
      changes,
      (change) =>
        Effect.gen(function* () {
          const parsed = yield* data.readJson(change.entry.transcriptKey);
          const transcript = parsed === null ? null : parseTranscript(parsed);
          if (transcript === null && parsed !== null) {
            errors.push({
              item: change.entry.captureId,
              detail: "transcript did not parse; indexed as empty",
            });
          }
          const rows =
            transcript === null ? [] : passagesFor(change.entry, transcript);
          return {
            captureId: change.entry.captureId,
            token: change.token,
            day: change.entry.day,
            rows,
          } satisfies SearchUpsert;
        }),
      { concurrency: 16 },
    );
    for (const upsert of outcomes) {
      batch.push(upsert);
      if (batch.length >= 25) yield* flush;
    }
    yield* flush;
    if (deletes.length > 0) yield* notebook.apply([], deletes);

    const counts = yield* notebook.counts;
    const report = new SearchReport({
      ranAt: options.now.toISOString(),
      mode: options.mode,
      live: options.perform,
      snapshotKey: snapshot.key,
      inputHash: snapshot.inputHash,
      searchInputHash: yield* Effect.promise(() =>
        searchInputHash(snapshot.inputHash),
      ),
      capturesExpected: expected.size,
      capturesIndexed: counts.captures,
      upserts: upsertCount,
      deletes: deletes.length,
      passages: counts.passages,
      errors,
    });
    yield* notebook.record(report);
    return report;
  });

// ---------------------------------------------------------------------------
// TranscriptSearchShadow: the resource's notebook Durable Object —
// the passage index itself (SQLite FTS5, the server's schema) plus
// the per-capture token registry and recent pass reports.
// ---------------------------------------------------------------------------

interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>;
  readonly rowsWritten: number;
}

interface SqlStorageLike {
  exec(
    query: string,
    ...bindings: Array<unknown>
  ): SqlCursorLike;
}

interface DurableObjectStateLike {
  readonly storage: { readonly sql: SqlStorageLike };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/** The server's search statement, verbatim. */
const SEARCH_SQL = `SELECT p.day, p.capture_id AS captureId, p.start_time AS startTime, p.time_zone AS timeZone, p.speaker, p.start_ms AS startMs, p.end_ms AS endMs, snippet(passages_fts, 0, '', '', '…', 18) AS excerpt FROM passages_fts JOIN passages p ON p.id = passages_fts.rowid WHERE passages_fts MATCH ? ORDER BY bm25(passages_fts), p.start_time, p.start_ms LIMIT ?`;

export class TranscriptSearchShadow {
  private readonly sql: SqlStorageLike;

  constructor(state: DurableObjectStateLike) {
    this.sql = state.storage.sql;
    void state.blockConcurrencyWhile(async () => {
      // The server's tables, name for name (publishIndex in
      // lib/lifelog/TranscriptSearch.ts).
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS passages (id INTEGER PRIMARY KEY, day TEXT NOT NULL, capture_id TEXT NOT NULL, start_time TEXT NOT NULL, time_zone TEXT NOT NULL, speaker TEXT, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL)`,
      );
      this.sql.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(text, tokenize = 'unicode61')`,
      );
      this.sql.exec(
        `CREATE INDEX IF NOT EXISTS passages_capture ON passages(capture_id)`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS captures (
           capture_id TEXT PRIMARY KEY,
           token TEXT NOT NULL,
           day TEXT NOT NULL,
           passages INTEGER NOT NULL
         )`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS reports (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ran_at TEXT NOT NULL,
           report TEXT NOT NULL
         )`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (request.method === "POST" && url.pathname === "/report") {
      const body = await request.text();
      let ranAt = new Date().toISOString();
      try {
        const parsed = JSON.parse(body) as { ranAt?: unknown };
        if (typeof parsed.ranAt === "string") ranAt = parsed.ranAt;
      } catch {
        // keep the default; the body is still stored verbatim
      }
      this.sql.exec(
        `INSERT INTO reports (ran_at, report) VALUES (?, ?)`,
        ranAt,
        body,
      );
      this.sql.exec(
        `DELETE FROM reports WHERE id NOT IN (
           SELECT id FROM reports ORDER BY id DESC LIMIT 100
         )`,
      );
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const rows = this.sql
        .exec(`SELECT report FROM reports ORDER BY id DESC LIMIT 1`)
        .toArray();
      const captureRows = this.sql
        .exec(`SELECT COUNT(*) AS n FROM captures`)
        .toArray();
      const passageRows = this.sql
        .exec(`SELECT COUNT(*) AS n FROM passages`)
        .toArray();
      const lastReport =
        rows.length > 0 && typeof rows[0]?.["report"] === "string"
          ? (JSON.parse(rows[0]["report"] as string) as unknown)
          : null;
      return json({
        runCount: Number(
          this.sql.exec(`SELECT COUNT(*) AS n FROM reports`).toArray()[0]?.["n"] ?? 0,
        ),
        captures: Number(captureRows[0]?.["n"] ?? 0),
        passages: Number(passageRows[0]?.["n"] ?? 0),
        lastReport,
      });
    }
    if (request.method === "GET" && url.pathname === "/captures") {
      const rows = this.sql
        .exec(`SELECT capture_id, token, day, passages FROM captures`)
        .toArray();
      const captures = rows.map((row) => ({
        captureId: String(row["capture_id"]),
        token: String(row["token"]),
        day: String(row["day"]),
        passages: Number(row["passages"] ?? 0),
      }));
      return json({ captures });
    }
    if (request.method === "POST" && url.pathname === "/apply") {
      const body = (await request.json().catch(() => ({}))) as {
        upserts?: ReadonlyArray<SearchUpsert>;
        deletes?: ReadonlyArray<string>;
      };
      // Per capture: rows first, token last — a crash mid-capture
      // leaves the old token in place, so the next pass re-applies
      // the capture rather than trusting a half-written index.
      for (const upsert of body.upserts ?? []) {
        const oldIds = this.sql
          .exec(`SELECT id FROM passages WHERE capture_id = ?`, upsert.captureId)
          .toArray()
          .map((row) => Number(row["id"]));
        for (const id of oldIds) {
          this.sql.exec(`DELETE FROM passages_fts WHERE rowid = ?`, id);
          this.sql.exec(`DELETE FROM passages WHERE id = ?`, id);
        }
        for (const row of upsert.rows) {
          const inserted = this.sql
            .exec(
              `INSERT INTO passages (day, capture_id, start_time, time_zone, speaker, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
              row.day,
              row.captureId,
              row.startTime,
              row.timeZone,
              row.speaker,
              row.startMs,
              row.endMs,
            )
            .toArray();
          this.sql.exec(
            `INSERT INTO passages_fts (rowid, text) VALUES (?, ?)`,
            Number(inserted[0]?.["id"]),
            row.text,
          );
        }
        this.sql.exec(
          `INSERT INTO captures (capture_id, token, day, passages)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(capture_id) DO UPDATE SET
               token = excluded.token,
               day = excluded.day,
               passages = excluded.passages`,
          upsert.captureId,
          upsert.token,
          upsert.day,
          upsert.rows.length,
        );
      }
      for (const captureId of body.deletes ?? []) {
        const oldIds = this.sql
          .exec(`SELECT id FROM passages WHERE capture_id = ?`, captureId)
          .toArray()
          .map((row) => Number(row["id"]));
        for (const id of oldIds) {
          this.sql.exec(`DELETE FROM passages_fts WHERE rowid = ?`, id);
          this.sql.exec(`DELETE FROM passages WHERE id = ?`, id);
        }
        this.sql.exec(`DELETE FROM captures WHERE capture_id = ?`, captureId);
      }
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/query") {
      const body = (await request.json().catch(() => ({}))) as {
        fts?: unknown;
        limit?: unknown;
      };
      if (typeof body.fts !== "string" || body.fts === "") {
        return json({ hits: [] });
      }
      const limit =
        typeof body.limit === "number" && Number.isFinite(body.limit)
          ? Math.max(1, Math.min(Math.floor(body.limit), MAX_RESULTS))
          : 20;
      try {
        const rows = this.sql.exec(SEARCH_SQL, body.fts, limit).toArray();
        const hits = rows.map((row) => ({
          day: String(row["day"]),
          captureId: String(row["captureId"]),
          startTime: String(row["startTime"]),
          timeZone: String(row["timeZone"]),
          speaker:
            typeof row["speaker"] === "string" ? (row["speaker"] as string) : null,
          startMs: Number(row["startMs"]),
          endMs: Number(row["endMs"]),
          excerpt: String(row["excerpt"]),
        }));
        return json({ hits });
      } catch (cause) {
        return json({ error: String(cause).slice(0, 300) }, 500);
      }
    }
    return json({ error: "not found" }, 404);
  }
}
