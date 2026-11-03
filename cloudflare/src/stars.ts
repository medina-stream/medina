/**
 * The star detector on the Medina Worker (migration milestone 4,
 * step 3 — docs/cloudflare-migration.md §4.3 step 3).
 *
 * This is the Worker's port of medina-dev's star doorbell
 * (lib/lifelog/StarDetector.ts): a periodic sweep re-reads the
 * current and previous UTC days' transcripts from the day index,
 * parses self-spoken utterances that begin with the word "star",
 * files each command as a voice star through the Stars service
 * semantics (lib/lifelog/Stars.ts), and then runs the retention
 * sweep — expired stars are forgotten with a content-free receipt
 * left behind. The grammar, the rescan window, the deterministic
 * ids, and the born-expired guard are ported exactly; a grammar or
 * window change is a separate decision, not part of this port.
 *
 * The one platform substitution: the server builds the day index
 * fresh from the corpus on every pass, while the Worker reads the
 * newest persisted day-index snapshot artifact (`index/days-v1/`,
 * the same selection the journal serving pass makes in
 * src/journal.ts). While medina-dev's detector runs it refreshes
 * that snapshot itself, so the shadow diff below compares like for
 * like; after the flip the snapshot is refreshed by medina-dev's
 * ingest passes (the day-index resource moves in step 8), and every
 * report carries the snapshot's builtAt so its age is always
 * visible. The §2 incremental-index redesign retires the lag
 * structurally.
 *
 * SHADOW MODE (the step-3 build): the pass performs nothing. It
 * computes the full plan — the filings it would write, the sweeps
 * it would run — and diffs it against medina-dev's actual star
 * records: a planned filing is `matched` when the record on disk is
 * field-for-field the record the plan writes; a planned sweep is
 * `matched` when the expired record is already gone (or still
 * inside the grace window, `pending`). Nothing is written anywhere
 * but the stage's own notebook (the StarsShadow Durable Object).
 *
 * LIVE MODE (the step-3 cutover): the pass performs the plan —
 * filings through the artifact ledger (bucket write, then index
 * registration, the milestone-3 seam rule), sweeps as
 * receipt-first-then-delete, exactly the server's order — and then
 * the shadow diff runs over the result, so the notebook keeps
 * verifying the stage after the flip. Which mode runs is the
 * STAR_DETECTOR_MODE deploy variable; shadow is the default and
 * the rollback position.
 *
 * Failure semantics mirror the server's: a transcript or star
 * record that cannot be decoded fails the pass (the server's
 * detector fails the same pass the same way, and its loop logs and
 * retries); a filing failure stops the pass before the sweep, as
 * the server's sequential filing does.
 *
 * Structure, as in src/capture.ts: the top half is the domain
 * (parser, record shapes, the plan — pure but for the content
 * hash), the bottom half is the platform layer (Effect services
 * over the R2 bindings and the notebook Durable Object).
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  DayIndex,
  Star,
  StarForgetReceipt,
  Transcript,
} from "../../lib/lifelog/Resources.ts";
import {
  ArtifactLedger,
  NotebookError,
  sha256Hex,
  type ArtifactReadError,
  type DurableObjectNamespaceLike,
  type IndexRequestError,
} from "./capture.ts";
import {
  ArtifactCatalog,
  type CatalogBucketLike,
  type CatalogError,
} from "./catalog.ts";

// ---------------------------------------------------------------------------
// Domain: keys and constants (ports of lib/lifelog/Resources.ts)
// ---------------------------------------------------------------------------

/** Default lifetime of a voice star, in seconds (Resources.ts). */
export const DEFAULT_STAR_RETENTION_SECONDS = 3600;

export const starKey = (id: string): string => `star/${id}.json`;
export const starForgetReceiptKey = (contentHash: string): string =>
  `provenance/star/${contentHash}.json`;

/**
 * The speaker label that identifies Scott himself (DayIndex.ts):
 * today only the on-device channel is self-attributable — it does
 * not diarize, so its utterances are unlabeled (speaker: null).
 */
export const SPEAKER_SELF_ID: string | null = null;

/** The default window for a bare "star": two minutes (StarDetector.ts). */
const DEFAULT_WINDOW_SECONDS = 120;

