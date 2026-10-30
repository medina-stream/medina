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
 * server pays on a cold mount does not exist on this side. Reads
 * decode a persisted read-model snapshot the minutely cron rebuilds
 * in the background whenever the inputs move (see the snapshot
 * section below); an in-isolate memo with a 60 s TTL absorbs repeat
 * reads on top. (The server's own previews run a 10-minute
 * stale-while-revalidate, so a minute or two of lag is well inside
 * the system's existing freshness contract.)
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
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import {
  ApiError,
  DayRow,
  DayTranscript,
  GetStatus,
  JournalEntry,
  ListJournals,
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

export interface JournalBucketObjectHead {
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly customMetadata: Record<string, string>;
}

export interface JournalBucket {
  get(key: string): Promise<JournalBucketObject | null>;
  head(key: string): Promise<JournalBucketObjectHead | null>;
  put(
    key: string,
    value: string,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
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
  readonly etag: string;
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
          etag: object.etag,
          uploaded: object.uploaded,
        });
      }
      if (!result.truncated || result.cursor === undefined) break;
      cursor = result.cursor;
    }
    return all;
  });

// ---------------------------------------------------------------------------
// The read model: everything a journal request can need. Requests
// decode it from the persisted snapshot (below) and memoize it for
// a minute per isolate; the corpus gather happens in the background.
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
 * Newest journal per day, by the journal's own `generatedAt` — the
 * server's selection rule in `Views.currentJournals`. Upload order
 * cannot be trusted for this: the milestone-3 converge pass
 * re-uploaded generations in key order, so the most recently
 * *uploaded* candidate is often an older generation. Every
 * candidate's text is fetched (only its `generatedAt` is read) and
 * just the winner's JSON is kept — a few thousand small reads per
 * gather. This scan is the expensive half of the read model, which
 * is why it runs in the background snapshot builder (below), never
 * on a request if a snapshot exists; the §2 incremental-index
 * redesign retires the scan itself.
 */
const loadJournalsRaw = (
  bucket: JournalBucket,
): Effect.Effect<ReadonlyArray<unknown>> =>
  Effect.gen(function* () {
    const listed = yield* listAll(bucket, `${JOURNAL_PREFIX}/`);
    const keysByDay = new Map<string, Array<string>>();
    for (const object of listed) {
      const rest = object.key.slice(JOURNAL_PREFIX.length + 1);
      const [day, file] = rest.split("/");
      if (!day || !file || !file.endsWith(".json")) continue;
      const keys = keysByDay.get(day) ?? [];
      keys.push(object.key);
      keysByDay.set(day, keys);
    }
    const winners: Array<unknown> = [];
    yield* Effect.forEach(
      [...keysByDay.values()],
      (keys) =>
        Effect.gen(function* () {
          const candidates = yield* Effect.forEach(
            keys,
            (key) =>
              Effect.map(getText(bucket, key), (text) =>
                text === null
                  ? null
                  : {
                      generatedAt:
                        /"generatedAt"\s*:\s*"([^"]+)"/.exec(text)?.[1] ??
                        "",
                      text,
                    },
              ),
            { concurrency: 8 },
          );
          let winner: { generatedAt: string; text: string } | null = null;
          for (const candidate of candidates) {
            if (
              candidate !== null &&
              (winner === null ||
                candidate.generatedAt > winner.generatedAt)
            ) {
              winner = candidate;
            }
          }
          if (winner === null) return;
          const json = yield* Effect.try(() =>
            JSON.parse(winner.text) as unknown,
          ).pipe(Effect.catch(() => Effect.succeed(null)));
          if (json !== null) winners.push(json);
        }),
      { concurrency: 8 },
    );
    return winners;
  });

/** sha256("") — the input hash of the server's transient empty
 * journal (Journal.ts `emptyJournal`), for days with no inputs. */
const EMPTY_INPUT_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const emptyJournal = (day: string): Journal =>
  new Journal({
    version: JOURNAL_PREFIX.slice("journal/".length),
    day,
    inputHash: EMPTY_INPUT_HASH,
    transcriptKeys: [],
    model: null,
    generatedAt: new Date().toISOString(),
    status: "completed",
    report: "",
  });

/** Days the server's own snapshot marks stale: their current-input
 * journal is not on disk, which is exactly the condition under
 * which the server's `journalCachedForDay` answers None (the RPC
 * GetJournal returns null; the day page answers 202 pending). */
const staleDay = (model: ReadModel, day: string): boolean =>
  model.rows.some((row) => row.day === day && row.stale);

/** Whether a day has anything a journal could be written from, as
 * far as artifacts can tell: it appears in the day rows or carries
 * transcripts in the current day-index snapshot. */
const hasInputs = (model: ReadModel, day: string): boolean =>
  model.rows.some((row) => row.day === day) ||
  (model.index?.days[day]?.length ?? 0) > 0;

/**
 * The current day-index snapshot: among the most recently uploaded
 * generations, the one with the greatest builtAt. (Listing order is
 * by key, and keys are content hashes — recency only exists in the
 * upload timestamps and inside the files.)
 */
