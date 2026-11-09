/**
 * The day-index resource on the Medina Worker (migration
 * milestone 4, step 8 — docs/cloudflare-migration.md §4.3 step 8,
 * the day-index piece): which captures with usable transcripts
 * belong to which journal day, in start-time order, written as
 * the content-addressed snapshot `index/days-v1/<inputHash>.json`
 * that serving already reads. Ported from lib/lifelog/DayIndex.ts
 * with its attribution engine (lib/lifelog/Attribution.ts) and the
 * pure start-time decision (lib/lifelog/StartTime.ts, ported
 * verbatim below — it has no imports by design).
 *
 * The server's freshness scheme is the design: the snapshot key
 * bakes in a hash over (capture id, correction hash, selected
 * transcript key) pairs plus the home zone, and each capture's
 * attribution lives at a key baking in its own basis hash
 * (attribution version, zone, correction hash, rules digest).
 * Existence at the key IS freshness, on both implementations, so
 * a Worker-written snapshot stands the server's resource down
 * for that basis, and the two can interleave safely.
 *
 * What the Worker adds is the incremental bookkeeping the §5
 * redesign calls for: medina-dev recomputes the basis from
 * scratch every pass (reading two transcript JSONs per capture —
 * the "DayIndex tax"). The notebook (DayIndexShadow DO) caches,
 * per capture, the listing tokens (etag/size) of its transcript
 * files with the selection they produced, and per capture the
 * attribution fields for the current basis hash. A pass lists
 * the transcript directory once, re-reads only files whose token
 * changed, and recomputes only attributions whose basis moved —
 * steady state is two listings and a handful of reads, and the
 * computed input hash is exactly the server's.
 *
 * The start-time rules are the library defaults: the app's own
 * hints layer (example-lifelog/StartTimeHints.ts) adds no
 * patterns and no rules today, so the digests agree. If hints
 * are ever added there, they must be mirrored here in the same
 * commit — the basis hash will otherwise diverge and shadow
 * passes will report it.
 *
 * One honest narrowing: container timing (mvhd) is read from the
 * cached `capture/<id>/media-timing.json` artifact only. The
 * server probes the blob when the cache is absent; post-flip
 * blobs are not on its disk, so for any capture the server has
 * already attributed the cache exists, and for the rest the
 * server's probe increasingly finds nothing either. A capture
 * whose attribution would change on a first probe shows up as a
 * shadow mismatch naming the capture — visible, not silent.
 *
 * SHADOW MODE (the step-8 build): the pass performs nothing. It
 * computes the current basis and compares the server's snapshot
 * at that basis, entry for entry, when one exists; a missing
 * snapshot is pending (the server builds on its own cadence),
 * never a mismatch by itself.
 *
 * LIVE MODE (the step-8 cutover): the pass writes the
 * attribution artifacts it computed (only when absent) and the
 * snapshot for the current basis (only when absent), and
 * medina-dev's attribution + day-index resources stand down via
 * MEDINA_SOURCES in the same batch. Rollback is the reverse.
 *
 * Structure, as in src/gps.ts: the domain sits above the
 * platform layer.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
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
  type IndexRequestError,
} from "./capture.ts";
import {
  ArtifactCatalog,
  type CatalogBucketLike,
  type CatalogError,
} from "./catalog.ts";

// ---------------------------------------------------------------------------
// Domain: keys and shapes (ports of lib/lifelog/Resources.ts)
// ---------------------------------------------------------------------------

export const TRANSCRIPT_VERSION = "assemblyai-u35p-v1";
export const ATTRIBUTION_VERSION = "attribution-v2";
export const DAY_INDEX_VERSION = "days-v1";
export const CHANNEL_MAIN = "main";
export const TRANSCRIPT_PREFIX = `transcript/${TRANSCRIPT_VERSION}`;

export const transcriptKey = (captureId: string): string =>
  `${TRANSCRIPT_PREFIX}/${captureId}.json`;
export const localTranscriptKey = (captureId: string): string =>
  `${TRANSCRIPT_PREFIX}/${captureId}.ondevice.json`;
export const liveTranscriptKey = (
  installId: string,
  segmentUuid: string,
): string => `${TRANSCRIPT_PREFIX}/live/${installId}/${segmentUuid}.json`;
export const provenanceKey = (captureId: string): string =>
  `capture/${captureId}/provenance.json`;
export const mediaTimingKey = (captureId: string): string =>
  `capture/${captureId}/media-timing.json`;
export const triageKey = (captureId: string): string =>
  `triage/${captureId}.json`;
export const attributionKey = (
  captureId: string,
  basisHash: string,
): string => `attribution/${ATTRIBUTION_VERSION}/${captureId}/${basisHash}.json`;
export const correctionKey = (captureId: string): string =>
  `correction/${captureId}.json`;
export const dayIndexKey = (inputHash: string): string =>
  `index/${DAY_INDEX_VERSION}/${inputHash}.json`;

const LIVE_CAPTURE_PREFIX = "live/";
export const parseLiveCaptureId = (
  captureId: string,
): { installId: string; segmentUuid: string } | null => {
  if (!captureId.startsWith(LIVE_CAPTURE_PREFIX)) return null;
  const rest = captureId.slice(LIVE_CAPTURE_PREFIX.length).split("/");
  const [installId, segmentUuid] = rest;
  if (rest.length !== 2 || !installId || !segmentUuid) return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      segmentUuid,
    )
  ) {
    return null;
  }
  return { installId, segmentUuid };
};

export interface DayEntryShape {
  readonly captureId: string;
  readonly transcriptKey: string;
  readonly startTime: string;
  readonly timeZone: string;
  readonly channel: string;
  readonly correctionHash: string | null;
}

export interface AttributionShape {
  readonly version: string;
  readonly captureId: string;
  readonly channel: string;
  readonly estimatedStartTime: string | null;
  readonly timeZone: string | null;
  readonly day: string | null;
  readonly method: string;
  readonly confidence: string;
}

export interface CorrectionShape {
  readonly estimatedStartTime?: string;
  readonly timeZone?: string;
  readonly channel?: string;
  readonly note?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const optionalString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * The capture-id derivation of transcribedCaptures, over the
 * transcript directory's relative entry names in ascending
 * order: the ids, in first-appearance order.
 */
