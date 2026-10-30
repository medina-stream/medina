/**
 * Journal serving on the Medina Worker (migration milestone 4, step 1 —
 * docs/cloudflare-migration.md §4.3). Reads only: every byte comes from
 * the canonical artifact bucket (sco-lifelog, bound as ARTIFACTS);
 * medina-dev keeps producing everything this serves.
 *
 * What is served, mirroring the bun server's read surface:
 *
 *   GET  /               the SPA shell (markup ported from
 *                        lib/lifelog/Pages.tsx `spaHome`)
 *   GET  /app.js         the client bundle, published to the bucket by
 *   GET  /inter.woff2    scripts/publish-client-assets.ts under
 *   GET  /icons/<file>   `client/` keys, streamed back out
 *   GET  /journal/:day   the day page (HTML) or the journal record
 *                        (JSON), selected the way Views.currentJournals
 *                        selects from disk: newest by generatedAt
 *   GET  /status         pipeline status composed from the loops' run
 *                        reports, the journal listing, and the day
 *                        index — the HTTP twin of the GetStatus RPC
 *   POST /rpc            the read RPCs the SPA needs (ListDays,
 *                        ListJournals, GetJournal, GetDayTranscripts,
 *                        GetStatus, ListPlaces) over the repo's own
 *                        JournalsGroup schemas; the rest answer a
 *                        typed ApiError until their stage moves
 *
 * The corpus is never re-derived here. The days list is the server's
 * own persisted snapshot (views/days-v6.json — the exact payload its
 * ListDays serves); transcripts for a day come from the newest
 * day-index snapshot artifact plus that day's transcript artifacts.
 * Nothing recomputes the DayIndex basis, so the >110 s read tax the
 * server pays on a cold mount does not exist on this side. An
 * in-isolate read model with a 60 s TTL absorbs repeat reads (the
 * server's own previews run a 10-minute stale-while-revalidate, so a
 * minute of lag is well inside the system's existing freshness
 * contract).
 *
 * Gate: Cloudflare Access cannot apply to workers.dev URLs (plan
 * addendum), and the journal is private, so until the custom domain
 * exists every route here sits behind the per-device capability
 * token — the same registry the capture-policy route verifies. A
 * token presented once as ?token= is exchanged for an HttpOnly
 * cookie so the stock SPA, which knows nothing of tokens, works
 * unchanged. Fail-closed: no token, no journal (404, like the other
 * gated routes).
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import {
  ApiError,
  DayRow,
  DayTranscript,
  JournalEntry,
  JournalsGroup,
  LastRun,
  ListDays,
  PipelineStatus,
  PipelineTiming,
  ResourceStatus,
  SourceStatus,
  StageStatus,
  StatusTotals,
  TranscriptTurn,
} from "../../lib/lifelog/JournalApi.ts";
import {
  DayIndex,
  Journal,
  Transcript,
} from "../../lib/lifelog/Resources.ts";
import { Place, Places } from "../../lib/lifelog/Places.ts";

// ---------------------------------------------------------------------------
// Bucket access (structural slices of the R2 binding, as in worker.ts)
// ---------------------------------------------------------------------------

export interface JournalBucketObject {
  readonly body: ReadableStream;
  readonly size: number;
  readonly httpEtag: string;
}

export interface JournalBucket {
  get(key: string): Promise<JournalBucketObject | null>;
  list(options: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{
    readonly objects: ReadonlyArray<{
      readonly key: string;
      readonly size: number;
      readonly etag: string;
      readonly uploaded: Date;
    }>;
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

const getText = (
  bucket: JournalBucket,
  key: string,
): Effect.Effect<string | null> =>
  Effect.promise(async () => {
    const object = await bucket.get(key);
    if (object === null) return null;
    return new Response(object.body).text();
  });

const getJson = (
  bucket: JournalBucket,
  key: string,
): Effect.Effect<unknown> =>
  Effect.flatMap(getText(bucket, key), (text) =>
    text === null
      ? Effect.succeed(null)
      : Effect.try(() => JSON.parse(text) as unknown).pipe(
          // A corrupt artifact reads as absent; the caller's decode
          // layer decides what absence means for its route.
          Effect.catch(() => Effect.succeed(null)),
        ),
  );

interface ListedObject {
  readonly key: string;
  readonly size: number;
  readonly uploaded: Date;
}

const LIST_MAX_PAGES = 60;

const listAll = (
  bucket: JournalBucket,
  prefix: string,
): Effect.Effect<ReadonlyArray<ListedObject>> =>
  Effect.promise(async () => {
    const all: Array<ListedObject> = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const result = await bucket.list({
        prefix,
        limit: 1000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const object of result.objects) {
        all.push({
          key: object.key,
          size: object.size,
          uploaded: object.uploaded,
        });
      }
      if (!result.truncated || result.cursor === undefined) break;
      cursor = result.cursor;
    }
    return all;
  });

// ---------------------------------------------------------------------------
// The read model: everything a journal request can need, rebuilt at
// most once a minute per isolate.
// ---------------------------------------------------------------------------

const JOURNAL_PREFIX = "journal/journal-v12";
const DAY_INDEX_PREFIX = "index/days-v1";
const PREVIEWS_KEY = "views/days-v6.json";
const READ_MODEL_TTL_MS = 60_000;

/**
 * A loop's last run report, decoded with the RPC's own LastRun schema
 * — the server's RunReport (lib/Pipeline.ts) and the RPC shape were
 * defined field-for-field alike, so the persisted report artifact
 * decodes straight into it.
 */