const loadDayIndexJson = (bucket: JournalBucket): Effect.Effect<unknown> =>
  Effect.gen(function* () {
    const listed = yield* listAll(bucket, `${DAY_INDEX_PREFIX}/`);
    const candidates = listed
      .filter((object) => object.key.endsWith(".json"))
      .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
      .slice(0, 3);
    let best: { builtAt: string; json: unknown } | null = null;
    for (const candidate of candidates) {
      const json = yield* getJson(bucket, candidate.key);
      const index = yield* decodeOrNull(DayIndex, json);
      if (index !== null && (best === null || index.builtAt > best.builtAt)) {
        best = { builtAt: index.builtAt, json };
      }
    }
    return best?.json ?? null;
  });

const REPORT_KEYS = [
  ["ingest", "runs/latest.json"],
  ["capture", "runs/capture/latest.json"],
  ["inventory", "runs/inventory/latest.json"],
] as const;

/**
 * The read model's inputs, gathered but not yet decoded: the exact
 * JSON values the decode step below consumes. Gathering is the
 * expensive half (the journal scan); decoding is cheap. Keeping
 * the two halves separate is what lets the persisted snapshot
 * (below) store gathered inputs and pay the gather only in the
 * background.
 */
interface RawReadModel {
  readonly rowsJson: unknown;
  readonly journalsJson: ReadonlyArray<unknown>;
  readonly indexJson: unknown;
  readonly reportsJson: ReadonlyArray<readonly [string, unknown]>;
}

const gatherRawModel = (
  bucket: JournalBucket,
): Effect.Effect<RawReadModel> =>
  Effect.gen(function* () {
    const rowsJson = yield* getJson(bucket, PREVIEWS_KEY);
    const journalsJson = yield* loadJournalsRaw(bucket);
    const indexJson = yield* loadDayIndexJson(bucket);
    const reportsJson: Array<readonly [string, unknown]> = [];
    for (const [name, key] of REPORT_KEYS) {
      reportsJson.push([name, yield* getJson(bucket, key)]);
    }
    return { rowsJson, journalsJson, indexJson, reportsJson };
  });

/** Decode gathered inputs into the read model — the same decodes,
 * with the same failure shapes, the original per-request build ran. */
const modelFromRaw = (
  raw: RawReadModel,
  builtAt: number,
): Effect.Effect<ReadModel> =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(ListDays.successSchema)(
      raw.rowsJson ?? [],
    ).pipe(
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<DayRow>)),
    );
    const journals = new Map<string, Journal>();
    for (const json of raw.journalsJson) {
      const journal = yield* decodeOrNull(Journal, json);
      if (journal !== null) journals.set(journal.day, journal);
    }
    const index = yield* decodeOrNull(DayIndex, raw.indexJson);
    const reports = new Map<string, RunReportShape>();
    for (const [name, json] of raw.reportsJson) {
      const report = yield* decodeOrNull(LastRun, json);
      if (report !== null) reports.set(name, report);
    }
    return { builtAt, rows, journals, index, reports };
  });

// ---------------------------------------------------------------------------
// The persisted read-model snapshot: the cron-built copy of the
// gathered inputs, stored as one bucket artifact. Serving reads
// decode from the snapshot (one GET + decode) instead of gathering
// from the corpus per request — the gather's journal scan measured
// 30–95 s, which is what put the SPA into its "could not load the
// journal" state whenever a request landed on a cold isolate or an
// expired isolate cache. The minutely Cron Trigger refreshes the
// snapshot whenever a cheap inputs fingerprint (listings + HEADs,
// no body reads) changes; requests never wait on the scan again.
// ---------------------------------------------------------------------------

const SNAPSHOT_KEY = "views/worker-read-model-v1.json";

interface SnapshotEnvelope extends RawReadModel {
  readonly version: 1;
  readonly builtAt: number;
  readonly fingerprint: string;
}

const sha256Hex = (value: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });

/**
 * A fingerprint of everything the gather reads, computed from
 * listings and HEADs only: object keys, etags, and sizes for the
 * journal and day-index prefixes, and the etags of the previews
 * snapshot and the three run reports. Any artifact write that could
 * change the read model changes the fingerprint.
 */
const inputsFingerprint = (
  bucket: JournalBucket,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const journalObjects = yield* listAll(bucket, `${JOURNAL_PREFIX}/`);
    const indexObjects = yield* listAll(bucket, `${DAY_INDEX_PREFIX}/`);
    const previewsHead = yield* Effect.promise(() =>
      bucket.head(PREVIEWS_KEY),
    );
    const lines: Array<string> = [
      `previews:${previewsHead?.etag ?? "absent"}:${previewsHead?.size ?? -1}`,
    ];
    for (const [name, key] of REPORT_KEYS) {
      const head = yield* Effect.promise(() => bucket.head(key));
      lines.push(
        `report:${name}:${head?.etag ?? "absent"}:${head?.size ?? -1}`,
      );
    }
    for (const object of journalObjects) {
      lines.push(`j:${object.key}:${object.etag}:${object.size}`);
    }
    for (const object of indexObjects) {
      lines.push(`i:${object.key}:${object.etag}:${object.size}`);
    }
    return yield* sha256Hex(lines.join("\n"));
  });