// ---------------------------------------------------------------------------
// Domain: the parser — an exact port of lib/lifelog/StarDetector.ts.
// Parity demands the same verdicts, so this mirrors the original
// check by check; the only change is the content hash, which is
// asynchronous in the Workers runtime (crypto.subtle), so detection
// returns an Effect.
// ---------------------------------------------------------------------------

/** One transcript as the detector sees it (StarDetector.ts). */
export interface TranscriptFile {
  readonly captureId: string;
  /** The capture's start, ISO UTC, from the day index entry. */
  readonly startTime: string;
  readonly transcript: Transcript;
}

export interface DetectedStarCommand {
  readonly starId: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly name: string | null;
  readonly utteranceText: string;
}

const FILLERS: ReadonlySet<string> = new Set(["ok", "okay", "hey"]);

/** A token stripped of the punctuation transcription wraps words in. */
const bareToken = (token: string): string =>
  token.replace(/^[\s"'“”‘’(\[{<]+|[\s"'“”‘’.,!?;:)}\]>]+$/g, "");

/** Seconds named by the text after "the last", or null. */
const lastSpanSeconds = (afterLast: string): number | null => {
  const amount =
    /^(\d+(?:\.\d+)?)\s*(minutes?|mins?|seconds?|secs?|hours?|hrs?)\b/.exec(
      afterLast,
    );
  if (amount) {
    const value = Number(amount[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = amount[2]!;
    return unit.startsWith("min")
      ? value * 60
      : unit.startsWith("sec")
        ? value
        : value * 3600;
  }
  if (/^half (an )?hour\b/.test(afterLast)) return 30 * 60;
  if (/^minute\b/.test(afterLast)) return 60;
  if (/^hour\b/.test(afterLast)) return 3600;
  if (/^second\b/.test(afterLast)) return 1;
  return null;
};

/** The star's name from the words after "star" (StarDetector.ts). */
const starName = (afterStar: string): string | null => {
  const quoted = /["“'‘]([^"“”'’]{1,80})["“”'’]/.exec(afterStar);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const as = /\bas\b\s+(.+)$/i.exec(afterStar);
  if (as?.[1]) {
    const name = as[1].trim().replace(/[.!?;,]+$/, "").trim();
    if (name) return name;
  }
  return null;
};

/**
 * Parse one transcript's self utterances into star commands — the
 * server's `detectStarCommands`, verbatim but for the hash.
 */
export const detectStarCommands = (
  file: TranscriptFile,
): Effect.Effect<ReadonlyArray<DetectedStarCommand>> =>
  Effect.gen(function* () {
    const captureStart = Date.parse(file.startTime);
    if (Number.isNaN(captureStart)) return [];
    const commands: Array<DetectedStarCommand> = [];
    for (const utterance of file.transcript.utterances) {
      if (utterance.speaker !== SPEAKER_SELF_ID) continue;
      const text = utterance.text.trim();
      if (!text) continue;
      const tokens = text.split(/\s+/);
      let head = 0;
      if (
        tokens.length > 1 &&
        FILLERS.has(bareToken(tokens[0]!).toLowerCase())
      ) {
        head = 1;
      }
      if (bareToken(tokens[head]!).toLowerCase() !== "star") continue;

      const utteranceStartUtc = new Date(
        captureStart + utterance.startMs,
      ).toISOString();
      const utteranceEndMs = captureStart + utterance.endMs;
      const utteranceEndUtc = new Date(utteranceEndMs).toISOString();
      const afterStar = text
        .slice(text.indexOf(tokens[head]!) + tokens[head]!.length)
        .trim();
      const normalized = afterStar.toLowerCase();
      const last = /^the last\s+(.+)$/.exec(normalized);
      const spanSeconds = last ? lastSpanSeconds(last[1]!) : null;
      const startUtc =
        spanSeconds !== null
          ? new Date(
              utteranceEndMs - Math.round(spanSeconds * 1000),
            ).toISOString()
          : new Date(
              captureStart +
                utterance.startMs -
                DEFAULT_WINDOW_SECONDS * 1000,
            ).toISOString();
      const starId = (yield* Effect.promise(() =>
        sha256Hex(`${file.captureId}:${utteranceStartUtc}:${text}`),
      )).slice(0, 32);
      commands.push({
        starId,
        startUtc,
        endUtc: utteranceEndUtc,
        name: starName(afterStar),
        utteranceText: text,
      });
    }
    return commands;
  });

/**
 * The record a filing writes (Stars.ts `setStar` with the
 * detector's inputs): visibility defaults to private, createdAt
 * rides the utterance end. Serialized exactly as the server's
 * store writes it — the schema class instance through
 * JSON.stringify with two-space indent (Files.ts `writeJson`).
 */
export const starRecordFor = (command: DetectedStarCommand): Star =>
  new Star({
    id: command.starId,
    startUtc: command.startUtc,
    endUtc: command.endUtc,
    name: command.name,
    note: command.utteranceText,
    visibility: "private",
    retentionSeconds: DEFAULT_STAR_RETENTION_SECONDS,
    createdAt: command.endUtc,
    createdVia: "voice",
  });

export const starJson = (star: Star): string =>
  JSON.stringify(star, null, 2);

/** The instant a star stops existing (Stars.ts `starExpiresAt`). */
export const starExpiresAt = (star: Star): number | null => {
  const created = Date.parse(star.createdAt);
  return Number.isNaN(created)
    ? null
    : created + star.retentionSeconds * 1000;
};

/**
 * The canonical JSON whose hash names a star's public artifact
 * (Stars.ts `publicStarCanonicalJson`): field order is fixed by
 * construction. The retention sweep's receipt hashes the authored
 * content under this function with an empty evidence projection —
 * the service-level forget has no index at hand.
 */
export const forgetReceiptFor = (
  star: Star,
  deletedAt: string,
): Effect.Effect<{ key: string; json: string }> =>
  Effect.gen(function* () {
    const canonical = JSON.stringify({
      id: star.id,
      startUtc: star.startUtc,
      endUtc: star.endUtc,
      name: star.name,
      note: star.note,
      createdAt: star.createdAt,
      transcriptKeys: [] as Array<string>,
      excerpt: null,
    });
    const contentHash = yield* Effect.promise(() => sha256Hex(canonical));
    const receipt = new StarForgetReceipt({
      contentHash,
      createdAt: star.createdAt,
      deletedAt,
      retentionSeconds: star.retentionSeconds,
      reason: "expired",
    });
    return {
      key: starForgetReceiptKey(contentHash),
      json: JSON.stringify(receipt, null, 2),
    };
  });

// ---------------------------------------------------------------------------
// Domain: the plan — what one pass files and sweeps, computed from
// the gathered inputs exactly as detectAndFileStarsIn +
// sweepExpired compute it from theirs.
// ---------------------------------------------------------------------------

export interface StarFiling {
  readonly command: DetectedStarCommand;
  readonly star: Star;
  readonly key: string;
  readonly json: string;
}

export interface StarSweep {
  readonly star: Star;
  readonly receiptKey: string;
  readonly receiptJson: string;
}

export interface StarsPlan {
  readonly filings: ReadonlyArray<StarFiling>;
  /** Commands whose default retention already ran out: never filed. */
  readonly bornExpired: ReadonlyArray<DetectedStarCommand>;
  readonly sweeps: ReadonlyArray<StarSweep>;
  /** Existing records the sweep leaves alone. */
  readonly liveRecords: number;
}

export const planStars = (
  files: ReadonlyArray<TranscriptFile>,
  existing: ReadonlyArray<Star>,
  now: Date,
): Effect.Effect<StarsPlan> =>
  Effect.gen(function* () {
    const filings: Array<StarFiling> = [];
    const bornExpired: Array<DetectedStarCommand> = [];
    for (const file of files) {
      const commands = yield* detectStarCommands(file);
      for (const command of commands) {
        // Born expired: left unfiled, never written, never revived.
        if (
          Date.parse(command.endUtc) +
            DEFAULT_STAR_RETENTION_SECONDS * 1000 <=
          now.getTime()
        ) {
          bornExpired.push(command);
          continue;
        }
        const star = starRecordFor(command);
        filings.push({
          command,
          star,
          key: starKey(star.id),
          json: starJson(star),
        });
      }
    }
    const sweeps: Array<StarSweep> = [];
    let liveRecords = 0;
    for (const star of existing) {
      const expiry = starExpiresAt(star);
      if (expiry !== null && expiry <= now.getTime()) {
        const receipt = yield* forgetReceiptFor(star, now.toISOString());
        sweeps.push({
          star,
          receiptKey: receipt.key,
          receiptJson: receipt.json,
        });
      } else {
        liveRecords++;
      }
    }
    return { filings, bornExpired, sweeps, liveRecords };
  });

/** Field-for-field record equality — the shadow's `matched` test. */
export const sameStarRecord = (a: Star, b: Star): boolean =>
  a.id === b.id &&
  a.startUtc === b.startUtc &&
  a.endUtc === b.endUtc &&
  a.name === b.name &&
  a.note === b.note &&
  a.visibility === b.visibility &&
  a.retentionSeconds === b.retentionSeconds &&
  a.createdAt === b.createdAt &&
  a.createdVia === b.createdVia;

/** The first field on which two records differ (for diff details). */
export const starRecordDifference = (a: Star, b: Star): string => {
  const fields: Array<[string, unknown, unknown]> = [
    ["startUtc", a.startUtc, b.startUtc],
    ["endUtc", a.endUtc, b.endUtc],
    ["name", a.name, b.name],
    ["note", a.note, b.note],
    ["visibility", a.visibility, b.visibility],
    ["retentionSeconds", a.retentionSeconds, b.retentionSeconds],
    ["createdAt", a.createdAt, b.createdAt],
    ["createdVia", a.createdVia, b.createdVia],
  ];
  for (const [name, mine, theirs] of fields) {
    if (mine !== theirs) {
      return `${name}: plan ${JSON.stringify(mine)} vs record ${JSON.stringify(theirs)}`;
    }
  }
  return "records differ";
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export class StarsReport extends Schema.Class<StarsReport>("StarsReport")({
  ranAt: Schema.String,
  mode: Schema.Literals(["cron", "manual"]),
  /** The day-index snapshot the pass read (null when none exists). */
  indexBuiltAt: Schema.NullOr(Schema.String),
  indexInputHash: Schema.NullOr(Schema.String),
  entries: Schema.Number,
  transcripts: Schema.Number,
  commands: Schema.Number,
  filings: Schema.Number,
  bornExpired: Schema.Number,
  filingsMatched: Schema.Number,
  filingsPending: Schema.Number,
  filingsMismatched: Schema.Number,
  /** Voice records on disk the plan does not explain. */
  serverOnly: Schema.Number,
  serverOnlyPending: Schema.Number,
  sweepPlanned: Schema.Number,
  sweepPending: Schema.Number,
  sweepMismatched: Schema.Number,
  /** Live authored (API) records — informational; never the plan's. */
  apiRecords: Schema.Number,
  performedFiled: Schema.Number,
  performedSwept: Schema.Number,
  mismatches: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      id: Schema.String,
      detail: Schema.String,
    }),
  ),
}) {}

export interface StarsShadowOptions {
  readonly mode: "cron" | "manual";
  readonly now: Date;
  /** A divergence younger than this is pending, not a mismatch. */
  readonly staleAfterMs: number;
  /** Counts from a live pass that ran just before this diff. */
  readonly performed?: { readonly filed: number; readonly swept: number };
}

export interface StarsLiveSummary {
  readonly indexBuiltAt: string | null;
  readonly commands: number;
  readonly filed: number;
  readonly bornExpired: number;
  readonly swept: number;
  /** The first perform failure, when the pass stopped early. */
  readonly failure: string | null;
}

// ---------------------------------------------------------------------------
// Platform: typed errors
// ---------------------------------------------------------------------------

export class StarsDataError extends Data.TaggedError("StarsDataError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

type StarsError =
  | StarsDataError
  | CatalogError
  | ArtifactReadError
  | IndexRequestError
  | NotebookError;

// ---------------------------------------------------------------------------
// Platform: services
// ---------------------------------------------------------------------------

/**
 * The detector's inputs: the persisted day-index snapshot, the
 * transcripts it names, and the authored star records — all read
 * from the artifact bucket with the server's failure semantics (a
 * record that cannot be decoded fails the read, as `Files.readJson`
 * fails on the server).
 */
export class StarsData extends Context.Service<
  StarsData,
  {
    /** The newest day-index snapshot, journal.ts's selection rule. */
    readonly loadIndex: Effect.Effect<
      {
        readonly index: DayIndex;
        readonly builtAt: string;
        readonly inputHash: string;
      } | null,
      StarsDataError | CatalogError | ArtifactReadError
    >;
    /** One transcript by artifact key; null when absent. */
    readonly readTranscript: (
      key: string,
    ) => Effect.Effect<
      Transcript | null,
      StarsDataError | ArtifactReadError
    >;
    /** Every authored star record, in the server's read order. */
    readonly listStars: Effect.Effect<
      ReadonlyArray<Star>,
      StarsDataError | CatalogError | ArtifactReadError
    >;
  }
>()("medina-cloudflare/StarsData") {}

/** The stage's own notebook (the StarsShadow Durable Object). */
export class StarsNotebook extends Context.Service<
  StarsNotebook,
  {
    readonly record: (
      report: StarsReport,
    ) => Effect.Effect<void, NotebookError>;
    readonly latest: Effect.Effect<
      Option.Option<StarsReport>,
      NotebookError
    >;
  }
>()("medina-cloudflare/StarsNotebook") {}

export interface StarsEnv {
  readonly artifacts: CatalogBucketLike;
  readonly notebook: DurableObjectNamespaceLike;
}

export const STARS_SHADOW_DO_NAME = "stars-shadow-v1";

export const starsPlatformLayer = (
  env: StarsEnv,
): Layer.Layer<StarsData | StarsNotebook, never, ArtifactLedger | ArtifactCatalog> =>
  Layer.effect(
    StarsData,
    Effect.gen(function* () {
      const ledger = yield* ArtifactLedger;
      const catalog = yield* ArtifactCatalog;

      const readDecoded = <A>(
        key: string,
        what: string,
        decode: (json: unknown) => Effect.Effect<A, unknown>,
      ): Effect.Effect<A | null, StarsDataError | ArtifactReadError> =>
        Effect.gen(function* () {
          const text = yield* ledger.readText(key);
          if (Option.isNone(text)) return null;
          const json = yield* Effect.try({
            try: () => JSON.parse(text.value) as unknown,
            catch: (cause) =>
              new StarsDataError({
                message: `${what} at ${key} is not valid JSON`,
                cause,
              }),
          });
          return yield* decode(json).pipe(
            Effect.mapError(
              (cause) =>
                new StarsDataError({
                  message: `${what} at ${key} does not decode`,
                  cause,
                }),
            ),
          );
        });

      return {
        loadIndex: Effect.gen(function* () {
          const listed = yield* catalog.listAll("index/days-v1");
          const candidates = listed
            .filter((object) => object.key.endsWith(".json"))
            .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
            .slice(0, 3);
          let best: {
            index: DayIndex;
            builtAt: string;
            inputHash: string;
          } | null = null;
          for (const candidate of candidates) {
            const index = yield* readDecoded(
              candidate.key,
              "day-index snapshot",
              (json) => Schema.decodeUnknownEffect(DayIndex)(json),
            ).pipe(Effect.catch(() => Effect.succeed(null)));
            if (
              index !== null &&
              (best === null || index.builtAt > best.builtAt)
            ) {
              best = {
                index,
                builtAt: index.builtAt,
                inputHash: index.inputHash,
              };
            }
          }
          return best;
        }),
        readTranscript: (key) =>
          readDecoded(key, "transcript", (json) =>
            Schema.decodeUnknownEffect(Transcript)(json),
          ),
        listStars: Effect.gen(function* () {
          const listed = yield* catalog.listAll("star");
          const stars: Array<Star> = [];
          for (const object of listed) {
            if (!object.key.endsWith(".json")) continue;
            const star = yield* readDecoded(
              object.key,
              "star record",
              (json) => Schema.decodeUnknownEffect(Star)(json),
            );
            if (star !== null) stars.push(star);
          }
          // The server's read order (Stars.ts `readAllStars`).
          return stars.sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          );
        }),
      };
    }),
  ).pipe(
    Layer.merge(
      Layer.succeed(StarsNotebook, {
        record: (report) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(STARS_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://stars-shadow/report", {
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
                message: "recording a stars report failed",
                cause,
              }),
          }),
        latest: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(STARS_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://stars-shadow/status"),
            );
            if (!response.ok) {
              throw new Error(`notebook status answered ${response.status}`);
            }
            const body = (await response.json()) as {
              lastReport?: StarsReport | null;
            };
            return body.lastReport != null
              ? Option.some(body.lastReport)
              : Option.none<StarsReport>();
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading the stars notebook failed",
              cause,
            }),
        }),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The gather: index → the two UTC days' transcripts, in the server's