type RunReportShape = LastRun;

interface ReadModel {
  readonly builtAt: number;
  /** Day rows exactly as the server's ListDays serves them. */
  readonly rows: ReadonlyArray<DayRow>;
  /** Newest journal per day, by generatedAt. */
  readonly journals: ReadonlyMap<string, Journal>;
  /** The current day-index snapshot, when one exists. */
  readonly index: DayIndex | null;
  /** Last run report per loop name (ingest / capture / inventory). */
  readonly reports: ReadonlyMap<string, RunReportShape>;
}

const decodeOrNull = <S extends Schema.Constraint>(
  schema: S,
  json: unknown,
): Effect.Effect<S["Type"] | null, never, S["DecodingServices"]> =>
  json === null
    ? Effect.succeed(null)
    : Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );

/**
 * Newest journal per day. Generation files are content-addressed and
 * written once, so the most recently *uploaded* candidate in a day's
 * listing is the newest generation in all but the re-upload edge
 * cases; only that one is fetched and decoded.
 */
const loadJournals = (
  bucket: JournalBucket,
): Effect.Effect<ReadonlyMap<string, Journal>> =>
  Effect.gen(function* () {
    const listed = yield* listAll(bucket, `${JOURNAL_PREFIX}/`);
    const newestKeyByDay = new Map<string, ListedObject>();
    for (const object of listed) {
      const rest = object.key.slice(JOURNAL_PREFIX.length + 1);
      const [day, file] = rest.split("/");
      if (!day || !file || !file.endsWith(".json")) continue;
      const current = newestKeyByDay.get(day);
      if (
        current === undefined ||
        object.uploaded.getTime() > current.uploaded.getTime()
      ) {
        newestKeyByDay.set(day, object);
      }
    }
    const journals = new Map<string, Journal>();
    yield* Effect.forEach(
      [...newestKeyByDay.values()],
      (object) =>
        Effect.flatMap(getJson(bucket, object.key), (json) =>
          Effect.map(decodeOrNull(Journal, json), (journal) => {
            if (journal !== null) journals.set(journal.day, journal);
          }),
        ),
      { concurrency: 8 },
    );
    return journals;
  });

/**
 * The current day-index snapshot: among the most recently uploaded
 * generations, the one with the greatest builtAt. (Listing order is
 * by key, and keys are content hashes — recency only exists in the
 * upload timestamps and inside the files.)
 */
const loadDayIndex = (
  bucket: JournalBucket,
): Effect.Effect<DayIndex | null> =>
  Effect.gen(function* () {
    const listed = yield* listAll(bucket, `${DAY_INDEX_PREFIX}/`);
    const candidates = listed
      .filter((object) => object.key.endsWith(".json"))
      .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
      .slice(0, 3);
    let best: DayIndex | null = null;
    for (const candidate of candidates) {
      const index = yield* Effect.flatMap(
        getJson(bucket, candidate.key),
        (json) => decodeOrNull(DayIndex, json),
      );
      if (index !== null && (best === null || index.builtAt > best.builtAt)) {
        best = index;
      }
    }
    return best;
  });

const loadReport = (
  bucket: JournalBucket,
  key: string,
): Effect.Effect<RunReportShape | null> =>
  Effect.flatMap(getJson(bucket, key), (json) =>
    decodeOrNull(LastRun, json),
  );

const buildReadModel = (bucket: JournalBucket): Effect.Effect<ReadModel> =>
  Effect.gen(function* () {
    const rowsJson = yield* getJson(bucket, PREVIEWS_KEY);
    const rows = yield* Schema.decodeUnknownEffect(ListDays.successSchema)(
      rowsJson ?? [],
    ).pipe(
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<DayRow>)),
    );
    const journals = yield* loadJournals(bucket);
    const index = yield* loadDayIndex(bucket);
    const reports = new Map<string, RunReportShape>();
    for (const [name, key] of [
      ["ingest", "runs/latest.json"],
      ["capture", "runs/capture/latest.json"],
      ["inventory", "runs/inventory/latest.json"],
    ] as const) {
      const report = yield* loadReport(bucket, key);
      if (report !== null) reports.set(name, report);
    }
    return { builtAt: Date.now(), rows, journals, index, reports };
  });

let readModelCache: Promise<ReadModel> | null = null;
let readModelBuiltAt = 0;