const writeSnapshot = (
  bucket: JournalBucket,
  raw: RawReadModel,
  fingerprint: string,
  builtAt: number,
): Effect.Effect<number> =>
  Effect.promise(async () => {
    const envelope: SnapshotEnvelope = {
      version: 1,
      builtAt,
      fingerprint,
      rowsJson: raw.rowsJson,
      journalsJson: raw.journalsJson,
      indexJson: raw.indexJson,
      reportsJson: raw.reportsJson,
    };
    const body = JSON.stringify(envelope);
    await bucket.put(SNAPSHOT_KEY, body, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { fingerprint, builtAt: String(builtAt) },
    });
    return body.length;
  });

export interface SnapshotRefresh {
  readonly rebuilt: boolean;
  readonly fingerprint: string;
  /** Snapshot build time (ms epoch), after this refresh. */
  readonly snapshotBuiltAt: number | null;
  /** Wall time of the gather + write, when a rebuild happened. */
  readonly buildMs: number | null;
  /** Snapshot size in bytes, when a rebuild happened. */
  readonly bytes: number | null;
}

/**
 * Bring the persisted snapshot up to date: rebuild it only when the
 * inputs fingerprint moved (or `force` is set). Runs on the minutely
 * Cron Trigger and behind the token-gated `POST /journal/refresh`.
 */
export const refreshReadModelSnapshot = (
  bucket: JournalBucket,
  force = false,
): Effect.Effect<SnapshotRefresh> =>
  Effect.gen(function* () {
    const head = yield* Effect.promise(() => bucket.head(SNAPSHOT_KEY));
    const fingerprint = yield* inputsFingerprint(bucket);
    const snapshotBuiltAt =
      head === null
        ? null
        : Number(
            head.customMetadata["builtAt"] ?? head.uploaded.getTime(),
          );
    if (!force && head?.customMetadata["fingerprint"] === fingerprint) {
      return {
        rebuilt: false,
        fingerprint,
        snapshotBuiltAt,
        buildMs: null,
        bytes: null,
      };
    }
    const startedAt = Date.now();
    const raw = yield* gatherRawModel(bucket);
    const builtAt = Date.now();
    const bytes = yield* writeSnapshot(bucket, raw, fingerprint, builtAt);
    return {
      rebuilt: true,
      fingerprint,
      snapshotBuiltAt: builtAt,
      buildMs: builtAt - startedAt,
      bytes,
    };
  });

/** The snapshot as a read model; null when absent or unusable. */
const loadSnapshotModel = (
  bucket: JournalBucket,
): Effect.Effect<ReadModel | null> =>
  Effect.gen(function* () {
    const text = yield* getText(bucket, SNAPSHOT_KEY);
    if (text === null) return null;
    const parsed = yield* Effect.try(
      () => JSON.parse(text) as Partial<SnapshotEnvelope>,
    ).pipe(Effect.catch(() => Effect.succeed(null)));
    if (
      parsed === null ||
      parsed.version !== 1 ||
      typeof parsed.builtAt !== "number" ||
      !Array.isArray(parsed.journalsJson) ||
      !Array.isArray(parsed.reportsJson)
    ) {
      return null;
    }
    return yield* modelFromRaw(
      {
        rowsJson: parsed.rowsJson ?? null,
        journalsJson: parsed.journalsJson,
        indexJson: parsed.indexJson ?? null,
        reportsJson: parsed.reportsJson,
      },
      parsed.builtAt,
    );
  }).pipe(Effect.catch(() => Effect.succeed(null)));

/**
 * Load the read model for a request: the persisted snapshot when
 * one exists (the normal case — the cron keeps it current), else a
 * live gather, which also persists its result as the snapshot so
 * the next cold isolate does not pay the scan again.
 */
