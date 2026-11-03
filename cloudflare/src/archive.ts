/**
 * The archive sweep on the Medina Worker (migration milestone 4,
 * step 4 — docs/cloudflare-migration.md §4.3 step 4).
 *
 * This is the Worker's port of medina-dev's archive guarantee
 * (lib/capture/Archive.ts): every capture's files must exist in the
 * archive bucket, and a per-capture receipt (`archive/archive-v1/
 * <captureId>.json`) records what the bucket is known to hold. The
 * receipt is a cache of bucket state, not the truth: when it is
 * missing or stale the sweep asks the bucket (`head`) before
 * uploading, so a lost receipt re-verifies instead of re-uploading.
 * Both paths are idempotent — content-addressed keys mean a double
 * upload writes the same bytes.
 *
 * In the current deployment the artifact store and the archive
 * bucket are the same bucket (sco-lifelog, bound as ARTIFACTS), so
 * the reconciliation reads the capture tree from the store side and
 * heads it on the archive side of the same binding; a head that
 * agrees on size settles the file, and the sweep's durable output
 * is the receipt itself (written through the artifact ledger:
 * bucket write, then index registration — the milestone-3 seam
 * rule). The move itself is implemented honestly for the divergent
 * case: copy first, receipt last, so an interrupted pass can strand
 * nothing — a file the receipt does not name is simply reconciled
 * again next pass, and a copy without a receipt re-verifies by
 * head instead of re-copying.
 *
 * Decision-for-decision port of `archiveCapture`: a file whose
 * receipt entry carries the same size is carried untouched; any
 * other file is head-checked, then uploaded; the receipt is
 * rewritten exactly when it was absent or at least one file was
 * re-verified or uploaded (a rewrite rebuilds the file list from
 * the current listing, so entries for vanished files drop out on
 * the next rewrite — and only then, as on the server).
 *
 * SHADOW MODE (the step-4 build): the pass performs nothing — no
 * copies, no receipt writes. It computes each capture's plan and
 * diffs it against medina-dev's actual receipts: `matched` when
 * the stored receipt already says exactly what the plan settles
 * on, `ghost` when the receipt additionally names files that have
 * left the capture (the server's own quirk, counted separately),
 * `pending` when a capture young enough explains why the sweep
 * has not settled it yet, and a mismatch when a settled capture's
 * receipt would have to change under the server's own rules.
 *
 * LIVE MODE (the step-4 cutover): the pass performs the plans —
 * copies before receipts, receipt last — over a bounded work
 * selection each tick: captures with no receipt first (the
 * guarantee's actual frontier), then a round-robin slice of the
 * settled census so re-verification never stops. Which mode runs
 * is the ARCHIVE_SWEEP_MODE deploy variable; shadow is the
 * default and the rollback position.
 *
 * Structure, as in src/capture.ts: the domain (receipt shapes,
 * the reconciliation plan) sits above the platform layer (Effect
 * services over the R2 binding, the ledger, and the notebook
 * Durable Object).
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
  type ArtifactReadError,
  type DurableObjectNamespaceLike,
  type IndexRequestError,
} from "./capture.ts";
import {
  ArtifactCatalog,
  type CatalogBucketLike,
  type CatalogError,
  type CatalogHead,
} from "./catalog.ts";

// ---------------------------------------------------------------------------
// Domain: receipt shapes and keys (ports of lib/capture/Archive.ts)
// ---------------------------------------------------------------------------

export const ARCHIVE_VERSION = "archive-v1";

export const archiveReceiptKey = (captureId: string): string =>
  `archive/${ARCHIVE_VERSION}/${captureId}.json`;

export const captureDir = (captureId: string): string =>
  `capture/${captureId}`;

/** One file of a capture as the bucket listing reports it. */
export interface CaptureFile {
  readonly name: string;
  readonly size: number;
  /** Bucket lastModified — the freshness clock for pending verdicts. */
  readonly uploaded: Date;
}