const readModel = (bucket: JournalBucket): Effect.Effect<ReadModel> =>
  Effect.promise(() => {
    if (
      readModelCache === null ||
      Date.now() - readModelBuiltAt > READ_MODEL_TTL_MS
    ) {
      readModelBuiltAt = Date.now();
      readModelCache = Effect.runPromise(buildReadModel(bucket)).catch(
        (cause) => {
          // A failed rebuild must not poison the isolate: drop the
          // cache so the next request retries, and propagate.
          readModelCache = null;
          throw cause;
        },
      );
    }
    return readModelCache;
  });

/** Per-day transcript reads, cached with the same TTL discipline. */
const transcriptCache = new Map<
  string,
  { readonly at: number; readonly value: ReadonlyArray<DayTranscript> }
>();

const dayTranscripts = (
  bucket: JournalBucket,
  day: string,
): Effect.Effect<ReadonlyArray<DayTranscript>> =>
  Effect.gen(function* () {
    const cached = transcriptCache.get(day);
    if (cached && Date.now() - cached.at <= READ_MODEL_TTL_MS) {
      return cached.value;
    }
    const model = yield* readModel(bucket);
    const entries = model.index?.days[day] ?? [];
    const transcripts = yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.flatMap(getJson(bucket, entry.transcriptKey), (json) =>
          Effect.map(decodeOrNull(Transcript, json), (transcript) => ({
            entry,
            transcript,
          })),
        ),
      { concurrency: 8 },
    );
    // Same shaping as DayIndex.dayTranscriptDetail on the server.
    const value = transcripts.flatMap(({ entry, transcript }) => {
      if (transcript === null) return [];
      return [
        new DayTranscript({
          captureId: entry.captureId,
          startTime: entry.startTime,
          timeZone: entry.timeZone,
          turns:
            transcript.utterances.length > 0
              ? transcript.utterances.map(
                  (utterance) =>
                    new TranscriptTurn({
                      speaker: utterance.speaker,
                      startMs: utterance.startMs,
                      endMs: utterance.endMs,
                      text: utterance.text,
                    }),
                )
              : transcript.text?.trim()
                ? [
                    new TranscriptTurn({
                      speaker: null,
                      startMs: 0,
                      endMs: 0,
                      text: transcript.text,
                    }),
                  ]
                : [],
        }),
      ];
    });
    transcriptCache.set(day, { at: Date.now(), value });
    return value;
  });

// ---------------------------------------------------------------------------
// Status composition (shared by GET /status and the GetStatus RPC)
// ---------------------------------------------------------------------------

const statusTotals = (model: ReadModel): StatusTotals => {
  const transcriptCount =
    model.index === null
      ? 0
      : Object.values(model.index.days).reduce(
          (sum, entries) => sum + entries.length,
          0,
        );
  if (model.rows.length > 0) {
    return new StatusTotals({
      days: model.rows.length,
      transcripts: transcriptCount,
      current: model.rows.filter((row) => !row.stale).length,
      stale: model.rows.filter((row) => row.stale).length,
    });
  }
  // No previews snapshot (should not happen — the server maintains
  // one): fall back to the journal listing, staleness unknown.
  return new StatusTotals({
    days: model.journals.size,
    transcripts: transcriptCount,
    current: model.journals.size,
    stale: 0,
  });
};

const rpcStatus = (model: ReadModel): PipelineStatus => {
  const ingest = model.reports.get("ingest") ?? null;
  return new PipelineStatus({
    pipeline: new PipelineTiming({
      // Process-local on the server (its in-memory loop runtime); the
      // Worker has no loop of its own yet, so these are honestly
      // empty — the loops' last reports below carry the real times.
      running: false,
      currentStartedAt: null,
      lastStartedAt: ingest?.startedAt ?? null,
      lastFinishedAt: ingest?.finishedAt ?? null,
      nextRunAt: null,
    }),
    lastRun: ingest,
    totals: statusTotals(model),
  });
};

const httpStatus = (model: ReadModel): Record<string, unknown> => {
  const timing = (name: string) => {
    const report = model.reports.get(name) ?? null;
    return {
      running: false,
      currentStartedAt: null,
      lastStartedAt: report?.startedAt ?? null,
      lastFinishedAt: report?.finishedAt ?? null,
      nextRunAt: null,
      lastRun: report,
    };
  };
  const staleByDay = new Map(model.rows.map((row) => [row.day, row.stale]));
  const days = [...model.journals.keys()]
    .sort()
    .reverse()
    .map((day) => ({
      day,
      transcripts: model.index?.days[day]?.length ?? 0,
      journal: staleByDay.has(day)
        ? staleByDay.get(day)
          ? "stale"
          : "current"
        : "current",
    }));
  const totals = statusTotals(model);
  return {
    service: { startedAt: null, status: "ready", runtime: "cloudflare-worker" },
    pipeline: {
      running: false,
      currentStartedAt: null,
      lastStartedAt: model.reports.get("ingest")?.startedAt ?? null,
      lastFinishedAt: model.reports.get("ingest")?.finishedAt ?? null,
      nextRunAt: null,
    },
    loops: {
      ingest: timing("ingest"),
      capture: timing("capture"),
      inventory: timing("inventory"),
    },
    lastRun: model.reports.get("ingest") ?? null,
    days,
    totals: {
      days: totals.days,
      transcripts: totals.transcripts,
      current: totals.current,
      stale: totals.stale,
    },
  };
};