const loadModel = (bucket: JournalBucket): Effect.Effect<ReadModel> =>
  Effect.gen(function* () {
    const snapshot = yield* loadSnapshotModel(bucket);
    if (snapshot !== null) return snapshot;
    const raw = yield* gatherRawModel(bucket);
    const builtAt = Date.now();
    const fingerprint = yield* inputsFingerprint(bucket);
    yield* writeSnapshot(bucket, raw, fingerprint, builtAt).pipe(
      Effect.ignore,
    );
    return yield* modelFromRaw(raw, builtAt);
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
      readModelCache = Effect.runPromise(loadModel(bucket)).catch(
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

const STYLE = `
  /* Inter, self-hosted (see the /inter.woff2 route). One typeface for the
     whole UI: no serif stack, no second family for controls. */
  @font-face {
    font-family: "Inter";
    font-style: normal;
    font-weight: 100 900;
    font-display: swap;
    src: url("/inter.woff2") format("woff2");
  }
  :root {
    color-scheme: light dark;
    --ui: "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
    font-family: var(--ui);
    /* Inter's optical sizing and tabular figures: dates line up in a column
       when the digits are all the same width. */
    font-optical-sizing: auto;
    --ink: #1a1a1a;
    --muted: #6b6b6b;
    --rule: #d8d4cc;
    --rule-soft: #e8e5df;
    --bg: #fdfdfc;
    --surface: #f5f3ef;
    --accent: #2f6f4f;
    --tl-fill: #2f6fb2;
    --bad: #b93f3f;
    --warn: #b07d1a;
    /* Tap targets: 44px is the accessibility floor on touch. */
    --tap: 2.75rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #ececec; --muted: #9a9a9a; --rule: #3a3a3a; --rule-soft: #2c2c2c;
      --bg: #151515; --surface: #1e1e1e; --accent: #6fbf8f; --bad: #e07070; --warn: #d6a94a;
      --tl-fill: #6aa5e0;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--ui);
    max-width: 46rem;
    margin: 0 auto;
    padding: 1.25rem 1.25rem 4rem;
    line-height: 1.55;
    color: var(--ink);
    background: var(--bg);
    /* Keep long place names and URLs from forcing a sideways scroll. */
    overflow-wrap: break-word;
  }
  @media (max-width: 34rem) { body { padding: .75rem 1rem 3rem; } }
  h1 { font-size: 1.5rem; margin: 0; line-height: 1.2; letter-spacing: -.01em; }
  h2 { font-size: 1.15rem; margin: 0 0 1rem; line-height: 1.3; letter-spacing: -.01em; }
  h3 { font-size: 1rem; margin: 1.5rem 0 .25rem; }
  header p, .empty { color: var(--muted); }
  section { border-top: 1px solid var(--rule); margin-top: 2.5rem; padding-top: 1.5rem; }
  h2 a { color: inherit; text-decoration: none; }
  h2 a:hover { text-decoration: underline; }
  p { margin: .7rem 0; }
  a { color: var(--accent); }
  .stale { font-size: .7rem; font-weight: 500; color: var(--muted); }

  /* A quiet instance label: enough presence to orient the viewer without
     competing with the journal. The client scales only unusually long names. */
  .site-header {
    padding: .45rem 3.4rem .15rem 0;
    margin-bottom: 1.65rem;
    overflow: hidden;
  }
  .hostname {
    width: 100%; overflow: hidden; white-space: nowrap;
    font-family: "Inter"; font-size: .875rem; font-weight: 500;
    line-height: 1.35; letter-spacing: .025em;
  }
  .hostname-lead {
    color: var(--ink);
    font-weight: 620;
  }
  .hostname-rest { color: var(--muted); }

  /* A little separation below the instance name, without changing the
     virtual table's one-to-one mapping from scrollTop to row index. */
  #app { padding-top: .25rem; }

  /* Controls: one look, and never smaller than a comfortable tap. */
  input, button, select {
    font-family: var(--ui);
    font-size: 1rem; /* iOS zooms the page on focus below 16px. */
    color: inherit;
    border: 1px solid var(--rule);
    border-radius: .4rem;
    background: var(--bg);
    padding: .45rem .6rem;
    min-height: var(--tap);
  }
  button {
    background: var(--surface);
    cursor: pointer;
    padding-inline: .9rem;
    white-space: nowrap;
  }
  button:hover { border-color: var(--muted); }
  button:active { transform: translateY(1px); }
  button.danger { color: var(--bad); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* The account button floats over the list's top-right corner. The list
     gets matching top padding so the first row's badge never sits under it.
     The events button sits just left of it: live activity, one tap away. */
  .accountbutton {
    position: fixed; top: .6rem; right: max(.6rem, calc((100vw - 46rem) / 2));
    z-index: 2; background: var(--bg); border-color: var(--rule-soft);
  }
  .eventsbutton {
    position: fixed; top: .6rem; right: calc(max(.6rem, calc((100vw - 46rem) / 2)) + var(--tap) + .35rem);
    z-index: 2; background: var(--bg); border-color: var(--rule-soft);
  }
  .iconbutton {
    display: inline-flex; align-items: center; justify-content: center; gap: .35rem;
    min-width: var(--tap); min-height: var(--tap);
    padding: .25rem .5rem; border-radius: .5rem;
    background: transparent; border: 1px solid transparent; color: var(--muted);
  }
  .iconbutton:hover { background: var(--surface); border-color: var(--rule); color: var(--ink); }
  #account-dot { margin: 0; }
  .accountnav { display: flex; gap: 1rem; padding-bottom: .9rem; margin-bottom: .3rem; border-bottom: 1px solid var(--rule-soft); }
  .accountnav a { font-weight: 550; text-decoration: none; }
  .accountnav a:hover { text-decoration: underline; }

  /* Status and live feed (inside the account modal) */
  .status { font-size: .875rem; }
  .status-line { margin: 0 0 .5rem; font-weight: 600; }
  .status-dot {
    display: inline-block; width: .6rem; height: .6rem; border-radius: 50%;
    background: var(--muted); flex: none;
  }
  .status.good #account-dot, .status-dot.good { background: var(--accent); }
  .status.warn #account-dot, .status-dot.warn { background: var(--warn); }
  .status.bad #account-dot, .status-dot.bad { background: var(--bad); }
  .status ul { margin: .5rem 0 1rem; padding-left: 1.25rem; }
  .status li { margin: .15rem 0; }
  .live-list {
    font-size: .8rem;
    max-height: 40vh; overflow-y: auto; margin: .5rem 0 0; padding-left: 1.5rem;
  }
  .live-list li { margin: .2rem 0; }
  .event-time { color: var(--muted); margin-right: .4rem; }
  .event-failing { color: var(--bad); }
  /* The events sheet is the dedicated live view, so its list gets the room. */
  .events-list { max-height: 70vh; }

  /* Modals. A native dialog gives focus trapping and Esc for free. */
  .modal {
    width: min(42rem, 100vw - 2rem);
    max-height: min(85vh, 60rem);
    padding: 0; border: 1px solid var(--rule); border-radius: .75rem;
    background: var(--bg); color: var(--ink);
    box-shadow: 0 12px 40px rgb(0 0 0 / .28);
    overflow: hidden;
  }
  .modal::backdrop { background: rgb(0 0 0 / .45); }
  .modal-head {
    display: flex; align-items: center; gap: .75rem;
    padding: .85rem 1.1rem; border-bottom: 1px solid var(--rule-soft);
    position: sticky; top: 0; background: var(--bg);
  }
  .modal-head h2 { flex: 1 1 auto; margin: 0; font-size: 1.15rem; }
  .day-search { display: flex; align-items: center; gap: .25rem; flex: 1 1 16rem; min-width: 0; }
  .day-search input { width: 100%; min-width: 0; min-height: 2.2rem; padding: .3rem .45rem; }
  .day-search button { min-width: 2.2rem; min-height: 2.2rem; padding: .25rem; }
  #day-search-count { min-width: 2.8rem; color: var(--muted); font-size: .75rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
  mark.day-match { background: color-mix(in srgb, var(--warn) 35%, transparent); color: inherit; border-radius: .15rem; }
  mark.day-match.current { outline: 2px solid var(--accent); outline-offset: 1px; }
  .modal-body { padding: 1rem 1.1rem 1.5rem; overflow-y: auto; max-height: calc(85vh - 4rem); }
  .modal-body h3 { margin-top: 1.25rem; }
    .day-map-wrap { margin: 0 0 1rem; }
    .day-map { height: 300px; border-radius: 12px; overflow: hidden; background: #e2e8f0; }
    .place-chip {
      display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.55rem;
      font-size: 0.72rem; font-weight: 600; line-height: 1.5; border-radius: 999px;
      background: #eef2ff; color: #3730a3; vertical-align: middle; white-space: nowrap;
    }
  @media (max-width: 34rem) {
    /* Full-bleed sheet on a phone: more room, and a familiar shape. */
    .modal {
      width: 100vw; max-width: 100vw; max-height: 92vh;
      margin: auto auto 0; border-radius: .9rem .9rem 0 0; border-bottom: 0;
    }
    .modal-head { flex-wrap: wrap; }
    .modal-head h2 { flex: 1 1 auto; }
    .day-search { order: 3; flex-basis: 100%; }
    .modal-body { max-height: calc(92vh - 4rem); }
  }

  /* Days table. No page header any more, so the list starts at the top. */
  .vtable { overflow-y: auto; height: min(84vh, 58rem); position: relative; -webkit-overflow-scrolling: touch; }
  .vspacer { position: relative; width: 100%; }
  .vrow { position: absolute; left: 0; right: 0; height: 100px; }
  /* The whole row is the target, so it is a button, not a link inside text. */
  .vrow-inner {
    display: block; width: 100%; height: 100px; text-align: left;
    padding: 14px .5rem; margin: 0; overflow: hidden;
    background: none; border: 0; border-bottom: 1px solid var(--rule-soft);
    border-radius: 0; cursor: pointer; color: inherit;
  }
  .vrow-inner:hover { background: var(--surface); }
  .vrow-inner:active { transform: none; }
  .vrow-title { display: flex; align-items: baseline; gap: .55rem; margin-bottom: .3rem; }
  /* Tabular figures keep the compact dates in a true column. */
  .vrow-day {
    font-size: 1rem; font-weight: 620; letter-spacing: -.01em;
    font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1;
  }
  .vrow-rel { font-size: .8rem; color: var(--muted); }
  .vrow-audio {
    margin-left: auto; flex: none;
    font-size: .7rem; font-variant-numeric: tabular-nums;
    color: var(--muted); background: var(--surface);
    border: 1px solid var(--rule-soft); border-radius: 999px;
    padding: .1rem .45rem;
  }
  .vrow-inner p { margin: 0; font-size: .9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vrow-inner p.preview { color: var(--ink); }
  /* Per-day coverage timeline: a full-width 24h line, blue where audio was
     ingested, with quiet inactive ticks at 6am, noon, and 6pm. */
  .vrow-timeline {
    position: relative; height: 8px; margin-top: .55rem;
    border-radius: 999px; background: var(--rule-soft);
  }
  .tl-seg { position: absolute; top: 0; bottom: 0; border-radius: 999px; background: var(--tl-fill); }
  .tl-tick { position: absolute; top: -2px; height: 12px; width: 1px; background: var(--muted); opacity: .45; }

  /* Search lives above either primary main view: the days list or a result
     set. The route swaps only the content below this header. */
  .home-header { padding-bottom: .75rem; border-bottom: 1px solid var(--rule-soft); margin-bottom: .25rem; }
  .search-form { display: flex; gap: .5rem; margin: 0; }
  .search-form input { flex: 1 1 auto; min-width: 0; }
  .search-hit { display: flex; flex-direction: column; gap: .2rem; width: 100%; text-align: left; white-space: normal; border: 0; border-bottom: 1px solid var(--rule-soft); border-radius: 0; padding: .85rem 0; background: transparent; }
  .search-hit:hover { background: var(--surface); }
  .search-hit-meta { color: var(--muted); font-size: .78rem; font-variant-numeric: tabular-nums; }

  /* Day detail keeps the generated summary first, followed by the source
     turns. Chunk headings behave as links to their nearest transcript time. */
  .transcripts { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--rule); }
  .transcript-jump { min-height: 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: inherit; font: inherit; font-weight: inherit; text-align: left; }
  .transcript-jump:hover { color: var(--accent); text-decoration: underline; }
  .transcript-recording { margin: 1rem 0 1.35rem; }
  .transcript-recording h4 { margin: 0 0 .45rem; color: var(--muted); font-size: .8rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .transcript-turn { margin: 0; padding: .42rem 0 .42rem 4.4rem; position: relative; scroll-margin-block: 5rem; }
  .transcript-time { position: absolute; left: 0; width: 3.6rem; color: var(--muted); font-size: .78rem; font-variant-numeric: tabular-nums; }
  .transcript-speaker { display: block; margin: 0 0 .15rem; font-weight: 650; }
  .transcript-text { display: block; }

  .transcript-legend { color: var(--bad); font-size: .78rem; font-weight: 650; }
  .transcript-legend i { display: inline-block; width: .5rem; height: .5rem; margin-right: .25rem; border-radius: 50%; background: var(--bad); }
  .transcript-note { margin: .25rem 0 .75rem; color: var(--muted); font-size: .76rem; }
  .transcript-turn-own { color: var(--bad); font-weight: 560; }
  .transcript-turn-own .transcript-speaker { color: var(--bad); }
  .transcript-text { display: block; }

  /* Places editor. The row is a wrapping grid: wide screens get one line,
     narrow screens stack into labelled fields instead of a jumble. */
  .pplace, .pcand { border-bottom: 1px solid var(--rule-soft); padding: 1rem 0; }
  .prow { display: flex; gap: .5rem .6rem; flex-wrap: wrap; align-items: end; margin: .5rem 0; }
  .pfield { display: flex; flex-direction: column; gap: .15rem; flex: 1 1 7rem; min-width: 0; }
  .pfield-name { flex: 2 1 11rem; }
  .pfield-narrow { flex: 0 1 6rem; }
  .pfield span { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .pfield input { width: 100%; }
  .prow button { align-self: end; }
  @media (max-width: 34rem) {
    .pfield, .pfield-name, .pfield-narrow { flex: 1 1 100%; }
    .prow button { width: 100%; }
  }
  .pcand-head { display: flex; flex-wrap: wrap; gap: .25rem .5rem; align-items: baseline; }
  .pcand-meta { font-size: .8rem; color: var(--muted); }
  .psave { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; margin: 1rem 0; }
  #place-status { font-size: .85rem; color: var(--muted); }
  .paddr { display: flex; gap: .5rem; margin: .5rem 0; }
  .paddr input { flex: 1 1 auto; min-width: 0; }

  /* Map: a tile grid with a fixed centre pin. Clipped to its box, so the
     tiles that overhang the edges simply do not show. */
  .pmap {
    position: relative; overflow: hidden; cursor: crosshair;
    width: 100%; height: 220px; margin: .5rem 0;
    border: 1px solid var(--rule); border-radius: .5rem;
    background: var(--surface); touch-action: manipulation;
  }
  .ptiles {
    position: absolute; top: 0; bottom: 0;
    /* The grid is generated for the widest case (MAP_COVER) and centred, so
       one set of tiles covers every viewport without a refetch on resize. */
    left: 50%; width: 768px; margin-left: -384px;
  }
  .ptile { position: absolute; width: 256px; height: 256px; user-select: none; }
  .ppin {
    position: absolute; left: 50%; top: 50%; width: 14px; height: 14px;
    margin: -7px 0 0 -7px; border-radius: 50%;
    background: var(--bad); border: 2px solid #fff;
    box-shadow: 0 1px 4px rgb(0 0 0 / .5); pointer-events: none;
  }
  .pattrib {
    position: absolute; right: 0; bottom: 0; z-index: 1;
    font-size: .65rem; color: var(--ink);
    background: rgb(255 255 255 / .75); padding: .1rem .3rem; border-top-left-radius: .3rem;
  }
  @media (prefers-color-scheme: dark) { .pattrib { background: rgb(0 0 0 / .6); } }

  .skel { height: .9rem; margin: .2rem 0; background: var(--rule-soft); border-radius: .2rem; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

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

/** Pages.tsx `Layout`, byte-exact: no whitespace between elements,
 * icon links in the server's order (manifest, svg, ico, apple), the
 * title after them, and a deferred classic script at the body's end. */
const layout = (
  icons: IconSet,
  title: string,
  body: string,
  scriptSrc?: string,
): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<meta name="theme-color" content="#0f172a">` +
  (icons.manifest
    ? `<link rel="manifest" href="/icons/${esc(icons.manifest)}">`
    : "") +
  (icons.svg
    ? `<link rel="icon" type="image/svg+xml" href="/icons/${esc(icons.svg)}">`
    : "") +
  (icons.ico
    ? `<link rel="icon" type="image/x-icon" href="/icons/${esc(icons.ico)}">`
    : "") +
  (icons.apple
    ? `<link rel="apple-touch-icon" href="/icons/${esc(icons.apple)}">`
    : "") +
  `<title>${esc(title)}</title>` +
  `<style>${STYLE}</style></head><body>${body}` +
  (scriptSrc ? `<script src="${esc(scriptSrc)}" defer></script>` : "") +
  `</body></html>`;

/** The SPA shell: Pages.tsx `spaHome`, transcribed byte-for-byte
 * (the parity harness byte-compares it against medina-dev's shell).
 * Static markup — all journal data arrives over the RPC. */
const spaHome = (icons: IconSet): string =>
  layout(icons, "Medina", SPA_BODY, "/app.js");

const SPA_BODY = `<header class="site-header"><h1 id="hostname" class="hostname" aria-label="Hostname"><span id="hostname-lead" class="hostname-lead"></span><span id="hostname-rest" class="hostname-rest"></span></h1></header><button type="button" id="account-open" class="iconbutton accountbutton" aria-label="Account and status" aria-haspopup="dialog"><span className="status-dot" id="account-dot"></span><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><circle cx="12" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.7"></circle><path d="M4.5 20c0-4.1 3.4-6.4 7.5-6.4s7.5 2.3 7.5 6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"></path></svg></button><button type="button" id="events-open" class="iconbutton eventsbutton" aria-label="Live events" aria-haspopup="dialog"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M2.5 12h4l2.5-6.5 4 13 2.5-6.5h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path></svg></button><main id="app"><p class="empty">Loading…</p></main><noscript><p class="empty">The journal loads over a typed RPC and needs JavaScript.</p></noscript><dialog id="account-modal" class="modal" aria-labelledby="account-title"><div class="modal-head"><h2 id="account-title">Account</h2><button type="button" class="iconbutton" data-close-modal aria-label="Close">✕</button></div><div class="modal-body"><nav class="accountnav"><a href="#/places" data-close-modal>Places</a><a href="/devices" data-close-modal>Devices</a></nav><div class="status" id="pipeline-status"><p id="status-summary" class="status-line">Checking data flow…</p><div id="status-details"></div></div><h3>Live events</h3><ol id="live-event-list" class="live-list"><li class="empty">Waiting for events…</li></ol></div></dialog><dialog id="events-modal" class="modal" aria-labelledby="events-title"><div class="modal-head"><h2 id="events-title">Events</h2><button type="button" class="iconbutton" data-close-modal aria-label="Close">✕</button></div><div class="modal-body"><ol id="events-list" class="live-list events-list"><li class="empty">Waiting for events…</li></ol></div></dialog><dialog id="day-modal" class="modal" aria-labelledby="day-title"><div class="modal-head"><h2 id="day-title"></h2><form id="day-search" class="day-search" role="search"><input id="day-search-query" type="search" placeholder="Search this day" aria-label="Search this day"><button type="button" id="day-search-prev" aria-label="Previous match">↑</button><button type="button" id="day-search-next" aria-label="Next match">↓</button><span id="day-search-count" role="status"></span></form><button type="button" class="iconbutton" data-close-modal aria-label="Close">✕</button></div><div class="modal-body" id="day-body"></div></dialog>`;

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

/** Pages.tsx `Report`, byte-exact: blocks split on blank lines; a
 * block opening with `## ` becomes an <h3> plus a <p> of its lines;
 * lines inside a <p> are separated by <br> (none trailing). */
const renderReport = (text: string): string =>
  text
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const linesHtml = (lines: ReadonlyArray<string>): string =>
        lines
          .map((line, index) => `${index > 0 ? "<br>" : ""}${esc(line)}`)
          .join("");
      const [first = "", ...rest] = block.split("\n");
      if (first.trim().startsWith("## ")) {
        return (
          `<h3>${esc(first.trim().replace(/^##\s+/, ""))}</h3>` +
          (rest.length > 0 ? `<p>${linesHtml(rest)}</p>` : "")
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
      `<main>${
        journal.report
          ? renderReport(journal.report)
          : `<p class="empty">Nothing recorded.</p>`
      }</main>`,
  );

const pendingPage = (icons: IconSet, day: string): string =>
  layout(
    icons,
    `Medina — ${dayIdLabel(day)}`,
    `<header><h1>${esc(dayIdLabel(day))}</h1><p><a href="/">All days</a></p></header>` +
      `<main><p class="empty">writing…</p></main>`,
  );


// ---------------------------------------------------------------------------
// RPC: the repo's own JournalsGroup, served from the read model. The
// bundle carries exactly one copy of effect (see the resolve alias
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
    ListDays: ({ limit, offset }) =>
      Effect.map(readModel(bucket), (model) => {
        // Same windowing as the server's handler.
        const start = offset ?? 0;
        const end =
          limit === undefined ? model.rows.length : start + limit;
        return model.rows.slice(start, end);
      }),
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
    // GetJournal mirrors the server's `journalCachedForDay`: the
    // current-input journal when it is on disk, null when the day
    // is stale or its journal has not been generated yet, and the
    // transient empty journal for a day with no inputs at all.
    // (Success is NullOr(Journal) — absence is a null, not an
    // error.) The stale signal is the server's own, from its
    // persisted day snapshot.
    GetJournal: ({ day }) =>
      Effect.map(readModel(bucket), (model) => {
        if (staleDay(model, day)) return null;
        const journal = model.journals.get(day) ?? null;
        if (journal !== null) return journal;
        return hasInputs(model, day) ? null : emptyJournal(day);
      }),
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

/**
 * Serve one RPC request. The protocol server is built per request,
 * inside the request's own scope: RpcServer forks its server loop
 * into the build scope, and on Workers a loop forked during one
 * fetch event is not guaranteed to survive into the next. Building
 * per request costs a few layer constructions (no I/O; the
 * expensive part, the bucket reads, is cached in the read model)
 * and keeps every lifetime inside the one event workerd
 * guarantees: this request. The response stream is likewise
 * drained here rather than handed to the runtime as a web body.
 */
const serveRpc = (
  bucket: JournalBucket,
  request: Request,
): Effect.Effect<Response> =>
  Effect.promise(async () => {
    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const httpEffect = yield* RpcServer.toHttpEffect(
            JournalsGroup,
          ).pipe(
            Effect.provide(makeHandlers(bucket)),
            Effect.provide(RpcSerialization.layerNdjson),
          );
          const res = yield* httpEffect.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request),
            ),
          );
          if (res.body._tag !== "Stream") return res;
          const chunks = yield* Stream.runCollect(res.body.stream);
          const bytes = new Uint8Array(
            chunks.reduce((sum, chunk) => sum + chunk.length, 0),
          );
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          return HttpServerResponse.uint8Array(bytes, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        }),
      ),
    );
    return HttpServerResponse.toWeb(response);
  });

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
      return yield* serveRpc(bucket, request);
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
    // /journal/:day — the server's handler shape: HTML when the
    // Accept header asks for it, the journal record otherwise; a
    // day whose current journal is not on disk (stale, or inputs
    // with no generation yet) answers 202 pending in both
    // representations; a day with no inputs at all answers the
    // transient empty journal. Cache headers mirror the server's:
    // settled past days cache for a day, everything else a minute.
    const dayParam = decodeURIComponent(path.slice("/journal/".length));
    const day = parseDayId(dayParam);
    if (day === null) {
      return new Response("not a day: use 020260907 or 2026-09-07", {
        status: 400,
      });
    }
    const model = yield* readModel(bucket);
    const wantsHtml = (request.headers.get("accept") ?? "").includes(
      "text/html",
    );
    const journal = model.journals.get(day) ?? null;
    const served =
      journal !== null && staleDay(model, day)
        ? null
        : journal ??
          (hasInputs(model, day) ? null : emptyJournal(day));
    if (served === null) {
      if (!wantsHtml) {
        return new Response(JSON.stringify({ status: "pending", day }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "cache-control": "private, max-age=60",
          },
        });
      }
      const icons = yield* iconSet(bucket);
      return new Response(pendingPage(icons, day), {
        status: 202,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "private, max-age=60",
        },
      });
    }
    const today = new Date().toISOString().slice(0, 10);
    const cacheControl =
      served.day < today ? "private, max-age=86400" : "private, max-age=60";
    if (!wantsHtml) {
      return new Response(JSON.stringify(served), {
        headers: {
          "content-type": "application/json",
          "cache-control": cacheControl,
        },
      });
    }
    const icons = yield* iconSet(bucket);
    return new Response(dayPage(icons, served), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": cacheControl,
      },
    });
  });