export const deriveCaptureIds = (
  entries: ReadonlyArray<string>,
): Array<string> => {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (entry.endsWith(".assemblyai.json") || entry.endsWith(".jobs.json")) {
      continue;
    }
    if (entry.endsWith(".promoted.json")) continue;
    ids.add(entry.replace(/\.ondevice\.json$/, "").replace(/\.json$/, ""));
  }
  return [...ids];
};

/** usableTranscript: completed with non-empty text. */
export const usableTranscript = (parsed: unknown): boolean => {
  if (!isRecord(parsed)) return false;
  return (
    parsed["status"] === "completed" &&
    typeof parsed["text"] === "string" &&
    parsed["text"].trim() !== ""
  );
};

export const transcriptCapturedAt = (parsed: unknown): string | null =>
  isRecord(parsed) ? (optionalString(parsed["capturedAt"]) ?? null) : null;

export const parseCorrection = (parsed: unknown): CorrectionShape | null => {
  if (!isRecord(parsed)) return null;
  const correction: CorrectionShape = {
    ...(optionalString(parsed["estimatedStartTime"])
      ? { estimatedStartTime: parsed["estimatedStartTime"] as string }
      : {}),
    ...(optionalString(parsed["timeZone"])
      ? { timeZone: parsed["timeZone"] as string }
      : {}),
    ...(optionalString(parsed["channel"])
      ? { channel: parsed["channel"] as string }
      : {}),
    ...(optionalString(parsed["note"])
      ? { note: parsed["note"] as string }
      : {}),
  };
  return correction;
};

/** The day-index basis line for one capture. */
export const pairLine = (
  captureId: string,
  correctionHash: string | null,
  selectedKey: string | null,
): string => `${captureId}:${correctionHash ?? ""}:${selectedKey ?? ""}`;

export const canonicalEntry = (entry: DayEntryShape): string =>
  JSON.stringify([
    entry.captureId,
    entry.transcriptKey,
    entry.startTime,
    entry.timeZone,
    entry.channel,
    entry.correctionHash,
  ]);

// ---------------------------------------------------------------------------
// Domain: zone math (Intl-backed ports of the server's
// effect/DateTime uses in Attribution.ts / DayIndex.ts)
// ---------------------------------------------------------------------------

const zoneParts = (
  instant: Date,
  zone: string,
): Record<string, string> | null => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const out: Record<string, string> = {};
    for (const part of parts) out[part.type] = part.value;
    return out;
  } catch {
    return null;
  }
};

/** The civil day of an instant in a zone ("YYYY-MM-DD"). */
export const dayInZone = (isoUtc: string, zone: string): string | null => {
  const parts = zoneParts(new Date(isoUtc), zone);
  if (parts === null) return null;
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
};