// ---------------------------------------------------------------------------
// Rendering: a faithful string port of lib/lifelog/Pages.tsx (the SPA
// shell and the day page) and lib/Html.ts's escaping. The server's JSX
// runtime writes attribute names as given, so `className` attributes
// below are the server's own output, kept as-is for parity.
// ---------------------------------------------------------------------------

const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const STYLE = `:root {
      color-scheme: light dark;
      --bg: #f7f5f0; --fg: #1d2733; --muted: #68707c; --card: #fffdf8;
      --line: #e6e0d2; --accent: #b4551f; --accent-fg: #fff7ec;
      --input: #fffdf8;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #14181d; --fg: #e8e4da; --muted: #9aa3ad; --card: #1d232a;
        --line: #333a42; --accent: #e08a4c; --accent-fg: #1d130a;
        --input: #232a32;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--fg);
      font: 16px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text",
        "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    main { max-width: 44rem; margin: 0 auto; padding: 1rem 1.25rem 4rem; }
    a { color: var(--accent); }
    .site-header {
      display: flex; align-items: baseline; gap: 1rem;
      max-width: 44rem; margin: 0 auto; padding: 1.25rem 1.25rem 0;
    }
    .site-header h1 { font-size: 1.35rem; margin: 0; letter-spacing: -.01em; }
    .site-header nav { display: flex; gap: 1rem; margin-left: auto; align-items: baseline; }
    .site-header nav a { font-weight: 600; text-decoration: none; }
    .site-header nav a:hover { text-decoration: underline; }
    .icon-button {
      display: inline-flex; align-items: center; justify-content: center;
      width: 2rem; height: 2rem; padding: 0; border-radius: 999px;
      color: var(--muted); background: none; border: 0; cursor: pointer;
    }
    .icon-button:hover { color: var(--fg); background: var(--line); }
    .icon-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .icon-button svg { display: block; }
    .day article, article.day {
      background: var(--card); border: 1px solid var(--line);
      border-radius: 14px; padding: 1.1rem 1.25rem; margin: 0 0 1rem;
    }
    .day h2 { font-size: 1.12rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
    .day h2 a { color: inherit; text-decoration: none; }
    .day h2 a:hover { color: var(--accent); }
    .day .meta { color: var(--muted); font-size: .82rem; margin: 0 0 .6rem; }
    .md h3 { font-size: 1rem; margin: 1.1rem 0 .3rem; }
    .md h3:first-child { margin-top: 0; }
    .md p { margin: .45rem 0; }
    .empty { color: var(--muted); text-align: center; margin-top: 3rem; }
    .load-more { text-align: center; margin: 1.5rem 0 0; }
    .card {
      background: var(--card); border: 1px solid var(--line);
      border-radius: 14px; padding: 1.1rem 1.25rem; margin: 0 0 1rem;
    }
    .card h2 { font-size: 1.05rem; margin: 0 0 .6rem; }
    form.stack { display: grid; gap: .7rem; }
    label { display: grid; gap: .25rem; font-weight: 600; font-size: .9rem; }
    input, select {
      font: inherit; font-weight: 400; padding: .45rem .6rem;
      border: 1px solid var(--line); border-radius: 8px;
      background: var(--input); color: var(--fg); width: 100%;
    }
    button {
      font: inherit; font-weight: 600; padding: .5rem 1rem; border: 0;
      border-radius: 999px; background: var(--accent); color: var(--accent-fg);
      cursor: pointer;
    }
    button.secondary {
      background: none; color: var(--accent);
      border: 1px solid var(--line);
    }
    .form-error { color: #b3261e; font-size: .9rem; margin: 0; }
    .form-ok { color: #256029; font-size: .9rem; margin: 0; }
    dialog {
      border: 1px solid var(--line); border-radius: 14px; padding: 0;
      background: var(--card); color: var(--fg);
      width: min(26rem, calc(100vw - 2rem));
    }
    dialog::backdrop { background: rgba(20, 16, 8, .45); }
    .dialog-body { padding: 1.25rem; display: grid; gap: .9rem; }
    .dialog-body h2 { margin: 0; font-size: 1.15rem; }
    .dialog-body p { margin: 0; }
    .dialog-actions { display: flex; gap: .6rem; justify-content: flex-end; }
    .account-line { display: flex; align-items: center; gap: .5rem; }
    .status-dot { width: .55rem; height: .55rem; border-radius: 999px; background: var(--muted); flex: none; }
    .status-dot.on { background: #2e9e4f; }
    .passkey-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
    .passkey-list li {
      display: flex; align-items: center; gap: .6rem;
      border: 1px solid var(--line); border-radius: 10px; padding: .5rem .7rem;
    }
    .passkey-list .pk-name { font-weight: 600; overflow-wrap: anywhere; }
    .passkey-list .pk-meta { color: var(--muted); font-size: .8rem; margin-left: auto; text-align: right; flex: none; }
    .delegations { display: grid; gap: .9rem; }
    .delegation { border-top: 1px solid var(--line); padding-top: .9rem; display: grid; gap: .45rem; }
    .delegation:first-child { border-top: 0; padding-top: 0; }
    .delegation h3 { margin: 0; font-size: .98rem; }
    .delegation p { margin: 0; font-size: .9rem; }
    .delegation .muted, .muted { color: var(--muted); }
    .delegation code {
      font-size: .78rem; background: var(--bg); border: 1px solid var(--line);
      border-radius: 6px; padding: .1rem .35rem; overflow-wrap: anywhere;
    }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .token-line { display: flex; gap: .5rem; }
    .token-line code {
      flex: 1; overflow-x: auto; white-space: nowrap; align-self: center;
      font-size: .8rem; background: var(--bg); border: 1px solid var(--line);
      border-radius: 8px; padding: .45rem .6rem;
    }
    .events-wrap { width: min(58rem, calc(100vw - 2rem)); }
    .events-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .6rem; max-height: 65vh; overflow: auto; }
    .events-list li { border: 1px solid var(--line); border-radius: 10px; padding: .6rem .75rem; display: grid; gap: .3rem; }
    .event-head { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; }
    .event-kind { font-weight: 700; font-size: .82rem; }
    .event-time, .event-day { color: var(--muted); font-size: .8rem; }
    .event-summary { font-size: .9rem; overflow-wrap: anywhere; }
    .event-raw-toggle { justify-self: start; padding: 0; background: none; color: var(--accent); font-size: .82rem; }
    .event-raw {
      margin: 0; font-size: .72rem; line-height: 1.45; white-space: pre-wrap;
      overflow-wrap: anywhere; background: var(--bg); border: 1px solid var(--line);
      border-radius: 8px; padding: .55rem .65rem; max-height: 18rem; overflow: auto;
    }
    #timeline { margin: 0 0 1rem; }
    .tl-card {
      background: var(--card); border: 1px solid var(--line);
      border-radius: 14px; padding: 1rem 1.25rem;
    }
    .tl-head { display: flex; align-items: baseline; gap: .75rem; margin-bottom: .6rem; }
    .tl-title { font-weight: 700; font-size: .95rem; letter-spacing: -.01em; }
    .tl-coverage { color: var(--muted); font-size: .82rem; margin-left: auto; }
    .tl-track {
      position: relative; height: 3rem; border-radius: 8px;
      background: var(--line); overflow: hidden;
    }
    .tl-seg { position: absolute; top: 0; bottom: 0; background: var(--accent); opacity: .8; }
    .tl-hours { position: relative; height: 1.1rem; margin-top: .25rem; color: var(--muted); font-size: .7rem; }
    .tl-hours span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
    .tl-note { color: var(--muted); font-size: .82rem; margin: .6rem 0 0; }
    .transcripts { margin-top: 1.25rem; }
    .transcripts > summary {
      cursor: pointer; font-weight: 600; font-size: .95rem;
      padding: .4rem 0; color: var(--fg);
    }
    .transcripts > summary:hover { color: var(--accent); }
    .turn {
      display: flex; gap: .6rem; margin: .3rem 0; font-size: .9rem;
      line-height: 1.5; align-items: baseline;
    }
    .turn .t {
      color: var(--muted); font-size: .75rem; font-variant-numeric: tabular-nums;
      flex: none; width: 4.2rem; text-align: right;
    }
    .turn .who { font-weight: 700; flex: none; min-width: 1.1rem; }
    .turn .what { overflow-wrap: anywhere; }`;