export interface ArchivedFileShape {
  readonly name: string;
  readonly size: number;
  readonly etag: string | null;
  readonly uploadedAt: string;
}

export interface ArchiveReceiptShape {
  readonly captureId: string;
  readonly files: ReadonlyArray<ArchivedFileShape>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/**
 * Decode a stored receipt (ArchiveReceipt's shape). Null for
 * anything malformed — the caller treats that as the server's
 * decode failure: the item errors, it is never silently rebuilt.
 */
export const parseArchiveReceipt = (
  raw: unknown,
): ArchiveReceiptShape | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw["captureId"] !== "string") return null;
  if (!Array.isArray(raw["files"])) return null;
  const files: Array<ArchivedFileShape> = [];
  for (const entry of raw["files"]) {
    if (!isRecord(entry)) return null;
    if (typeof entry["name"] !== "string") return null;
    if (typeof entry["size"] !== "number") return null;
    if (entry["etag"] !== null && typeof entry["etag"] !== "string") {
      return null;
    }
    if (typeof entry["uploadedAt"] !== "string") return null;
    files.push({
      name: entry["name"],
      size: entry["size"],
      etag: entry["etag"] as string | null,
      uploadedAt: entry["uploadedAt"],
    });
  }
  return { captureId: raw["captureId"], files };
};

/** The receipt's stored bytes (the server's writeJson formatting). */
export const archiveReceiptJson = (receipt: ArchiveReceiptShape): string =>
  JSON.stringify(
    {
      captureId: receipt.captureId,
      files: receipt.files.map((file) => ({
        name: file.name,
        size: file.size,
        etag: file.etag,
        uploadedAt: file.uploadedAt,
      })),
    },
    null,
    2,
  );

/** The content type an archive upload stamps (Archive.ts). */
export const archiveContentTypeFor = (
  name: string,
): string | undefined => {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return {
    json: "application/json",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    aac: "audio/aac",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    csv: "text/csv",
    txt: "text/plain",
  }[extension];
};

// ---------------------------------------------------------------------------
// Domain: the reconciliation plan for one capture — archiveCapture's
// decision logic, pure over gathered inputs. Heads are fetched by
// the caller only for files the receipt cannot carry, exactly the
// server's ask-the-bucket-only-when-stale discipline.
// ---------------------------------------------------------------------------

export interface ArchivePlan {
  readonly captureId: string;
  /** The receipt the sweep settles on (entries in listing order). */
  readonly entries: ReadonlyArray<ArchivedFileShape>;
  /** Files to copy into the archive bucket before receipting. */
  readonly uploads: ReadonlyArray<string>;
  /** Whether the receipt is (re)written: absent, or a file changed. */
  readonly rewrite: boolean;
  /** Receipt entries naming files no longer in the capture. */
  readonly ghosts: ReadonlyArray<string>;
}