/** DayIndex.wallClockInZone: an instant as local wall clock. */
export const wallClockInZone = (
  isoUtc: string,
  zone: string,
): { day: string; startTime: string } | null => {
  const parts = zoneParts(new Date(isoUtc), zone);
  if (parts === null) return null;
  const day = `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
  return {
    day,
    startTime: `${day}T${parts["hour"]}:${parts["minute"]}:${parts["second"]}`,
  };
};

/**
 * Attribution.wallToUtc: a naive wall clock ("YYYY-MM-DDTHH:mm:ss")
 * interpreted in a zone, as a UTC ISO instant. Two refinement
 * rounds settle the offset (the second absorbs DST-boundary
 * guesses); an unparseable wall clock or unknown zone is null,
 * matching makeZoned's failure.
 */
export const wallToUtc = (wallClock: string, zone: string): string | null => {
  const guessMs = Date.parse(`${wallClock}Z`);
  if (Number.isNaN(guessMs)) return null;
  const offsetAt = (ms: number): number | null => {
    const parts = zoneParts(new Date(ms), zone);
    if (parts === null) return null;
    const zonedAsUtc = Date.parse(
      `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}:${parts["second"]}Z`,
    );
    return zonedAsUtc - ms;
  };
  const first = offsetAt(guessMs);
  if (first === null) return null;
  const second = offsetAt(guessMs - first);
  if (second === null) return null;
  return new Date(guessMs - second).toISOString();
};

// ---------------------------------------------------------------------------
// Domain: decideStart — a verbatim port of lib/lifelog/StartTime.ts
// (pure by design; the digest below must produce the server's
// string for the default rules, which the hints layer leaves
// untouched).
// ---------------------------------------------------------------------------

export const AGREEMENT_WINDOW_SECONDS = 120;

export type ContainerConvention = "end" | "start" | "ignore";

export interface FilenamePattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly zone?: string;
}

export interface SourceRule {
  readonly name: string;
  readonly source?: RegExp;
  readonly filename?: RegExp;
  readonly from?: string;
  readonly until?: string;
  readonly container?: ContainerConvention;
  readonly zone?: string;
  readonly shiftSeconds?: number;
  readonly note?: string;
}

export interface StartTimeRules {
  readonly filenamePatterns: ReadonlyArray<FilenamePattern>;
  readonly container: ContainerConvention;
  readonly agreementWindowSeconds: number;
  readonly rules: ReadonlyArray<SourceRule>;
}

export const defaultStartTimeRules: StartTimeRules = {
  filenamePatterns: [
    { name: "medina-0-prefixed", pattern: /0(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/ },
    { name: "dated-separators", pattern: /(\d{4})[-_](\d{2})[-_](\d{2})[ T_](\d{2})[.:_-](\d{2})[.:_-](\d{2})/ },
    { name: "iso-basic", pattern: /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/ },
  ],
  container: "end",
  agreementWindowSeconds: AGREEMENT_WINDOW_SECONDS,
  rules: [],
};

export type StartMethod =
  | "filename-and-container"
  | "container-mvhd"
  | "filename-stamp"
  | "modified-time"
  | "none";

export interface StartEvidence {
  readonly source: string | null;
  readonly filename: string | null;
  readonly containerCreatedAt: string | null;
  readonly containerDurationSeconds: number | null;
  readonly legacyWallClock: string | null;
  readonly modifiedAt: string | null;
  readonly zone: string;
  readonly toUtc: (wallClock: string, zone: string) => string | null;
}

export interface StartDecision {
  readonly startUtc: string | null;
  readonly method: StartMethod;
  readonly confidence: "high" | "medium" | "low" | "none";
  readonly zone: string;
  readonly disagreementSeconds: number | null;
  readonly filenamePattern: string | null;
  readonly appliedRules: ReadonlyArray<string>;
}

export const matchFilenameStamp = (
  filename: string,
  patterns: ReadonlyArray<FilenamePattern>,
): { wallClock: string; pattern: FilenamePattern } | null => {
  for (const pattern of patterns) {
    const found = filename.match(pattern.pattern);
    if (!found) continue;
    const [, year, month, day, hour, minute, second] = found;
    if (!year || !month || !day || !hour || !minute || !second) continue;
    const wallClock = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
    if (Number.isNaN(Date.parse(`${wallClock}Z`))) continue;
    return { wallClock, pattern };
  }
  return null;
};

const secondsBetween = (a: string, b: string) =>
  Math.abs(Date.parse(a) - Date.parse(b)) / 1000;

const matchingRules = (
  rules: ReadonlyArray<SourceRule>,
  evidence: StartEvidence,
  probeUtc: string | null,
) =>
  rules.filter((rule) => {
    if (rule.source && !(evidence.source && rule.source.test(evidence.source))) {
      return false;
    }
    if (
      rule.filename &&
      !(evidence.filename && rule.filename.test(evidence.filename))
    ) {
      return false;
    }
    if (rule.from || rule.until) {
      if (!probeUtc) return false;
      const day = probeUtc.slice(0, 10);
      if (rule.from && day < rule.from) return false;
      if (rule.until && day >= rule.until) return false;
    }
    return true;
  });

export const decideStart = (
  evidence: StartEvidence,
  rules: StartTimeRules = defaultStartTimeRules,
): StartDecision => {
  const stamp = evidence.filename
    ? matchFilenameStamp(evidence.filename, rules.filenamePatterns)
    : null;

  const provisional =
    evidence.containerCreatedAt ??
    (stamp ? evidence.toUtc(stamp.wallClock, evidence.zone) : null) ??
    evidence.modifiedAt;

  const applied = matchingRules(rules.rules, evidence, provisional);
  const last = <A,>(pick: (rule: SourceRule) => A | undefined): A | undefined => {
    for (let index = applied.length - 1; index >= 0; index--) {
      const value = pick(applied[index]!);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const convention = last((rule) => rule.container) ?? rules.container;
  const ruleZone = last((rule) => rule.zone) ?? evidence.zone;
  const zone = stamp?.pattern.zone ?? ruleZone;
  const shift = applied.reduce((total, rule) => total + (rule.shiftSeconds ?? 0), 0);
  const appliedRules = applied.map((rule) => rule.name);

  const containerStartUtc = ((): string | null => {
    if (convention === "ignore" || !evidence.containerCreatedAt) return null;
    if (convention === "start") return evidence.containerCreatedAt;
    if (evidence.containerDurationSeconds === null) return null;
    const end = Date.parse(evidence.containerCreatedAt);
    if (Number.isNaN(end)) return null;
    return new Date(end - evidence.containerDurationSeconds * 1000).toISOString();
  })();

  const wallClock = stamp?.wallClock ?? evidence.legacyWallClock;
  const filenameUtc = wallClock ? evidence.toUtc(wallClock, zone) : null;

  const shifted = (iso: string) =>
    shift === 0 ? iso : new Date(Date.parse(iso) + shift * 1000).toISOString();

  const decide = (): Omit<StartDecision, "zone" | "filenamePattern" | "appliedRules"> => {
    if (filenameUtc && containerStartUtc) {
      const gap = secondsBetween(filenameUtc, containerStartUtc);
      if (gap <= rules.agreementWindowSeconds) {
        return {
          startUtc: filenameUtc,
          method: "filename-and-container",
          confidence: "high",
          disagreementSeconds: gap,
        };
      }
      const earlier =
        Date.parse(filenameUtc) <= Date.parse(containerStartUtc)
          ? filenameUtc
          : containerStartUtc;
      return {
        startUtc: earlier,
        method: earlier === filenameUtc ? "filename-stamp" : "container-mvhd",
        confidence: "medium",
        disagreementSeconds: gap,
      };
    }
    if (containerStartUtc) {
      return {
        startUtc: containerStartUtc,
        method: "container-mvhd",
        confidence: "high",
        disagreementSeconds: null,
      };
    }
    if (filenameUtc) {
      return {
        startUtc: filenameUtc,
        method: "filename-stamp",
        confidence: "medium",
        disagreementSeconds: null,
      };
    }
    if (evidence.modifiedAt && !Number.isNaN(Date.parse(evidence.modifiedAt))) {
      return {
        startUtc: new Date(evidence.modifiedAt).toISOString(),
        method: "modified-time",
        confidence: "low",
        disagreementSeconds: null,
      };
    }
    return { startUtc: null, method: "none", confidence: "none", disagreementSeconds: null };
  };

  const decided = decide();
  return {
    ...decided,
    startUtc: decided.startUtc === null ? null : shifted(decided.startUtc),
    zone,
    filenamePattern: stamp?.pattern.name ?? null,
    appliedRules,
  };
};

export const startTimeRulesDigest = (rules: StartTimeRules): string =>
  JSON.stringify({
    patterns: rules.filenamePatterns.map((entry) => [
      entry.name,
      entry.pattern.source,
      entry.zone ?? "",
    ]),
    container: rules.container,
    window: rules.agreementWindowSeconds,
    rules: rules.rules.map((rule) => [
      rule.name,
      rule.source?.source ?? "",
      rule.filename?.source ?? "",
      rule.from ?? "",
      rule.until ?? "",
      rule.container ?? "",
      rule.zone ?? "",
      rule.shiftSeconds ?? 0,
    ]),
  });

// ---------------------------------------------------------------------------
// Domain: attribution (a port of Attribution.attributeCapture's
// decision flow, over gathered evidence)
// ---------------------------------------------------------------------------

export interface AttributionEvidence {
  readonly provenanceSource: string | null;
  readonly provenanceFilename: string | null;
  readonly provenanceModifiedTime: string | null;
  readonly triageFilename: string | null;
  readonly triageReceivedAt: string | null;
  readonly legacyCapturedAt: string | null;
  readonly mediaCreatedAt: string | null;
  readonly mediaDurationSeconds: number | null;
}

/** attributeCapture, minus the write: the record it would store. */
export const computeAttribution = (
  captureId: string,
  evidence: AttributionEvidence,
  correction: CorrectionShape | null,
  zone: string,
  rules: StartTimeRules = defaultStartTimeRules,
): AttributionShape => {
  const decision = decideStart(
    {
      source: evidence.provenanceSource,
      filename: evidence.provenanceFilename ?? evidence.triageFilename,
      containerCreatedAt: evidence.mediaCreatedAt,
      containerDurationSeconds: evidence.mediaDurationSeconds,
      legacyWallClock: evidence.legacyCapturedAt,
      modifiedAt: evidence.provenanceModifiedTime ?? evidence.triageReceivedAt,
      zone,
      toUtc: wallToUtc,
    },
    rules,
  );

  let startUtc: string | null = decision.startUtc;
  let method: string = decision.method;
  const confidence = decision.confidence;

  let day: string | null = null;
  let timeZone: string | null = null;
  if (startUtc !== null) {
    day = dayInZone(startUtc, decision.zone);
    if (day !== null) timeZone = decision.zone;
  }

  if (correction !== null) {
    timeZone = correction.timeZone ?? timeZone ?? zone;
    if (correction.estimatedStartTime) startUtc = correction.estimatedStartTime;
    if (startUtc) {
      day = dayInZone(startUtc, timeZone) ?? day;
    }
    method = "correction";
  }

  return {
    version: ATTRIBUTION_VERSION,
    captureId,
    channel: correction?.channel ?? CHANNEL_MAIN,
    estimatedStartTime: startUtc,
    timeZone,
    day,
    method,
    confidence: method === "correction" ? "corrected" : confidence,
  };
};

// ---------------------------------------------------------------------------
// Reports and notebook cache rows
// ---------------------------------------------------------------------------

export interface SelectionRow {
  readonly captureId: string;
  /** Listing token (size:etag per file) this selection was made under. */
  readonly token: string;
  readonly selectedKey: string | null;
  /** The canonical transcript's capturedAt (the attribution legacy
   * clock), or the live provisional's — captured when the file was read. */
  readonly capturedAt: string | null;
}

export interface AttributionRow {
  readonly captureId: string;
  readonly basisHash: string;
  readonly day: string | null;
  readonly startTime: string | null;
  readonly timeZone: string | null;
  readonly channel: string;
}

export class DayIndexReport extends Schema.Class<DayIndexReport>(
  "DayIndexReport",
)({
  ranAt: Schema.String,
  mode: Schema.Literals(["cron", "manual"]),
  live: Schema.Boolean,
  captures: Schema.Number,
  changedSelections: Schema.Number,
  inputHash: Schema.String,
  /** "current" (a snapshot exists at this basis), "stale" (snapshots
   * exist, none at this basis), or "absent" (no snapshots at all). */
  snapshotState: Schema.String,
  daysCompared: Schema.Number,
  daysMatched: Schema.Number,
  daysMismatched: Schema.Number,
  attributionsComputed: Schema.Number,
  attributionsFromArtifact: Schema.Number,
  attributionsFromCache: Schema.Number,
  performedAttributions: Schema.Number,
  performedSnapshot: Schema.Boolean,
  mismatches: Schema.Array(
    Schema.Struct({
      day: Schema.String,
      kind: Schema.String,
      detail: Schema.String,
    }),
  ),
  errors: Schema.Array(
    Schema.Struct({ item: Schema.String, detail: Schema.String }),
  ),
}) {}

export interface DayIndexPassOptions {
  readonly mode: "cron" | "manual";
  readonly now: Date;
  /** The home zone (medina-dev's HOME_TZ): it participates in the basis. */
  readonly zone: string;
  readonly perform: boolean;
}

// ---------------------------------------------------------------------------
// Platform: typed errors
// ---------------------------------------------------------------------------

export class DayIndexDataError extends Data.TaggedError("DayIndexDataError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

type DayIndexError =
  | DayIndexDataError
  | CatalogError
  | ArtifactReadError
  | IndexRequestError
  | NotebookError;

// ---------------------------------------------------------------------------
// Platform: services
// ---------------------------------------------------------------------------

export interface DayIndexDataShape {
  /** Transcript directory entries (relative names) with listing
   * tokens, ascending. */
  readonly listTranscripts: Effect.Effect<
    ReadonlyArray<{ readonly entry: string; readonly token: string }>,
    CatalogError
  >;
  /** Correction file keys, ascending. */
  readonly listCorrectionKeys: Effect.Effect<
    ReadonlyArray<string>,
    CatalogError
  >;
  /** Snapshot keys under index/days-v1, ascending. */
  readonly listSnapshotKeys: Effect.Effect<
    ReadonlyArray<string>,
    CatalogError
  >;
  /** Parsed JSON at a key; null when absent or undecodable (the
   * server's Files.readJson Option semantics). */
  readonly readJson: (
    key: string,
  ) => Effect.Effect<unknown | null, ArtifactReadError>;
  readonly readText: (
    key: string,
  ) => Effect.Effect<string | null, ArtifactReadError>;
  readonly writeText: (
    key: string,
    text: string,
  ) => Effect.Effect<void, ArtifactReadError | IndexRequestError>;
}

export class DayIndexData extends Context.Service<
  DayIndexData,
  DayIndexDataShape
>()("medina-cloudflare/DayIndexData") {}

export class DayIndexNotebook extends Context.Service<
  DayIndexNotebook,
  {
    readonly record: (
      report: DayIndexReport,
    ) => Effect.Effect<void, NotebookError>;
    readonly latest: Effect.Effect<
      Option.Option<DayIndexReport>,
      NotebookError
    >;
    readonly selections: Effect.Effect<
      ReadonlyArray<SelectionRow>,
      NotebookError
    >;
    readonly applySelections: (
      upserts: ReadonlyArray<SelectionRow>,
      deletes: ReadonlyArray<string>,
    ) => Effect.Effect<void, NotebookError>;
    readonly attributions: Effect.Effect<
      ReadonlyArray<AttributionRow>,
      NotebookError
    >;
    readonly applyAttributions: (
      upserts: ReadonlyArray<AttributionRow>,
      deletes: ReadonlyArray<string>,
    ) => Effect.Effect<void, NotebookError>;
  }
>()("medina-cloudflare/DayIndexNotebook") {}

export interface DayIndexEnv {
  readonly artifacts: CatalogBucketLike;
  readonly notebook: DurableObjectNamespaceLike;
}

export const DAYINDEX_SHADOW_DO_NAME = "dayindex-shadow-v1";

export const dayIndexPlatformLayer = (
  env: DayIndexEnv,
): Layer.Layer<
  DayIndexData | DayIndexNotebook,
  never,
  ArtifactLedger | ArtifactCatalog
> =>
  Layer.effect(
    DayIndexData,
    Effect.gen(function* () {
      const ledger = yield* ArtifactLedger;
      const catalog = yield* ArtifactCatalog;
      return {
        listTranscripts: Effect.map(
          catalog.listAll(TRANSCRIPT_PREFIX),
          (objects) =>
            objects.map((object) => ({
              entry: object.key.slice(TRANSCRIPT_PREFIX.length + 1),
              token: `${object.size}:${object.etag}`,
            })),
        ),
        listCorrectionKeys: Effect.map(
          catalog.listAll("correction"),
          (objects) => objects.map((object) => object.key).sort(),
        ),
        listSnapshotKeys: Effect.map(
          catalog.listAll(`index/${DAY_INDEX_VERSION}`),
          (objects) => objects.map((object) => object.key).sort(),
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
        readText: (key) =>
          Effect.map(ledger.readText(key), (text) =>
            Option.isSome(text) ? text.value : null,
          ),
        writeText: (key, text) => ledger.writeText(key, text),
      };
    }),
  ).pipe(
    Layer.merge(
      Layer.succeed(DayIndexNotebook, {
        record: (report) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(DAYINDEX_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://dayindex-shadow/report", {
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
                message: "recording a day-index report failed",
                cause,
              }),
          }),
        latest: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(DAYINDEX_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://dayindex-shadow/status"),
            );
            if (!response.ok) {
              throw new Error(`notebook status answered ${response.status}`);
            }
            const body = (await response.json()) as {
              lastReport?: DayIndexReport | null;
            };
            return body.lastReport != null
              ? Option.some(body.lastReport)
              : Option.none<DayIndexReport>();
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading the day-index notebook failed",
              cause,
            }),
        }),
        selections: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(DAYINDEX_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://dayindex-shadow/selections"),
            );
            if (!response.ok) {
              throw new Error(
                `notebook selections answered ${response.status}`,
              );
            }
            const body = (await response.json()) as {
              selections?: ReadonlyArray<SelectionRow>;
            };
            return body.selections ?? [];
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading day-index selections failed",
              cause,
            }),
        }),
        applySelections: (upserts, deletes) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(DAYINDEX_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://dayindex-shadow/selections", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ upserts, deletes }),
                }),
              );
              if (!response.ok) {
                throw new Error(
                  `notebook selections write answered ${response.status}`,
                );
              }
            },
            catch: (cause) =>
              new NotebookError({
                message: "writing day-index selections failed",
                cause,
              }),
          }),
        attributions: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(DAYINDEX_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://dayindex-shadow/attributions"),
            );
            if (!response.ok) {
              throw new Error(
                `notebook attributions answered ${response.status}`,
              );
            }
            const body = (await response.json()) as {
              attributions?: ReadonlyArray<AttributionRow>;
            };
            return body.attributions ?? [];
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading day-index attributions failed",
              cause,
            }),
        }),
        applyAttributions: (upserts, deletes) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(DAYINDEX_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://dayindex-shadow/attributions", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ upserts, deletes }),
                }),
              );
              if (!response.ok) {
                throw new Error(
                  `notebook attributions write answered ${response.status}`,
                );
              }
            },
            catch: (cause) =>
              new NotebookError({
                message: "writing day-index attributions failed",
                cause,
              }),
          }),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

const MAX_STORED_FINDINGS = 100;

const sha256Text = (text: string): Effect.Effect<string> =>
  Effect.promise(() => sha256Hex(new TextEncoder().encode(text)));

const parseAttributionArtifact = (
  parsed: unknown,
): {
  day: string | null;
  startTime: string | null;
  timeZone: string | null;
  channel: string;
} | null => {
  if (!isRecord(parsed)) return null;
  if (typeof parsed["captureId"] !== "string") return null;
  return {
    day: optionalString(parsed["day"]) ?? null,
    startTime: optionalString(parsed["estimatedStartTime"]) ?? null,
    timeZone: optionalString(parsed["timeZone"]) ?? null,
    channel: optionalString(parsed["channel"]) ?? CHANNEL_MAIN,
  };
};

const gatherEvidence = (
  data: DayIndexDataShape,
  captureId: string,
  legacyCapturedAt: string | null,
): Effect.Effect<AttributionEvidence, ArtifactReadError> =>
  Effect.gen(function* () {
    const provenance = yield* data.readJson(provenanceKey(captureId));
    const triage = yield* data.readJson(triageKey(captureId));
    const media = yield* data.readJson(mediaTimingKey(captureId));
    const record =
      isRecord(provenance) && Array.isArray(provenance["records"])
        ? (provenance["records"] as Array<unknown>)[0]
        : undefined;
    return {
      provenanceSource: isRecord(record)
        ? (optionalString(record["source"]) ?? null)
        : null,
      provenanceFilename: isRecord(record)
        ? (optionalString(record["filename"]) ?? null)
        : null,
      provenanceModifiedTime: isRecord(record)
        ? (optionalString(record["modifiedTime"]) ?? null)
        : null,
      triageFilename: isRecord(triage)
        ? (optionalString(triage["filename"]) ?? null)
        : null,
      triageReceivedAt: isRecord(triage)
        ? (optionalString(triage["receivedAt"]) ?? null)
        : null,
      legacyCapturedAt,
      mediaCreatedAt: isRecord(media)
        ? (optionalString(media["createdAt"]) ?? null)
        : null,
      mediaDurationSeconds: isRecord(media)
        ? typeof media["durationSeconds"] === "number"
          ? (media["durationSeconds"] as number)
          : null
        : null,
    };
  });

export const runDayIndexPass = (
  options: DayIndexPassOptions,
): Effect.Effect<
  DayIndexReport,
  DayIndexError,
  ArtifactLedger | ArtifactCatalog | DayIndexData | DayIndexNotebook
> =>
  Effect.gen(function* () {
    const data = yield* DayIndexData;
    const notebook = yield* DayIndexNotebook;
    const zone = options.zone;
    const nowIso = options.now.toISOString();
    const mismatches: Array<{ day: string; kind: string; detail: string }> = [];
    const errors: Array<{ item: string; detail: string }> = [];

    // -- the transcript census and the selection cache
    const listing = yield* data.listTranscripts;
    const tokenByEntry = new Map(
      listing.map(({ entry, token }) => [entry, token] as const),
    );
    const ids = deriveCaptureIds(listing.map(({ entry }) => entry));
    const tokenFor = (captureId: string): string =>
      `${tokenByEntry.get(`${captureId}.json`) ?? ""}|${tokenByEntry.get(`${captureId}.ondevice.json`) ?? ""}`;

    // -- corrections: one listing, hashes over exact bytes
    const corrections = new Map<
      string,
      { hash: string; correction: CorrectionShape | null }
    >();
    for (const key of yield* data.listCorrectionKeys) {
      if (!key.endsWith(".json")) continue;
      const captureId = key.slice("correction/".length).replace(/\.json$/, "");
      const text = yield* data.readText(key);
      if (text === null) continue;
      let correction: CorrectionShape | null = null;
      try {
        correction = parseCorrection(JSON.parse(text) as unknown);
      } catch {
        correction = null;
      }
      corrections.set(captureId, {
        hash: yield* sha256Text(text),
        correction,
      });
    }

    const cachedSelections = new Map(
      (yield* notebook.selections).map(
        (row) => [row.captureId, row] as const,
      ),
    );
    // Cache upserts flush incrementally: the first pass over a
    // corpus refreshes every row, and a pass that dies mid-corpus
    // must keep the progress it already made — the next pass then
    // only re-reads what is still stale.
    let selectionUpserts: Array<SelectionRow> = [];
    const flushSelections = Effect.gen(function* () {
      if (selectionUpserts.length === 0) return;
      const batch = selectionUpserts;
      selectionUpserts = [];
      yield* notebook.applySelections(batch, []);
    });
    const capturedAtById = new Map<string, string | null>();
    let changedSelections = 0;
    const pairs: Array<{
      captureId: string;
      correctionHash: string | null;
      selectedKey: string | null;
    }> = [];
    for (const captureId of ids) {
      const token = tokenFor(captureId);
      const cached = cachedSelections.get(captureId);
      let selectedKey: string | null;
      let capturedAt: string | null;
      if (cached !== undefined && cached.token === token) {
        selectedKey = cached.selectedKey;
        capturedAt = cached.capturedAt;
      } else {
        changedSelections++;
        const live = parseLiveCaptureId(captureId);
        if (live !== null) {
          const key = liveTranscriptKey(live.installId, live.segmentUuid);
          const parsed = yield* data.readJson(key);
          selectedKey = usableTranscript(parsed) ? key : null;
          capturedAt = transcriptCapturedAt(parsed);
        } else {
          const canonical = yield* data.readJson(transcriptKey(captureId));
          capturedAt = transcriptCapturedAt(canonical);
          if (usableTranscript(canonical)) {
            selectedKey = transcriptKey(captureId);
          } else {
            const firstLook = yield* data.readJson(
              localTranscriptKey(captureId),
            );
            selectedKey = usableTranscript(firstLook)
              ? localTranscriptKey(captureId)
              : null;
          }
        }
        selectionUpserts.push({
          captureId,
          token,
          selectedKey,
          capturedAt,
        });
        if (selectionUpserts.length >= 200) yield* flushSelections;
      }
      capturedAtById.set(captureId, capturedAt);
      pairs.push({
        captureId,
        correctionHash: corrections.get(captureId)?.hash ?? null,
        selectedKey,
      });
    }
    const idSet = new Set(ids);
    const selectionDeletes = [...cachedSelections.keys()].filter(
      (captureId) => !idSet.has(captureId),
    );

    // -- the basis
    const inputHash = yield* sha256Text(
      [
        DAY_INDEX_VERSION,
        zone,
        ...pairs.map((pair) =>
          pairLine(pair.captureId, pair.correctionHash, pair.selectedKey),
        ),
      ].join("\n"),
    );
    const rulesDigest = startTimeRulesDigest(defaultStartTimeRules);

    // -- attributions and the day's entries
    const cachedAttributions = new Map(
      (yield* notebook.attributions).map(
        (row) => [row.captureId, row] as const,
      ),
    );
    let attributionUpserts: Array<AttributionRow> = [];
    const flushAttributions = Effect.gen(function* () {
      if (attributionUpserts.length === 0) return;
      const batch = attributionUpserts;
      attributionUpserts = [];
      yield* notebook.applyAttributions(batch, []);
    });
    let attributionsComputed = 0;
    let attributionsFromArtifact = 0;
    let attributionsFromCache = 0;
    let performedAttributions = 0;
    const days = new Map<string, Array<DayEntryShape>>();
    const place = (day: string, entry: DayEntryShape) => {
      const list = days.get(day) ?? [];
      list.push(entry);
      days.set(day, list);
    };
    for (const pair of pairs) {
      if (pair.selectedKey === null) continue;
      const live = parseLiveCaptureId(pair.captureId);
      if (live !== null) {
        const capturedAt = capturedAtById.get(pair.captureId) ?? null;
        if (capturedAt === null) continue;
        const wall = wallClockInZone(capturedAt, zone);
        if (wall === null) continue;
        place(wall.day, {
          captureId: pair.captureId,
          transcriptKey: pair.selectedKey,
          startTime: wall.startTime,
          timeZone: zone,
          channel: "audio",
          correctionHash: null,
        });
        continue;
      }
      const basisHash = yield* sha256Text(
        `${ATTRIBUTION_VERSION}\n${zone}\n${pair.correctionHash ?? ""}\n${rulesDigest}`,
      );
      const cached = cachedAttributions.get(pair.captureId);
      let fields: {
        day: string | null;
        startTime: string | null;
        timeZone: string | null;
        channel: string;
      } | null = null;
      if (cached !== undefined && cached.basisHash === basisHash) {
        fields = cached;
        attributionsFromCache++;
      } else {
        const artifact = parseAttributionArtifact(
          yield* data.readJson(attributionKey(pair.captureId, basisHash)),
        );
        if (artifact !== null) {
          fields = artifact;
          attributionsFromArtifact++;
        } else {
          const evidence = yield* gatherEvidence(
            data,
            pair.captureId,
            capturedAtById.get(pair.captureId) ?? null,
          );
          const shape = computeAttribution(
            pair.captureId,
            evidence,
            corrections.get(pair.captureId)?.correction ?? null,
            zone,
          );
          fields = {
            day: shape.day,
            startTime: shape.estimatedStartTime,
            timeZone: shape.timeZone,
            channel: shape.channel,
          };
          attributionsComputed++;
          if (options.perform) {
            yield* data.writeText(
              attributionKey(pair.captureId, basisHash),
              JSON.stringify({ ...shape, attributedAt: nowIso }, null, 2),
            );
            performedAttributions++;
          }
        }
        attributionUpserts.push({
          captureId: pair.captureId,
          basisHash,
          day: fields.day,
          startTime: fields.startTime,
          timeZone: fields.timeZone,
          channel: fields.channel,
        });
        if (attributionUpserts.length >= 200) yield* flushAttributions;
      }
      if (
        fields.day !== null &&
        fields.startTime !== null &&
        fields.timeZone !== null
      ) {
        place(fields.day, {
          captureId: pair.captureId,
          transcriptKey: pair.selectedKey,
          startTime: fields.startTime,
          timeZone: fields.timeZone,
          channel: fields.channel,
          correctionHash: pair.correctionHash,
        });
      }
    }
    const attributionDeletes = [...cachedAttributions.keys()].filter(
      (captureId) => !idSet.has(captureId),
    );
    for (const entries of days.values()) {
      entries.sort((a, b) => a.startTime.localeCompare(b.startTime));
    }

    // -- compare against the server's snapshot at this basis, or
    // (live) write ours when none exists
    const snapshotKeys = yield* data.listSnapshotKeys;
    const myKey = dayIndexKey(inputHash);
    const snapshotExists = snapshotKeys.includes(myKey);
    const snapshotState = snapshotExists
      ? "current"
      : snapshotKeys.length > 0
        ? "stale"
        : "absent";
    let daysCompared = 0;
    let daysMatched = 0;
    let daysMismatched = 0;
    if (snapshotExists) {
      const stored = yield* data.readJson(myKey);
      const storedDays: Record<string, Array<DayEntryShape>> =
        isRecord(stored) && isRecord(stored["days"])
          ? (stored["days"] as Record<string, Array<DayEntryShape>>)
          : {};
      const allDays = new Set([...days.keys(), ...Object.keys(storedDays)]);
      for (const day of [...allDays].sort()) {
        daysCompared++;
        const mine = new Set((days.get(day) ?? []).map(canonicalEntry));
        const theirs = new Set(
          (storedDays[day] ?? []).map((entry) =>
            canonicalEntry({
              captureId: String(entry.captureId),
              transcriptKey: String(entry.transcriptKey),
              startTime: String(entry.startTime),
              timeZone: String(entry.timeZone),
              channel: String(entry.channel),
              correctionHash:
                typeof entry.correctionHash === "string"
                  ? entry.correctionHash
                  : null,
            }),
          ),
        );
        const same =
          mine.size === theirs.size &&
          [...mine].every((line) => theirs.has(line));
        if (same) {
          daysMatched++;
        } else {
          daysMismatched++;
          if (mismatches.length < MAX_STORED_FINDINGS) {
            const onlyMine = [...mine].filter((line) => !theirs.has(line));
            const onlyTheirs = [...theirs].filter((line) => !mine.has(line));
            mismatches.push({
              day,
              kind: "entries",
              detail: `mine ${mine.size} vs stored ${theirs.size}; only-mine ${(onlyMine[0] ?? "-").slice(0, 140)}; only-stored ${(onlyTheirs[0] ?? "-").slice(0, 140)}`,
            });
          }
        }
      }
    }
    let performedSnapshot = false;
    if (options.perform && !snapshotExists) {
      const daysObject: Record<string, Array<DayEntryShape>> = {};
      for (const day of [...days.keys()].sort()) {
        daysObject[day] = days.get(day)!;
      }
      yield* data.writeText(
        myKey,
        JSON.stringify(
          {
            version: DAY_INDEX_VERSION,
            inputHash,
            builtAt: nowIso,
            days: daysObject,
          },
          null,
          2,
        ),
      );
      performedSnapshot = true;
    }

    yield* flushSelections;
    yield* flushAttributions;
    if (selectionDeletes.length > 0) {
      yield* notebook.applySelections([], selectionDeletes);
    }
    if (attributionDeletes.length > 0) {
      yield* notebook.applyAttributions([], attributionDeletes);
    }

    const report = new DayIndexReport({
      ranAt: nowIso,
      mode: options.mode,
      live: options.perform,
      captures: ids.length,
      changedSelections,
      inputHash,
      snapshotState,
      daysCompared,
      daysMatched,
      daysMismatched,
      attributionsComputed,
      attributionsFromArtifact,
      attributionsFromCache,
      performedAttributions,
      performedSnapshot,
      mismatches,
      errors,
    });
    yield* notebook.record(report);
    return report;
  });

// ---------------------------------------------------------------------------
// DayIndexShadow: the resource's notebook Durable Object — recent
// pass reports plus the two incremental caches (transcript
// selections, attribution fields), in its own SQLite storage.
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

const nullableText = (value: string | null): string | null => value;

export class DayIndexShadow {
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
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS selections (
           capture_id TEXT PRIMARY KEY,
           token TEXT NOT NULL,
           selected_key TEXT,
           captured_at TEXT
         )`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS attributions (
           capture_id TEXT PRIMARY KEY,
           basis_hash TEXT NOT NULL,
           day TEXT,
           start_time TEXT,
           time_zone TEXT,
           channel TEXT NOT NULL
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
    if (request.method === "GET" && url.pathname === "/selections") {
      const rows = this.sql
        .exec(
          `SELECT capture_id, token, selected_key, captured_at FROM selections`,
        )
        .toArray();
      const selections = rows.map((row) => ({
        captureId: String(row["capture_id"]),
        token: String(row["token"]),
        selectedKey:
          typeof row["selected_key"] === "string"
            ? (row["selected_key"] as string)
            : null,
        capturedAt:
          typeof row["captured_at"] === "string"
            ? (row["captured_at"] as string)
            : null,
      }));
      return new Response(JSON.stringify({ selections }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (request.method === "POST" && url.pathname === "/selections") {
      const body = (await request.json().catch(() => ({}))) as {
        upserts?: ReadonlyArray<SelectionRow>;
        deletes?: ReadonlyArray<string>;
      };
      for (const row of body.upserts ?? []) {
        this.sql.exec(
          `INSERT INTO selections (capture_id, token, selected_key, captured_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(capture_id) DO UPDATE SET
               token = excluded.token,
               selected_key = excluded.selected_key,
               captured_at = excluded.captured_at`,
          row.captureId,
          row.token,
          nullableText(row.selectedKey),
          nullableText(row.capturedAt),
        );
      }
      for (const captureId of body.deletes ?? []) {
        this.sql.exec(`DELETE FROM selections WHERE capture_id = ?`, captureId);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (request.method === "GET" && url.pathname === "/attributions") {
      const rows = this.sql
        .exec(
          `SELECT capture_id, basis_hash, day, start_time, time_zone, channel FROM attributions`,
        )
        .toArray();
      const attributions = rows.map((row) => ({
        captureId: String(row["capture_id"]),
        basisHash: String(row["basis_hash"]),
        day: typeof row["day"] === "string" ? (row["day"] as string) : null,
        startTime:
          typeof row["start_time"] === "string"
            ? (row["start_time"] as string)
            : null,
        timeZone:
          typeof row["time_zone"] === "string"
            ? (row["time_zone"] as string)
            : null,
        channel: String(row["channel"] ?? CHANNEL_MAIN),
      }));
      return new Response(JSON.stringify({ attributions }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (request.method === "POST" && url.pathname === "/attributions") {
      const body = (await request.json().catch(() => ({}))) as {
        upserts?: ReadonlyArray<AttributionRow>;
        deletes?: ReadonlyArray<string>;
      };
      for (const row of body.upserts ?? []) {
        this.sql.exec(
          `INSERT INTO attributions (capture_id, basis_hash, day, start_time, time_zone, channel)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(capture_id) DO UPDATE SET
               basis_hash = excluded.basis_hash,
               day = excluded.day,
               start_time = excluded.start_time,
               time_zone = excluded.time_zone,
               channel = excluded.channel`,
          row.captureId,
          row.basisHash,
          nullableText(row.day),
          nullableText(row.startTime),
          nullableText(row.timeZone),
          row.channel,
        );
      }
      for (const captureId of body.deletes ?? []) {
        this.sql.exec(
          `DELETE FROM attributions WHERE capture_id = ?`,
          captureId,
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
}