interface IconSet {
  readonly manifest?: string;
  readonly svg?: string;
  readonly ico?: string;
  readonly apple?: string;
}

let iconSetCache: Promise<IconSet> | null = null;

const iconSet = (bucket: JournalBucket): Effect.Effect<IconSet> =>
  Effect.promise(() => {
    if (iconSetCache === null) {
      iconSetCache = (async () => {
        const listed = await Effect.runPromise(listAll(bucket, "client/icons/"));
        const set: {
          manifest?: string;
          svg?: string;
          ico?: string;
          apple?: string;
        } = {};
        for (const object of listed) {
          const name = object.key.slice("client/icons/".length);
          if (name.startsWith("manifest.")) set.manifest = name;
          else if (name.startsWith("favicon.") && name.endsWith(".svg")) set.svg = name;
          else if (name.startsWith("favicon.") && name.endsWith(".ico")) set.ico = name;
          else if (name.startsWith("apple-touch-icon.")) set.apple = name;
        }
        return set;
      })().catch(() => ({}));
    }
    return iconSetCache;
  });

const layout = (
  icons: IconSet,
  title: string,
  body: string,
  scriptSrc?: string,
): string =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<meta name="theme-color" content="#0f172a">` +
  `<title>${esc(title)}</title>` +
  (icons.manifest
    ? `<link rel="manifest" href="/icons/${esc(icons.manifest)}">`
    : "") +
  (icons.svg
    ? `<link rel="icon" type="image/svg+xml" href="/icons/${esc(icons.svg)}">`
    : "") +
  (icons.ico ? `<link rel="icon" href="/icons/${esc(icons.ico)}">` : "") +
  (icons.apple
    ? `<link rel="apple-touch-icon" href="/icons/${esc(icons.apple)}">`
    : "") +
  `<style>${STYLE}</style>\n</head>\n<body>${body}` +
  (scriptSrc ? `<script type="module" src="${esc(scriptSrc)}"></script>` : "") +
  `</body>\n</html>\n`;

/** The SPA shell, ported from Pages.tsx `spaHome`. The client script
 * hydrates everything; the server-rendered content is the frame. */
const spaHome = (icons: IconSet): string =>
  layout(
    icons,
    "Medina",
    `<header class="site-header"><h1>Medina</h1><nav>` +
      `<button class="icon-button" id="events-button" type="button" aria-haspopup="dialog" title="Recent events" hidden>` +
      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
      `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path>` +
      `<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path></svg>` +
      `<span class="sr">Recent events</span></button>` +
      `<button id="account-button" type="button">Sign in</button>` +
      `</nav></header>` +
      `<main id="app" aria-live="polite"></main>` +
      `<dialog id="account-dialog" aria-labelledby="account-title"><div class="dialog-body">` +
      `<h2 id="account-title">Account</h2>` +
      `<p class="account-line"><span className="status-dot" id="account-dot"></span><span id="account-status">Checking sign-in…</span></p>` +
      `<div id="sign-in-panel"><p class="muted">Sign in with the passkey on this device. Your journal stays on this server — sign-in only proves the browser is yours.</p>` +
      `<div class="dialog-actions"><button class="secondary" id="sign-in-close" type="button">Close</button><button id="sign-in-start" type="button">Sign in with passkey</button></div></div>` +
      `<div id="signed-in-panel" hidden><div id="passkeys-panel"><h3 class="sr">Passkeys</h3><ul class="passkey-list" id="passkey-list"></ul>` +
      `<p class="form-error" id="passkey-error" hidden></p>` +
      `<div class="dialog-actions"><button class="secondary" id="add-passkey" type="button">Add a passkey</button></div></div>` +
      `<div id="delegations-panel"><h3>Delegated agents</h3><p class="muted">Agents you have authorized to act for you. Revoking takes effect immediately.</p>` +
      `<div class="delegations" id="delegation-list"></div>` +
      `<p class="form-error" id="delegation-error" hidden></p>` +
      `<form class="stack" id="mint-form"><label>Label<input id="mint-label" maxlength="120" placeholder="Mark — laptop" autocomplete="off"></label>` +
      `<label>Access<select id="mint-preset"><option value="read">Read the journal</option><option value="read-write">Read and write</option><option value="admin">Administer this server</option></select></label>` +
      `<label>Expires<select id="mint-expiry"><option value="7776000">90 days</option><option value="2592000">30 days</option><option value="31536000">1 year</option><option value="never">Never</option></select></label>` +
      `<div id="mint-result" hidden><p>Give this token to the agent. It is shown once — the server keeps only a hash.</p>` +
      `<div class="token-line"><code id="mint-token"></code><button class="secondary" id="mint-copy" type="button">Copy</button></div></div>` +
      `<div class="dialog-actions"><button class="secondary" id="delegate-close" type="button">Close</button><button id="mint-submit" type="submit">Mint token</button></div></form></div>` +
      `<div class="dialog-actions"><button class="secondary" id="account-close" type="button">Close</button><button class="secondary" id="sign-out" type="button">Sign out</button></div></div>` +
      `</div></dialog>` +
      `<dialog id="events-dialog" aria-labelledby="events-title"><div class="dialog-body events-wrap">` +
      `<h2 id="events-title">Recent events</h2>` +
      `<p class="muted" id="events-status">Listening for events…</p>` +
      `<ul class="events-list" id="events-list"></ul>` +
      `<div class="dialog-actions"><button class="secondary" id="events-close" type="button">Close</button></div>` +
      `</div></dialog>`,
    "/app.js",
  );

const parseDayId = (value: string): string | null => {
  const dashed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
  const compact = /^0?(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return null;
};

const dayIdLabel = (day: string): string => {
  const parsed = parseDayId(day);
  if (parsed === null) return day;
  const [year, month, date] = parsed.split("-");
  return `0${year}${month}${date}`;
};

const renderReport = (text: string): string =>
  text
    .split(/\n\s*\n/)
    .filter((block) => block.trim())
    .map((block) => {
      // Pages.tsx renders every line followed by <br>, last included.
      const linesHtml = (lines: ReadonlyArray<string>): string =>
        lines.map((line) => `${esc(line)}<br>`).join("");
      const [first = "", ...lines] = block.split("\n");
      if (first && first.startsWith("## ")) {
        return (
          `<h3>${esc(first.replace(/^##\s+/, ""))}</h3>` +
          (lines.length > 0 ? `<p>${linesHtml(lines)}</p>` : "")
        );
      }
      return `<p>${linesHtml(block.split("\n"))}</p>`;
    })
    .join("");