export const planArchiveCapture = (
  captureId: string,
  listed: ReadonlyArray<CaptureFile>,
  receipt: ArchiveReceiptShape | null,
  heads: ReadonlyMap<string, CatalogHead | null>,
  nowIso: string,
): ArchivePlan => {
  const known = new Map(
    (receipt?.files ?? []).map((file) => [file.name, file] as const),
  );
  const listedNames = new Set(listed.map((file) => file.name));
  const ghosts = [...known.keys()].filter((name) => !listedNames.has(name));
  const entries: Array<ArchivedFileShape> = [];
  const uploads: Array<string> = [];
  let changed = false;
  for (const file of listed) {
    const existing = known.get(file.name);
    if (existing !== undefined && existing.size === file.size) {
      entries.push(existing);
      continue;
    }
    const remote = heads.get(file.name);
    if (remote !== undefined && remote !== null && remote.size === file.size) {
      entries.push({
        name: file.name,
        size: file.size,
        etag: remote.etag,
        uploadedAt: remote.uploaded ?? nowIso,
      });
      changed = true;
      continue;
    }
    entries.push({
      name: file.name,
      size: file.size,
      etag: null,
      uploadedAt: nowIso,
    });
    uploads.push(file.name);
    changed = true;
  }
  return {
    captureId,
    entries,
    uploads,
    rewrite: changed || receipt === null,
    ghosts,
  };
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export class ArchiveReport extends Schema.Class<ArchiveReport>(
  "ArchiveReport",
)({
  ranAt: Schema.String,
  mode: Schema.Literals(["cron", "manual"]),
  /** Census over the whole bucket, not just the checked slice. */
  totalCaptures: Schema.Number,
  totalReceipts: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  /** The next round-robin offset after this pass. */
  cursor: Schema.Number,
  checked: Schema.Number,
  matched: Schema.Number,
  ghosts: Schema.Number,
  pending: Schema.Number,
  mismatched: Schema.Number,
  wouldUpload: Schema.Number,
  performedReceipts: Schema.Number,
  performedCopies: Schema.Number,
  mismatches: Schema.Array(
    Schema.Struct({
      captureId: Schema.String,
      kind: Schema.String,
      detail: Schema.String,
    }),
  ),
  errors: Schema.Array(
    Schema.Struct({ captureId: Schema.String, detail: Schema.String }),
  ),
}) {}

export interface ArchivePassOptions {
  readonly mode: "cron" | "manual";
  readonly now: Date;
  /** Captures processed this pass (the work bound). */
  readonly limit: number;
  /** Slice start for shadow runs; live runs select their own work. */
  readonly offset?: number;
  /** A capture younger than this is pending, not a mismatch. */
  readonly staleAfterMs: number;
  /** Live runs only: perform the plans instead of only diffing. */
  readonly perform: boolean;
}

export interface ArchiveLiveSummary {
  readonly receiptsWritten: number;
  readonly copies: number;
  readonly errors: ReadonlyArray<{
    readonly captureId: string;
    readonly detail: string;
  }>;
}

// ---------------------------------------------------------------------------
// Platform: typed errors
// ---------------------------------------------------------------------------

export class ArchiveDataError extends Data.TaggedError("ArchiveDataError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

type ArchiveError =
  | ArchiveDataError
  | CatalogError
  | ArtifactReadError
  | IndexRequestError
  | NotebookError;

// ---------------------------------------------------------------------------
// Platform: services
// ---------------------------------------------------------------------------

/**
 * The sweep's view of the world: capture directories and their
 * files from the store side of the bucket, archive-side heads, the
 * stored receipts, and byte access for the move.
 */
export class ArchiveData extends Context.Service<
  ArchiveData,
  {
    /** Every capture id in the bucket, ascending. */
    readonly captureIds: Effect.Effect<
      ReadonlyArray<string>,
      CatalogError
    >;
    /** Every receipted capture id in the bucket. */
    readonly receiptIds: Effect.Effect<
      ReadonlyArray<string>,
      CatalogError
    >;
    /** One capture's files, ascending by name. */
    readonly listFiles: (
      captureId: string,
    ) => Effect.Effect<ReadonlyArray<CaptureFile>, CatalogError>;
    /** The archive-side head of one capture file. */
    readonly headFile: (
      captureId: string,
      name: string,
    ) => Effect.Effect<CatalogHead | null, CatalogError>;
    /** One capture's stored receipt text; null when absent. */
    readonly readReceiptText: (
      captureId: string,
    ) => Effect.Effect<string | null, ArtifactReadError>;
    /** The store-side bytes of one capture file (for the move). */
    readonly readFileBytes: (
      captureId: string,
      name: string,
    ) => Effect.Effect<Uint8Array, ArchiveDataError>;
    /** The move: write bytes to the archive side; resolves to the etag. */
    readonly copyFile: (
      captureId: string,
      name: string,
      bytes: Uint8Array,
    ) => Effect.Effect<string | null, CatalogError>;
  }
>()("medina-cloudflare/ArchiveData") {}

/** The stage's own notebook (the ArchiveShadow Durable Object). */
export class ArchiveNotebook extends Context.Service<
  ArchiveNotebook,
  {
    readonly record: (
      report: ArchiveReport,
    ) => Effect.Effect<void, NotebookError>;
    readonly latest: Effect.Effect<
      Option.Option<ArchiveReport>,
      NotebookError
    >;
    /** The round-robin cursor over the settled census. */
    readonly cursor: Effect.Effect<number, NotebookError>;
    readonly setCursor: (
      cursor: number,
    ) => Effect.Effect<void, NotebookError>;
  }
>()("medina-cloudflare/ArchiveNotebook") {}

export interface ArchiveEnv {
  readonly artifacts: CatalogBucketLike & {
    get(
      key: string,
    ): Promise<{
      readonly body: ReadableStream;
      arrayBuffer(): Promise<ArrayBuffer>;
    } | null>;
  };
  readonly notebook: DurableObjectNamespaceLike;
}

export const ARCHIVE_SHADOW_DO_NAME = "archive-shadow-v1";

export const archivePlatformLayer = (
  env: ArchiveEnv,
): Layer.Layer<
  ArchiveData | ArchiveNotebook,
  never,
  ArtifactLedger | ArtifactCatalog
> =>
  Layer.effect(
    ArchiveData,
    Effect.gen(function* () {
      const ledger = yield* ArtifactLedger;
      const catalog = yield* ArtifactCatalog;
      return {
        captureIds: Effect.map(
          catalog.listPrefixes("capture/"),
          (prefixes) =>
            prefixes
              .map((prefix) => prefix.slice("capture/".length).replace(/\/$/, ""))
              .filter((id) => id.length > 0)
              .sort(),
        ),
        receiptIds: Effect.map(
          catalog.listAll(`archive/${ARCHIVE_VERSION}`),
          (objects) =>
            objects
              .map((object) =>
                object.key
                  .slice(`archive/${ARCHIVE_VERSION}/`.length)
                  .replace(/\.json$/, ""),
              )
              .filter((id) => id.length > 0)
              .sort(),
        ),
        listFiles: (captureId) =>
          Effect.map(
            catalog.listAll(`${captureDir(captureId)}/`),
            (objects) =>
              objects.map((object) => ({
                name: object.key.slice(captureDir(captureId).length + 1),
                size: object.size,
                uploaded: object.uploaded,
              })),
          ),
        headFile: (captureId, name) =>
          catalog.head(`${captureDir(captureId)}/${name}`),
        readReceiptText: (captureId) =>
          Effect.map(
            ledger.readText(archiveReceiptKey(captureId)),
            (text) => (Option.isSome(text) ? text.value : null),
          ),
        readFileBytes: (captureId, name) => {
          const key = `${captureDir(captureId)}/${name}`;
          return Effect.tryPromise({
            try: async () => {
              const object = await env.artifacts.get(key);
              if (object === null) {
                throw new Error(`capture file vanished before archival: ${key}`);
              }
              return new Uint8Array(await object.arrayBuffer());
            },
            catch: (cause) =>
              new ArchiveDataError({
                message: `reading ${key} for the archive move failed`,
                cause,
              }),
          });
        },
        copyFile: (captureId, name, bytes) =>
          catalog.putBytes(
            `${captureDir(captureId)}/${name}`,
            bytes,
            archiveContentTypeFor(name),
          ),
      };
    }),
  ).pipe(
    Layer.merge(
      Layer.succeed(ArchiveNotebook, {
        record: (report) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(ARCHIVE_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://archive-shadow/report", {
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
                message: "recording an archive report failed",
                cause,
              }),
          }),
        latest: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(ARCHIVE_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://archive-shadow/status"),
            );
            if (!response.ok) {
              throw new Error(`notebook status answered ${response.status}`);
            }
            const body = (await response.json()) as {
              lastReport?: ArchiveReport | null;
            };
            return body.lastReport != null
              ? Option.some(body.lastReport)
              : Option.none<ArchiveReport>();
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading the archive notebook failed",
              cause,
            }),
        }),
        cursor: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(ARCHIVE_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://archive-shadow/cursor"),
            );
            if (!response.ok) {
              throw new Error(`notebook cursor answered ${response.status}`);
            }
            const body = (await response.json()) as {
              cursor?: unknown;
            };
            return typeof body.cursor === "number" ? body.cursor : 0;
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading the archive cursor failed",
              cause,
            }),
        }),
        setCursor: (cursor) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(ARCHIVE_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://archive-shadow/cursor", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ cursor }),
                }),
              );
              if (!response.ok) {
                throw new Error(
                  `notebook cursor write answered ${response.status}`,
                );
              }
            },
            catch: (cause) =>
              new NotebookError({
                message: "writing the archive cursor failed",
                cause,
              }),
          }),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The pass: reconcile a bounded selection of captures.