// iteration order (yesterday first, entries in index order).
// ---------------------------------------------------------------------------

interface StarsGather {
  readonly indexBuiltAt: string | null;
  readonly indexInputHash: string | null;
  readonly entries: number;
  readonly transcripts: number;
  readonly files: ReadonlyArray<TranscriptFile>;
  readonly existing: ReadonlyArray<Star>;
}

const gatherStars = (
  now: Date,
): Effect.Effect<
  StarsGather,
  StarsError,
  ArtifactLedger | ArtifactCatalog | StarsData
> =>
  Effect.gen(function* () {
    const data = yield* StarsData;
    const loaded = yield* data.loadIndex;
    const todayUtc = now.toISOString().slice(0, 10);
    const yesterdayUtc = new Date(now.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const files: Array<TranscriptFile> = [];
    let entries = 0;
    if (loaded !== null) {
      for (const day of [yesterdayUtc, todayUtc]) {
        for (const entry of loaded.index.days[day] ?? []) {
          entries++;
          const transcript = yield* data.readTranscript(
            entry.transcriptKey,
          );
          if (transcript === null) continue;
          files.push({
            captureId: entry.captureId,
            startTime: entry.startTime,
            transcript,
          });
        }
      }
    }
    const existing = yield* data.listStars;
    return {
      indexBuiltAt: loaded?.builtAt ?? null,
      indexInputHash: loaded?.inputHash ?? null,
      entries,
      transcripts: files.length,
      files,
      existing,
    };
  });

// ---------------------------------------------------------------------------
// The passes
// ---------------------------------------------------------------------------

const MAX_STORED_MISMATCHES = 100;

export const runStarsShadowPass = (
  options: StarsShadowOptions,
): Effect.Effect<
  StarsReport,
  StarsError,
  ArtifactLedger | ArtifactCatalog | StarsData | StarsNotebook
> =>
  Effect.gen(function* () {
    const notebook = yield* StarsNotebook;
    const now = options.now;
    const gathered = yield* gatherStars(now);
    const plan = yield* planStars(gathered.files, gathered.existing, now);
    const existingById = new Map(
      gathered.existing.map((star) => [star.id, star]),
    );

    let filingsMatched = 0;
    let filingsPending = 0;
    let filingsMismatched = 0;
    let serverOnly = 0;
    let serverOnlyPending = 0;
    let sweepPending = 0;
    let sweepMismatched = 0;
    const mismatches: Array<{
      kind: string;
      id: string;
      detail: string;
    }> = [];
    const note = (kind: string, id: string, detail: string): void => {
      if (mismatches.length < MAX_STORED_MISMATCHES) {
        mismatches.push({ kind, id, detail });
      }
    };
    const age = (iso: string): number => now.getTime() - Date.parse(iso);

    const plannedIds = new Set<string>();
    for (const filing of plan.filings) {
      plannedIds.add(filing.star.id);
      const record = existingById.get(filing.star.id);
      if (record === undefined) {
        if (age(filing.command.endUtc) <= options.staleAfterMs) {
          filingsPending++;
        } else {
          filingsMismatched++;
          note(
            "missing-record",
            filing.star.id,
            `command ended ${filing.command.endUtc}; no star record on disk`,
          );
        }
      } else if (sameStarRecord(filing.star, record)) {
        filingsMatched++;
      } else {
        filingsMismatched++;
        note(
          "record-differs",
          filing.star.id,
          starRecordDifference(filing.star, record),
        );
      }
    }
    for (const command of plan.bornExpired) {
      plannedIds.add(command.starId);
      if (existingById.has(command.starId)) {
        filingsMismatched++;
        note(
          "revived-record",
          command.starId,
          "a born-expired command has a record on disk",
        );
      }
    }
    const sweptIds = new Set(plan.sweeps.map((sweep) => sweep.star.id));
    for (const star of gathered.existing) {
      if (star.createdVia !== "voice" || plannedIds.has(star.id)) continue;
      if (sweptIds.has(star.id)) continue;
      // A voice record the plan does not explain: either the server
      // filed it from a transcript the snapshot has not caught up
      // with (pending while it is young), or the two detectors
      // genuinely diverge.
      if (age(star.createdAt) <= options.staleAfterMs) {
        serverOnlyPending++;
      } else {
        serverOnly++;
        note(
          "server-only",
          star.id,
          `voice record created ${star.createdAt} is not in the plan`,
        );
      }
    }
    for (const sweep of plan.sweeps) {
      const expiry = starExpiresAt(sweep.star);
      if (
        expiry !== null &&
        now.getTime() - expiry <= options.staleAfterMs
      ) {
        sweepPending++;
      } else {
        sweepMismatched++;
        note(
          "sweep-missed",
          sweep.star.id,
          `record expired at ${expiry === null ? "?" : new Date(expiry).toISOString()} and is still on disk`,
        );
      }
    }

    const report = new StarsReport({
      ranAt: now.toISOString(),
      mode: options.mode,
      indexBuiltAt: gathered.indexBuiltAt,
      indexInputHash: gathered.indexInputHash,
      entries: gathered.entries,
      transcripts: gathered.transcripts,
      commands: plan.filings.length + plan.bornExpired.length,
      filings: plan.filings.length,
      bornExpired: plan.bornExpired.length,
      filingsMatched,
      filingsPending,
      filingsMismatched,
      serverOnly,
      serverOnlyPending,
      sweepPlanned: plan.sweeps.length,
      sweepPending,
      sweepMismatched,
      apiRecords: gathered.existing.filter(
        (star) => star.createdVia === "api",
      ).length,
      performedFiled: options.performed?.filed ?? 0,
      performedSwept: options.performed?.swept ?? 0,
      mismatches,
    });
    yield* notebook.record(report);
    return report;
  });

/**
 * The live pass: perform the plan with the server's sequencing —
 * every filing (each an unconditional overwrite, as `setStar`
 * writes), then the sweep (receipt first, then the record's
 * removal). A perform failure stops the pass where the server's
 * would stop; the summary says how far it got.
 */
export const runStarsLivePass = (
  options: { readonly now: Date },
): Effect.Effect<
  StarsLiveSummary,
  StarsError,
  ArtifactLedger | ArtifactCatalog | StarsData
> =>
  Effect.gen(function* () {
    const ledger = yield* ArtifactLedger;
    const now = options.now;
    const gathered = yield* gatherStars(now);
    const plan = yield* planStars(gathered.files, gathered.existing, now);
    let filed = 0;
    let swept = 0;
    let failure: string | null = null;
    for (const filing of plan.filings) {
      const outcome = yield* ledger
        .writeText(filing.key, filing.json)
        .pipe(
          Effect.map(() => null),
          Effect.catch((error) =>
            Effect.succeed(`filing ${filing.star.id} failed: ${String(error).slice(0, 300)}`),
          ),
        );
      if (outcome !== null) {
        failure = outcome;
        break;
      }
      filed++;
    }
    if (failure === null) {
      for (const sweep of plan.sweeps) {
        const outcome = yield* Effect.gen(function* () {
          yield* ledger.writeText(sweep.receiptKey, sweep.receiptJson);
          yield* ledger.remove(starKey(sweep.star.id));
          return null;
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(
              `sweeping ${sweep.star.id} failed: ${String(error).slice(0, 300)}`,
            ),
          ),
        );
        if (outcome !== null) {
          failure = outcome;
          break;
        }
        swept++;
      }
    }
    return {
      indexBuiltAt: gathered.indexBuiltAt,
      commands: plan.filings.length + plan.bornExpired.length,
      filed,
      bornExpired: plan.bornExpired.length,
      swept,
      failure,
    };
  });

// ---------------------------------------------------------------------------
// StarsShadow: the stage's notebook Durable Object. One instance
// holds the recent pass reports, in its own SQLite storage — the
// only state the shadow writes. (The CaptureShadow pattern.)
// ---------------------------------------------------------------------------

interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>;
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

export class StarsShadow {
  private readonly sql: SqlStorageLike;

  constructor(state: DurableObjectStateLike) {
    this.sql = state.storage.sql;
    void state.blockConcurrencyWhile(async () => {
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
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const rows = this.sql
        .exec(`SELECT report FROM reports ORDER BY id DESC LIMIT 1`)
        .toArray();
      const countRows = this.sql
        .exec(`SELECT COUNT(*) AS n FROM reports`)
        .toArray();
      const lastReport =
        rows.length > 0 && typeof rows[0]?.["report"] === "string"
          ? (JSON.parse(rows[0]["report"] as string) as unknown)
          : null;
      return new Response(
        JSON.stringify({
          runCount: Number(countRows[0]?.["n"] ?? 0),
          lastReport,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
}