const dayPage = (icons: IconSet, journal: Journal): string =>
  layout(
    icons,
    `Medina — ${dayIdLabel(journal.day)}`,
    `<header><h1>${esc(dayIdLabel(journal.day))}</h1><p><a href="/">All days</a></p></header>` +
      `<main><article class="day" data-day="${esc(journal.day)}"><div class="day-body md">${renderReport(journal.report)}</div></article></main>`,
  );

const pendingPage = (icons: IconSet, day: string): string =>
  layout(
    icons,
    `Medina — ${day}`,
    `<header><h1>${esc(day)}</h1><p><a href="/">All days</a></p></header>` +
      `<main><p class="empty">This day's journal is still being written. Check back shortly.</p></main>`,
  );


// ---------------------------------------------------------------------------
// RPC: the repo's own JournalsGroup, served from the read model. The
// bundle carries exactly one copy of effect (see the resolve plugin
// in alchemy.run.ts), so the group/schema classes the client protocol
// names are the same instances this server decodes with.
// ---------------------------------------------------------------------------

const notMoved = (what: string): Effect.Effect<never, ApiError> =>
  Effect.fail(
    new ApiError({
      message: `${what} has not moved to the Cloudflare worker yet — it still runs on medina-dev`,
    }),
  );

const loadPlaces = (
  bucket: JournalBucket,
): Effect.Effect<ReadonlyArray<Place>> =>
  Effect.gen(function* () {
    for (const key of ["places.json", "gps/places.json"]) {
      const json = yield* getJson(bucket, key);
      if (json === null) continue;
      const places = yield* decodeOrNull(Places, json);
      if (places !== null) return places;
    }
    return [];
  });