// ---------------------------------------------------------------------------

const MAX_STORED_FINDINGS = 100;
/**
 * The largest file a live pass will buffer for the move. Aligned
 * buckets make copies unreachable in this deployment; the cap is
 * the guard rail for the divergent case (the server streams —
 * a Worker isolate cannot), so an oversized divergent file fails
 * its item and retries rather than exhausting the isolate.
 */
const MAX_COPY_BYTES = 128 * 1024 * 1024;

interface CaptureOutcome {
  readonly verdict:
    | "matched"
    | "ghost"
    | "pending"
    | "would-rewrite"
    | "would-upload"
    | "error";
  readonly detail: string;
  readonly receiptsWritten: number;
  readonly copies: number;
}

const reconcileOne = (
  captureId: string,
  options: { readonly now: Date; readonly staleAfterMs: number; readonly perform: boolean },
): Effect.Effect<
  CaptureOutcome,
  never,
  ArtifactLedger | ArtifactCatalog | ArchiveData
> =>
  Effect.gen(function* () {
    const data = yield* ArchiveData;
    const ledger = yield* ArtifactLedger;
    const nowIso = options.now.toISOString();
    const listed = yield* data.listFiles(captureId);
    if (listed.length === 0) {
      // The directory emptied between census and check: nothing to
      // reconcile (the server's archiveCapture resolves the same
      // vanished directory to a no-op).
      return { verdict: "matched" as const, detail: "capture directory is empty", receiptsWritten: 0, copies: 0 };
    }
    const receiptText = yield* data.readReceiptText(captureId);
    let receipt: ArchiveReceiptShape | null = null;
    if (receiptText !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(receiptText) as unknown;
      } catch {
        return {
          verdict: "error" as const,
          detail: "stored receipt is not valid JSON (the server's decode fails this item too)",
          receiptsWritten: 0,
          copies: 0,
        };
      }
      receipt = parseArchiveReceipt(parsed);
      if (receipt === null || receipt.captureId !== captureId) {
        return {
          verdict: "error" as const,
          detail: "stored receipt does not decode as an ArchiveReceipt for this capture",
          receiptsWritten: 0,
          copies: 0,
        };
      }
    }
    // Heads only for files the receipt cannot carry — the server's
    // ask-the-bucket-only-when-stale discipline.
    const known = new Map(
      (receipt?.files ?? []).map((file) => [file.name, file] as const),
    );
    const heads = new Map<string, CatalogHead | null>();
    for (const file of listed) {
      const existing = known.get(file.name);
      if (existing !== undefined && existing.size === file.size) continue;
      heads.set(file.name, yield* data.headFile(captureId, file.name));
    }
    const plan = planArchiveCapture(captureId, listed, receipt, heads, nowIso);

    if (!options.perform) {
      if (plan.uploads.length > 0) {
        return {
          verdict: "would-upload" as const,
          detail: `${plan.uploads.length} file(s) absent on the archive side: ${plan.uploads.slice(0, 3).join(", ")}`,
          receiptsWritten: 0,
          copies: 0,
        };
      }
      if (plan.rewrite) {
        const newest = Math.max(...listed.map((file) => file.uploaded.getTime()));
        if (options.now.getTime() - newest <= options.staleAfterMs) {
          return {
            verdict: "pending" as const,
            detail: receipt === null ? "no receipt yet; capture is fresh" : "receipt is stale; capture is fresh",
            receiptsWritten: 0,
            copies: 0,
          };
        }
        return {
          verdict: "would-rewrite" as const,
          detail: receipt === null
            ? "no receipt for a settled capture"
            : "receipt does not carry every listed file at its listed size",
          receiptsWritten: 0,
          copies: 0,
        };
      }
      if (plan.ghosts.length > 0) {
        return {
          verdict: "ghost" as const,
          detail: `receipt names ${plan.ghosts.length} vanished file(s): ${plan.ghosts.slice(0, 3).join(", ")}`,
          receiptsWritten: 0,
          copies: 0,
        };
      }
      return { verdict: "matched" as const, detail: "receipt carries every file at its listed size", receiptsWritten: 0, copies: 0 };
    }

    // Live: copies first (verified by the put's own etag), the
    // receipt last — an interruption anywhere before the receipt
    // leaves the capture to be reconciled again, never stranded.
    let copies = 0;
    const entries = [...plan.entries];
    for (const name of plan.uploads) {
      const file = listed.find((candidate) => candidate.name === name);
      if (file === undefined) continue;
      if (file.size > MAX_COPY_BYTES) {
        return {
          verdict: "error" as const,
          detail: `${name} is ${file.size} bytes — past the move's buffer cap; the item retries`,
          receiptsWritten: 0,
          copies,
        };
      }
      const bytes = yield* data.readFileBytes(captureId, name);
      const etag = yield* data.copyFile(captureId, name, bytes);
      copies++;
      const index = entries.findIndex((entry) => entry.name === name);
      if (index >= 0) {
        entries[index] = { ...entries[index]!, etag, uploadedAt: nowIso };
      }
    }
    let receiptsWritten = 0;
    if (plan.rewrite) {
      yield* ledger.writeText(
        archiveReceiptKey(captureId),
        archiveReceiptJson({ captureId, files: entries }),
      );
      receiptsWritten = 1;
    }
    return {
      verdict: "matched" as const,
      detail: plan.rewrite ? "reconciled and receipted" : "already settled",
      receiptsWritten,
      copies,
    };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        verdict: "error" as const,
        detail: String(error).slice(0, 300),
        receiptsWritten: 0,
        copies: 0,
      }),
    ),
  );