const makeHandlers = (bucket: JournalBucket) =>
  JournalsGroup.toLayer({
    ListDays: () => Effect.map(readModel(bucket), (model) => model.rows),
    ListJournals: ({ limit }) =>
      Effect.map(readModel(bucket), (model) => {
        const staleByDay = new Map(
          model.rows.map((row) => [row.day, row.stale]),
        );
        const entries = [...model.journals.values()]
          .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
          .map(
            (journal) =>
              new JournalEntry({
                journal,
                stale: staleByDay.get(journal.day) ?? false,
              }),
          );
        return limit === undefined ? entries : entries.slice(0, limit);
      }),
    // GetJournal's success is NullOr(Journal): a day with no journal
    // is a null, not an error (the server reserves its 202-pending
    // dance for the HTML page, not this RPC).
    GetJournal: ({ day }) =>
      Effect.map(
        readModel(bucket),
        (model) => model.journals.get(day) ?? null,
      ),
    GetDayTranscripts: ({ day }) => dayTranscripts(bucket, day),
    GetStatus: () => Effect.map(readModel(bucket), rpcStatus),
    SearchTranscripts: () => notMoved("transcript search"),
    ListPlaces: () => loadPlaces(bucket),
    ListPlaceCandidates: () => notMoved("place candidates"),
    SearchAddress: () => notMoved("address search"),
    SavePlaces: () => notMoved("saving places"),
    StreamEvents: () =>
      Stream.fail(
        new ApiError({
          message:
            "the event stream has not moved to the Cloudflare worker yet — it still runs on medina-dev",
        }),
      ),
  });

type RpcApp = (request: Request) => Promise<Response>;

let rpcAppPromise: Promise<RpcApp> | null = null;

const rpcApp = (bucket: JournalBucket): Promise<RpcApp> => {
  if (rpcAppPromise === null) {
    rpcAppPromise = (async () => {
      // One long-lived scope for the protocol server, mirroring how
      // the bun server's layerHttp keeps its server alive.
      const scope: Scope.Scope = Scope.makeUnsafe();
      const httpEffect = await Effect.runPromise(
        RpcServer.toHttpEffect(JournalsGroup).pipe(
          Effect.provide(makeHandlers(bucket)),
          Effect.provide(RpcSerialization.layerNdjson),
          Effect.provideService(Scope.Scope, scope),
        ),
      );
      return async (request: Request): Promise<Response> => {
        const response = await Effect.runPromise(
          httpEffect.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request),
            ),
            Effect.provideService(Scope.Scope, scope),
          ),
        );
        return HttpServerResponse.toWeb(response);
      };
    })();
  }
  return rpcAppPromise;
};

// ---------------------------------------------------------------------------
// The gate and the routes
// ---------------------------------------------------------------------------

const GATE_COOKIE = "medina_gate";
const GATE_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

const cookieValue = (request: Request, name: string): string | null => {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name && rest.length > 0) return rest.join("=");
  }
  return null;
};

const notFound = (): Response =>
  new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

const CLIENT_CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const serveClientObject = (
  bucket: JournalBucket,
  key: string,
  cacheControl: string,
): Effect.Effect<Response> =>
  Effect.promise(async () => {
    const object = await bucket.get(key);
    if (object === null) return notFound();
    const dot = key.lastIndexOf(".");
    const contentType =
      CLIENT_CONTENT_TYPES[dot === -1 ? "" : key.slice(dot)] ??
      "application/octet-stream";
    return new Response(object.body, {
      headers: {
        "content-type": contentType,
        "cache-control": cacheControl,
        etag: object.httpEtag,
      },
    });
  });

const isJournalPath = (path: string): boolean =>
  path === "/" ||
  path === "/app.js" ||
  path === "/inter.woff2" ||
  path === "/status" ||
  path === "/rpc" ||
  path.startsWith("/icons/") ||
  path.startsWith("/journal/");

/**
 * Handle a journal request, or return null when the path belongs to
 * another route family. `authorize` is the Worker's capture-policy
 * token check — the same registry that gates the policy document.
 */
export const handleJournal = (
  request: Request,
  bucket: JournalBucket,
  authorize: (token: string) => Effect.Effect<boolean>,
): Effect.Effect<Response | null> =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!isJournalPath(path)) return null;

    const queryToken = url.searchParams.get("token");
    const bearer = request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "");
    const presented =
      queryToken ?? bearer ?? cookieValue(request, GATE_COOKIE);
    const authorized =
      presented !== null &&
      presented !== undefined &&
      (yield* authorize(presented));
    if (!authorized) return notFound();

    // A token arriving by URL is exchanged for the gate cookie and
    // the browser is sent to the clean URL, so the SPA (which knows
    // nothing of tokens) carries the cookie from then on.
    if (
      queryToken !== null &&
      cookieValue(request, GATE_COOKIE) !== queryToken &&
      request.method === "GET" &&
      (path === "/" || path.startsWith("/journal/"))
    ) {
      const clean = new URL(url);
      clean.searchParams.delete("token");
      return new Response(null, {
        status: 302,
        headers: {
          location: clean.toString(),
          "set-cookie": `${GATE_COOKIE}=${queryToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${GATE_COOKIE_MAX_AGE}`,
        },
      });
    }

    if (path === "/rpc") {
      if (request.method !== "POST") return notFound();
      const app = yield* Effect.promise(() => rpcApp(bucket));
      return yield* Effect.promise(() => app(request));
    }

    if (request.method !== "GET") return notFound();

    if (path === "/") {
      const icons = yield* iconSet(bucket);
      return new Response(spaHome(icons), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (path === "/app.js") {
      return yield* serveClientObject(
        bucket,
        "client/app.js",
        "private, max-age=60",
      );
    }
    if (path === "/inter.woff2") {
      return yield* serveClientObject(
        bucket,
        "client/inter.woff2",
        "public, max-age=31536000, immutable",
      );
    }
    if (path.startsWith("/icons/")) {
      const name = decodeURIComponent(path.slice("/icons/".length));
      if (name.length === 0 || name.includes("/")) return notFound();
      return yield* serveClientObject(
        bucket,
        `client/icons/${name}`,
        "public, max-age=31536000, immutable",
      );
    }
    if (path === "/status") {
      const model = yield* readModel(bucket);
      return new Response(JSON.stringify(httpStatus(model), null, 2), {
        headers: { "content-type": "application/json" },
      });
    }
    // /journal/:day
    const dayParam = decodeURIComponent(path.slice("/journal/".length));
    const day = parseDayId(dayParam);
    if (day === null) {
      return new Response("Invalid day", { status: 400 });
    }
    const model = yield* readModel(bucket);
    const journal = model.journals.get(day) ?? null;
    const accept = request.headers.get("accept") ?? "";
    const wantsJson =
      accept.includes("application/json") &&
      (!accept.includes("text/html") || url.searchParams.has("format"));
    if (journal === null) {
      if (wantsJson) {
        return new Response(JSON.stringify({ status: "pending", day }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      const icons = yield* iconSet(bucket);
      return new Response(pendingPage(icons, dayParam), {
        status: 202,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (wantsJson) {
      return new Response(JSON.stringify(journal), {
        headers: { "content-type": "application/json" },
      });
    }
    const icons = yield* iconSet(bucket);
    return new Response(dayPage(icons, journal), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