export const runArchivePass = (
  options: ArchivePassOptions,
): Effect.Effect<
  ArchiveReport,
  ArchiveError,
  ArtifactLedger | ArtifactCatalog | ArchiveData | ArchiveNotebook
> =>
  Effect.gen(function* () {
    const data = yield* ArchiveData;
    const notebook = yield* ArchiveNotebook;
    const ids = yield* data.captureIds;
    const receipted = new Set(yield* data.receiptIds);

    // Work selection. Live passes take the frontier first —
    // captures with no receipt, the guarantee's open edge — then
    // the round-robin slice of the settled census. Shadow passes
    // take the caller's slice of the census (the cron rotates its
    // offset; a manual run names its own), so a full-coverage diff
    // is a sequence of slices over the same ordering.
    let selected: Array<string>;
    let cursor = 0;
    let usedOffset = 0;
    if (options.perform) {
      const frontier = ids.filter((id) => !receipted.has(id));
      const start = yield* notebook.cursor;
      const settled = ids.filter((id) => receipted.has(id));
      const taken = frontier.slice(0, options.limit);
      const budget = options.limit - taken.length;
      const slice: Array<string> = [];
      for (let i = 0; i < settled.length && slice.length < budget; i++) {
        slice.push(settled[(start + i) % settled.length]!);
      }
      cursor =
        settled.length === 0
          ? 0
          : (start + slice.length) % settled.length;
      selected = [...taken, ...slice];
      yield* notebook.setCursor(cursor);
    } else {
      const offset = options.offset ?? (yield* notebook.cursor);
      usedOffset = offset;
      selected = ids.slice(offset, offset + options.limit);
      cursor = ids.length === 0 ? 0 : (offset + selected.length) % ids.length;
      if (options.mode === "cron") {
        yield* notebook.setCursor(cursor);
      }
    }

    let matched = 0;
    let ghosts = 0;
    let pending = 0;
    let mismatched = 0;
    let wouldUpload = 0;
    let performedReceipts = 0;
    let performedCopies = 0;
    const mismatches: Array<{
      captureId: string;
      kind: string;
      detail: string;
    }> = [];
    const errors: Array<{ captureId: string; detail: string }> = [];
    for (const captureId of selected) {
      const outcome = yield* reconcileOne(captureId, {
        now: options.now,
        staleAfterMs: options.staleAfterMs,
        perform: options.perform,
      });
      performedReceipts += outcome.receiptsWritten;
      performedCopies += outcome.copies;
      switch (outcome.verdict) {
        case "matched":
          matched++;
          break;
        case "ghost":
          ghosts++;
          break;
        case "pending":
          pending++;
          break;
        case "would-rewrite":
          mismatched++;
          if (mismatches.length < MAX_STORED_FINDINGS) {
            mismatches.push({ captureId, kind: outcome.verdict, detail: outcome.detail });
          }
          break;
        case "would-upload":
          wouldUpload++;
          mismatched++;
          if (mismatches.length < MAX_STORED_FINDINGS) {
            mismatches.push({ captureId, kind: outcome.verdict, detail: outcome.detail });
          }
          break;
        case "error":
          if (errors.length < MAX_STORED_FINDINGS) {
            errors.push({ captureId, detail: outcome.detail });
          }
          break;
      }
    }

    const report = new ArchiveReport({
      ranAt: options.now.toISOString(),
      mode: options.mode,
      totalCaptures: ids.length,
      totalReceipts: receipted.size,
      offset: usedOffset,
      limit: options.limit,
      cursor,
      checked: selected.length,
      matched,
      ghosts,
      pending,
      mismatched,
      wouldUpload,
      performedReceipts,
      performedCopies,
      mismatches,
      errors,
    });
    yield* notebook.record(report);
    return report;
  });

// ---------------------------------------------------------------------------
// ArchiveShadow: the stage's notebook Durable Object — recent pass
// reports plus the round-robin cursor, in its own SQLite storage.
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

export class ArchiveShadow {
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
        `CREATE TABLE IF NOT EXISTS meta (
           k TEXT PRIMARY KEY,
           v TEXT NOT NULL
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
    if (request.method === "GET" && url.pathname === "/cursor") {
      const rows = this.sql
        .exec(`SELECT v FROM meta WHERE k = 'cursor'`)
        .toArray();
      const cursor =
        rows.length > 0 && typeof rows[0]?.["v"] === "string"
          ? Number(rows[0]["v"])
          : 0;
      return new Response(
        JSON.stringify({ cursor: Number.isFinite(cursor) ? cursor : 0 }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (request.method === "POST" && url.pathname === "/cursor") {
      const body = (await request.json().catch(() => ({}))) as {
        cursor?: unknown;
      };
      const cursor =
        typeof body.cursor === "number" && Number.isFinite(body.cursor)
          ? Math.max(0, Math.floor(body.cursor))
          : 0;
      this.sql.exec(
        `INSERT INTO meta (k, v) VALUES ('cursor', ?)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        String(cursor),
      );
      return new Response(JSON.stringify({ ok: true, cursor }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
}
