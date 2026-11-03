/**
 * Media-transcribe on the Worker (migration milestone 4 step 6 —
 * docs/cloudflare-migration.md §4.3): the port of medina-dev's
 * media-transcribe stage (lib/capture/Media.ts
 * `mediaTranscribeSource` / `transcribeMediaCapture` +
 * lib/AssemblyAI.ts).
 *
 * What the stage does, unchanged: it consumes normalize's
 * manifests, never the original blobs. Each chunk is transcribed
 * by AssemblyAI separately — AssemblyAI fetches a presigned R2 URL
 * itself; Medina never uploads audio and never waits in-process.
 * A durable jobs receipt (transcript/<version>/<captureId>.jobs.json)
 * is committed after EVERY accepted job, so a pass submits only
 * where no receipt exists and later passes only poll the ids they
 * already paid for. When every chunk is terminal, the per-chunk
 * results merge with cumulative offsets into one canonical
 * Transcript; the raw vendor responses are kept beside it
 * ({chunked: true, chunks: [...]}). Partial success settles with
 * the completed chunks; all-silence settles as a completed empty
 * transcript; all-real-errors settles as errored (marker written,
 * receipt kept, no canonical transcript) so a failed file is never
 * re-bought. The vendor endpoint is https://api.assemblyai.com
 * directly — the exe.dev proxy retires with this stage.
 *
 * The paid-pipeline discipline is the stage's hard rule and is
 * structural here, not a comment: discovery excludes settled
 * captures and captures with a completed canonical transcript;
 * the item flow re-reads both before submitting anything; a
 * submission writes its receipt before the next chunk is touched.
 * There is exactly one submitter at any moment — medina-dev stands
 * down in the same change batch that flips this stage live.
 *
 * What the move changes: per-item failure isolation (the §4.2
 * hardening — on medina-dev a fully errored capture fails its
 * item inside a fail-fast forEach; here it is an outcome in the
 * report and the pass continues), and presigning from the
 * stack-minted bucket keypair with locally minted temporary
 * credentials (src/r2creds.ts) instead of the edge-injected mint.
 * A chunk missing from the bucket settles immediately: on
 * medina-dev the "missing from R2 but present locally" branch is
 * transient because a local store exists; here the bucket is the
 * only store, so absence is the permanent case by construction.
 *
 * Modes (TRANSCRIBE_MODE in alchemy.run.ts): "shadow" plans and
 * diffs against what medina-dev produced, submitting nothing;
 * "live" performs. The manual endpoint can also run one capture
 * as a PROOF: the full live flow with every write redirected
 * under transcript-proof/, so exactly one already-transcribed
 * capture can be re-run end-to-end and its text compared against
 * the canonical transcript — the one paid proof the rehearsal
 * allows itself.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  ArtifactLedger,
  type ArtifactReadError,
  type IndexRequestError,
  NotebookError,
} from "./capture.ts";
import {
  ArtifactCatalog,
  type CatalogError,
} from "./catalog.ts";
import {
  mediaManifestKey,
  parseMediaManifest,
  type MediaManifestShape,
} from "./normalize.ts";
import {
  accountIdFromEndpoint,
  mintTempCredentials,
  parseS3Credentials,
  presignGetUrl,
  type R2CredsError,
  type S3CredentialsValue,
} from "./r2creds.ts";

// ---------------------------------------------------------------------------
// Keys and constants — mirrors of the lib values they must agree with.
// ---------------------------------------------------------------------------

export const TRANSCRIPT_VERSION = "assemblyai-u35p-v1";
export const transcriptKey = (captureId: string) =>
  `transcript/${TRANSCRIPT_VERSION}/${captureId}.json`;
export const localTranscriptKey = (captureId: string) =>
  `transcript/${TRANSCRIPT_VERSION}/${captureId}.ondevice.json`;
export const vendorKey = (captureId: string) =>
  `transcript/${TRANSCRIPT_VERSION}/${captureId}.assemblyai.json`;
export const transcriptJobsKey = (captureId: string) =>
  `transcript/${TRANSCRIPT_VERSION}/${captureId}.jobs.json`;
export const transcriptSettledKey = (captureId: string) =>
  `transcribe-settled/${TRANSCRIPT_VERSION}/${captureId}.json`;
/** Chunk URLs live two hours (lib: presignGet(chunk.key, 2 * 60 * 60)). */
const CHUNK_URL_TTL_SECONDS = 2 * 60 * 60;
const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** lib's filenameWallClock (Resources.ts): the zone-less stamp a
 * recorder filename claims, or null. */
export const filenameWallClock = (filename: string): string | null => {
  const stamp = filename.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (stamp === null) return null;
  const [, year, month, day, hour, minute, second] = stamp;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
};

// ---------------------------------------------------------------------------
// Vendor transcripts: the projection of AssemblyAI's response Medina
// depends on (lib/transcribe/VendorTranscript.ts, decoded strictly —
// a shape violation fails the poll, as the server's decode does).
// ---------------------------------------------------------------------------

export interface VendorUtterance {
  readonly speaker: string | null;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly confidence: number | null;
}

export interface VendorTranscriptShape {
  readonly id: string;
  readonly status: "queued" | "processing" | "completed" | "error";
  readonly text: string | null;
  readonly utterances: ReadonlyArray<VendorUtterance> | null;
  readonly error: string | null;
}

const nullableString = (value: unknown): string | null | undefined =>
  value === undefined || value === null
    ? (value as null | undefined)
    : typeof value === "string"
      ? value
      : undefined;

export const projectVendorTranscript = (
  raw: unknown,
): VendorTranscriptShape | null => {
  const body = record(raw);
  if (typeof body["id"] !== "string") return null;
  const status = body["status"];
  if (
    status !== "queued" &&
    status !== "processing" &&
    status !== "completed" &&
    status !== "error"
  ) {
    return null;
  }
  const rawText = body["text"];
  if (
    rawText !== undefined &&
    rawText !== null &&
    typeof rawText !== "string"
  ) {
    return null;
  }
  const rawError = body["error"];
  if (
    rawError !== undefined &&
    rawError !== null &&
    typeof rawError !== "string"
  ) {
    return null;
  }
  let utterances: Array<VendorUtterance> | null = null;
  const rawUtterances = body["utterances"];
  if (rawUtterances !== undefined && rawUtterances !== null) {
    if (!Array.isArray(rawUtterances)) return null;
    utterances = [];
    for (const rawUtterance of rawUtterances) {
      const utterance = record(rawUtterance);
      const speaker = utterance["speaker"];
      if (
        speaker !== undefined &&
        speaker !== null &&
        typeof speaker !== "string"
      ) {
        return null;
      }
      const confidence = utterance["confidence"];
      if (
        confidence !== undefined &&
        confidence !== null &&
        typeof confidence !== "number"
      ) {
        return null;
      }
      if (
        typeof utterance["start"] !== "number" ||
        typeof utterance["end"] !== "number" ||
        typeof utterance["text"] !== "string"
      ) {
        return null;
      }
      utterances.push({
        speaker: (speaker as string | null | undefined) ?? null,
        start: utterance["start"],
        end: utterance["end"],
        text: utterance["text"],
        confidence: (confidence as number | null | undefined) ?? null,
      });
    }
  }
  return {
    id: body["id"],
    status,
    text: (rawText as string | null | undefined) ?? null,
    utterances,
    error: (rawError as string | null | undefined) ?? null,
  };
};

// ---------------------------------------------------------------------------
// Jobs receipts and the merge (lib's TranscriptJobReceipt + mergeParts
// + mergeChunkTranscripts, byte-for-byte field order).
// ---------------------------------------------------------------------------

export interface TranscriptChunkJobShape {
  readonly index: number;
  readonly key: string;
  readonly transcriptId: string;
  readonly submittedAt: string;
}

export interface TranscriptJobReceiptShape {
  readonly captureId: string;
  readonly version: string;
  readonly chunks: ReadonlyArray<TranscriptChunkJobShape>;
}

export const parseJobReceipt = (
  value: unknown,
): TranscriptJobReceiptShape | null => {
  const body = record(value);
  if (
    typeof body["captureId"] !== "string" ||
    typeof body["version"] !== "string" ||
    !Array.isArray(body["chunks"])
  ) {
    return null;
  }
  const chunks: Array<TranscriptChunkJobShape> = [];
  for (const raw of body["chunks"]) {
    const chunk = record(raw);
    if (
      typeof chunk["index"] !== "number" ||
      typeof chunk["key"] !== "string" ||
      typeof chunk["transcriptId"] !== "string" ||
      typeof chunk["submittedAt"] !== "string"
    ) {
      return null;
    }
    chunks.push({
      index: chunk["index"],
      key: chunk["key"],
      transcriptId: chunk["transcriptId"],
      submittedAt: chunk["submittedAt"],
    });
  }
  return {
    captureId: body["captureId"],
    version: body["version"],
    chunks,
  };
};

export const jobReceiptJson = (
  receipt: TranscriptJobReceiptShape,
): string =>
  JSON.stringify({
    captureId: receipt.captureId,
    version: receipt.version,
    chunks: receipt.chunks.map((chunk) => ({
      index: chunk.index,
      key: chunk.key,
      transcriptId: chunk.transcriptId,
      submittedAt: chunk.submittedAt,
    })),
  });

export interface TranscriptChunkPart {
  readonly chunk: { readonly startSeconds: number };
  readonly utterances: ReadonlyArray<{
    readonly speaker: string | null;
    readonly startMs: number;
    readonly endMs: number;
    readonly text: string;
    readonly confidence: number | null;
  }>;
  readonly text: string | null;
  readonly transcriptId: string | null;
  readonly error: string | null;
}

export interface MergedParts {
  readonly status: "completed" | "error";
  readonly text: string | null;
  readonly utterances: Array<{
    readonly speaker: string | null;
    readonly startMs: number;
    readonly endMs: number;
    readonly text: string;
    readonly confidence: number | null;
  }>;
  readonly transcriptId: string;
  readonly error: string | null;
}

/** lib's mergeParts, verbatim semantics. */
export const mergeParts = (
  parts: ReadonlyArray<TranscriptChunkPart>,
): MergedParts => {
  const failed = parts.find((part) => part.error !== null);
  return {
    status: failed === undefined ? "completed" : "error",
    text:
      parts
        .map((part) => part.text ?? "")
        .filter(Boolean)
        .join("\n") || null,
    utterances: parts.flatMap((part) =>
      part.utterances.map((utterance) => ({
        speaker: utterance.speaker,
        startMs: utterance.startMs + Math.round(part.chunk.startSeconds * 1000),
        endMs: utterance.endMs + Math.round(part.chunk.startSeconds * 1000),
        text: utterance.text,
        confidence: utterance.confidence,
      })),
    ),
    transcriptId: parts.map((part) => part.transcriptId ?? "").join(","),
    error: failed?.error ?? null,
  };
};

/** lib's mergeChunkTranscripts as a JSON string (Transcript field
 * order follows the Schema declaration). */
export const mergedTranscriptJson = (options: {
  readonly captureId: string;
  readonly capturedAt: string | null;
  readonly vendorKey: string;
  readonly parts: ReadonlyArray<TranscriptChunkPart>;
  readonly completedAt: string;
}): string => {
  const merged = mergeParts(options.parts);
  return JSON.stringify({
    provider: "assemblyai",
    version: TRANSCRIPT_VERSION,
    ingestId: options.captureId,
    inputKey: mediaManifestKey(options.captureId),
    ...(options.capturedAt === null
      ? {}
      : { capturedAt: options.capturedAt }),
    transcriptId: merged.transcriptId,
    vendorKey: options.vendorKey,
    status: merged.status,
    completedAt: options.completedAt,
    text: merged.text,
    utterances: merged.utterances,
    error: merged.error,
  });
};

/** AssemblyAI refuses language detection on audio with no spoken
 * audio; that is a property of the audio, not a failure. */
export const isNoSpokenAudioError = (error: string | null): boolean =>
  error !== null && error.toLowerCase().includes("no spoken audio");

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export class TranscribeReport extends Schema.Class<TranscribeReport>(
  "TranscribeReport",
)({
  ranAt: Schema.String,
  mode: Schema.Literals(["cron", "manual"]),
  perform: Schema.Boolean,
  totalManifests: Schema.Number,
  checked: Schema.Number,
  matched: Schema.Number,
  pending: Schema.Number,
  mismatched: Schema.Number,
  settled: Schema.Number,
  done: Schema.Number,
  inFlight: Schema.Number,
  performedSubmitted: Schema.Number,
  performedCompleted: Schema.Number,
  performedSettled: Schema.Number,
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
  proof: Schema.NullOr(
    Schema.Struct({
      captureId: Schema.String,
      state: Schema.String,
      detail: Schema.String,
    }),
  ),
}) {}

export interface TranscribePassOptions {
  readonly mode: "cron" | "manual";
  readonly now: Date;
  readonly limit: number;
  readonly offset?: number;
  readonly staleAfterMs: number;
  readonly perform: boolean;
  readonly captureId?: string;
  readonly proof?: boolean;
}

// ---------------------------------------------------------------------------
// Platform: typed errors and services
// ---------------------------------------------------------------------------

export class TranscribeVendorError extends Data.TaggedError(
  "TranscribeVendorError",
)<{
  readonly message: string;
  readonly transient: boolean;
  readonly cause: unknown;
}> {}

export class TranscribeDataError extends Data.TaggedError(
  "TranscribeDataError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

type TranscribeError =
  | TranscribeVendorError
  | TranscribeDataError
  | CatalogError
  | ArtifactReadError
  | IndexRequestError
  | NotebookError
  | R2CredsError;

export class TranscribeData extends Context.Service<
  TranscribeData,
  {
    readonly manifestIds: Effect.Effect<ReadonlyArray<string>, CatalogError>;
    readonly settledIds: Effect.Effect<ReadonlyArray<string>, CatalogError>;
    /** Captures with a canonical transcript file (any status). */
    readonly canonicalIds: Effect.Effect<ReadonlyArray<string>, CatalogError>;
    /** Captures with a jobs receipt. */
    readonly receiptIds: Effect.Effect<ReadonlyArray<string>, CatalogError>;
    readonly readText: (
      key: string,
    ) => Effect.Effect<string | null, ArtifactReadError>;
    readonly headSize: (
      key: string,
    ) => Effect.Effect<number | null, CatalogError>;
    readonly s3Credentials: S3CredentialsValue | null;
  }
>()("medina-cloudflare/TranscribeData") {}

export interface AssemblyAiResult {
  readonly transcript: VendorTranscriptShape;
  /** The untouched response JSON (the vendor receipt keeps it). */
  readonly raw: unknown;
}

export class TranscribeVendor extends Context.Service<
  TranscribeVendor,
  {
    readonly configured: boolean;
    readonly submit: (
      audioUrl: string,
    ) => Effect.Effect<AssemblyAiResult, TranscribeVendorError>;
    readonly poll: (
      transcriptId: string,
    ) => Effect.Effect<AssemblyAiResult, TranscribeVendorError>;
  }
>()("medina-cloudflare/TranscribeVendor") {}

export class TranscribeNotebook extends Context.Service<
  TranscribeNotebook,
  {
    readonly record: (
      report: TranscribeReport,
    ) => Effect.Effect<void, NotebookError>;
    readonly cursor: Effect.Effect<number, NotebookError>;
    readonly setCursor: (
      cursor: number,
    ) => Effect.Effect<void, NotebookError>;
  }
>()("medina-cloudflare/TranscribeNotebook") {}

interface SecretsStoreSecretLike {
  get(): Promise<unknown>;
}

export interface TranscribeEnv {
  readonly notebook: {
    idFromName(name: string): unknown;
    get(id: unknown): {
      fetch(request: Request): Promise<Response>;
    };
  };
  /** The AssemblyAI key binding; null until declared in the stack. */
  readonly assemblyAiApiKey: SecretsStoreSecretLike | null;
  /** The ARTIFACTS_S3 binding value (JSON string when deployed). */
  readonly s3Credentials: unknown;
  /** ASSEMBLYAI_PROMPT / ASSEMBLYAI_SPEAKER_NAMES parity with
   * medina-dev's client config; unset there today. */
  readonly prompt?: string;
  readonly speakerNames?: ReadonlyArray<string>;
}

export const TRANSCRIBE_SHADOW_DO_NAME = "transcribe-shadow-v1";

export const transcribePlatformLayer = (
  env: TranscribeEnv,
): Layer.Layer<
  TranscribeData | TranscribeVendor | TranscribeNotebook,
  never,
  ArtifactLedger | ArtifactCatalog
> =>
  Layer.effect(
    TranscribeData,
    Effect.gen(function* () {
      const ledger = yield* ArtifactLedger;
      const catalog = yield* ArtifactCatalog;
      const idsUnder = (
        prefix: string,
      ): Effect.Effect<ReadonlyArray<string>, CatalogError> =>
        Effect.map(catalog.listAll(prefix), (objects) =>
          objects
            .map((object) => object.key.slice(prefix.length))
            .filter((rest) => !rest.includes("/") && rest.endsWith(".json"))
            .map((rest) => rest.slice(0, -".json".length))
            .filter((id) => id.length > 0)
            .sort(),
        );
      const transcriptFamily = (
        suffix: string,
      ): Effect.Effect<ReadonlyArray<string>, CatalogError> =>
        Effect.map(
          catalog.listAll(`transcript/${TRANSCRIPT_VERSION}/`),
          (objects) =>
            objects
              .map((object) =>
                object.key.slice(`transcript/${TRANSCRIPT_VERSION}/`.length),
              )
              .filter((rest) => !rest.includes("/") && rest.endsWith(suffix))
              .map((rest) => rest.slice(0, -suffix.length))
              .filter((id) => id.length > 0)
              .sort(),
        );
      return {
        manifestIds: idsUnder("media/media-v1/"),
        settledIds: idsUnder(`transcribe-settled/${TRANSCRIPT_VERSION}/`),
        canonicalIds: Effect.map(
          catalog.listAll(`transcript/${TRANSCRIPT_VERSION}/`),
          (objects) =>
            objects
              .map((object) =>
                object.key.slice(`transcript/${TRANSCRIPT_VERSION}/`.length),
              )
              .filter(
                (rest) =>
                  !rest.includes("/") &&
                  rest.endsWith(".json") &&
                  !rest.endsWith(".jobs.json") &&
                  !rest.endsWith(".assemblyai.json") &&
                  !rest.endsWith(".ondevice.json"),
              )
              .map((rest) => rest.slice(0, -".json".length))
              .filter((id) => id.length > 0)
              .sort(),
        ),
        receiptIds: transcriptFamily(".jobs.json"),
        readText: (key) =>
          Effect.map(ledger.readText(key), (value) =>
            Option.isSome(value) ? value.value : null,
          ),
        headSize: (key) =>
          Effect.map(catalog.head(key), (head) =>
            head === null ? null : head.size,
          ),
        s3Credentials: parseS3Credentials(env.s3Credentials),
      };
    }),
  ).pipe(
    Layer.merge(
      Layer.succeed(TranscribeVendor, {
        configured: env.assemblyAiApiKey !== null,
        submit: (audioUrl) => assemblyAiRequest(env, "submit", audioUrl),
        poll: (transcriptId) => assemblyAiRequest(env, "poll", transcriptId),
      }),
    ),
    Layer.merge(
      Layer.succeed(TranscribeNotebook, {
        record: (report) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(TRANSCRIBE_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://transcribe-shadow/report", {
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
                message: "recording a transcribe report failed",
                cause,
              }),
          }),
        cursor: Effect.tryPromise({
          try: async () => {
            const stub = env.notebook.get(
              env.notebook.idFromName(TRANSCRIBE_SHADOW_DO_NAME),
            );
            const response = await stub.fetch(
              new Request("http://transcribe-shadow/cursor"),
            );
            if (!response.ok) {
              throw new Error(`notebook cursor answered ${response.status}`);
            }
            const body = (await response.json()) as { cursor?: unknown };
            return typeof body.cursor === "number" ? body.cursor : 0;
          },
          catch: (cause) =>
            new NotebookError({
              message: "reading the transcribe cursor failed",
              cause,
            }),
        }),
        setCursor: (cursor) =>
          Effect.tryPromise({
            try: async () => {
              const stub = env.notebook.get(
                env.notebook.idFromName(TRANSCRIBE_SHADOW_DO_NAME),
              );
              const response = await stub.fetch(
                new Request("http://transcribe-shadow/cursor", {
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
                message: "writing the transcribe cursor failed",
                cause,
              }),
          }),
      }),
    ),
  );

/** One AssemblyAI call, lib's client semantics: the raw key as the
 * authorization header, non-2xx is an error, transport and 5xx
 * failures retry (3 recurs, 1 s spacing), the response is strictly
 * projected and the raw JSON kept. */
const assemblyAiRequest = (
  env: TranscribeEnv,
  operation: "submit" | "poll",
  argument: string,
): Effect.Effect<AssemblyAiResult, TranscribeVendorError> =>
  Effect.gen(function* () {
    if (env.assemblyAiApiKey === null) {
      return yield* Effect.fail(
        new TranscribeVendorError({
          message: "the ASSEMBLYAI_API_KEY binding is not present",
          transient: false,
          cause: null,
        }),
      );
    }
    const apiKey = yield* Effect.tryPromise({
      try: async () => {
        const value = await env.assemblyAiApiKey!.get();
        if (typeof value !== "string" || value.length === 0) {
          throw new Error("binding value is not a non-empty string");
        }
        return value;
      },
      catch: (cause) =>
        new TranscribeVendorError({
          message: "reading the ASSEMBLYAI_API_KEY binding failed",
          transient: false,
          cause,
        }),
    });
    const attempt = Effect.tryPromise({
      try: async () => {
        const response =
          operation === "submit"
            ? await fetch(`${ASSEMBLYAI_BASE_URL}/v2/transcript`, {
                method: "POST",
                headers: {
                  authorization: apiKey,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  audio_url: argument,
                  speech_models: ["universal-3-5-pro"],
                  speaker_labels: true,
                  language_detection: true,
                  ...(env.prompt ? { prompt: env.prompt } : {}),
                  ...(env.speakerNames !== undefined &&
                  env.speakerNames.length > 0
                    ? {
                        speech_understanding: {
                          request: {
                            speaker_identification: {
                              speaker_type: "name",
                              known_values: env.speakerNames,
                            },
                          },
                        },
                      }
                    : {}),
                }),
              })
            : await fetch(
                `${ASSEMBLYAI_BASE_URL}/v2/transcript/${encodeURIComponent(argument)}`,
                { headers: { authorization: apiKey } },
              );
        const rawText = await response.text();
        let raw: unknown = null;
        try {
          raw = JSON.parse(rawText) as unknown;
        } catch {
          // handled as an unreadable response below
        }
        if (!response.ok) {
          const detail =
            raw !== null && text(record(raw)["error"]) !== null
              ? text(record(raw)["error"])!
              : `HTTP ${response.status}`;
          throw new TranscribeVendorError({
            message: `AssemblyAI request failed: ${detail}`,
            transient: response.status >= 500,
            cause: response.status,
          });
        }
        if (raw === null) {
          throw new TranscribeVendorError({
            message: "AssemblyAI request failed: unreadable JSON response",
            transient: false,
            cause: rawText.slice(0, 200),
          });
        }
        const transcript = projectVendorTranscript(raw);
        if (transcript === null) {
          throw new TranscribeVendorError({
            message:
              "AssemblyAI request failed: response did not decode as a vendor transcript",
            transient: false,
            cause: null,
          });
        }
        return { transcript, raw };
      },
      catch: (cause) =>
        cause instanceof TranscribeVendorError
          ? cause
          : new TranscribeVendorError({
              message: "AssemblyAI request failed",
              transient: true,
              cause,
            }),
    });
    return yield* attempt.pipe(
      Effect.retry({
        while: (error: TranscribeVendorError) => error.transient,
        schedule: Schedule.max([
          Schedule.spaced("1 second"),
          Schedule.recurs(3),
        ]),
      }),
    );
  });

// ---------------------------------------------------------------------------
// The reconciler
// ---------------------------------------------------------------------------

interface StageKeys {
  readonly jobsKey: string;
  readonly vendorKey: string;
  readonly canonicalKey: string;
  readonly settledKey: string;
}

const productionKeys = (captureId: string): StageKeys => ({
  jobsKey: transcriptJobsKey(captureId),
  vendorKey: vendorKey(captureId),
  canonicalKey: transcriptKey(captureId),
  settledKey: transcriptSettledKey(captureId),
});

const proofKeys = (captureId: string): StageKeys => ({
  jobsKey: `transcript-proof/${TRANSCRIPT_VERSION}/${captureId}.jobs.json`,
  vendorKey: `transcript-proof/${TRANSCRIPT_VERSION}/${captureId}.assemblyai.json`,
  canonicalKey: `transcript-proof/${TRANSCRIPT_VERSION}/${captureId}.json`,
  settledKey: `transcript-proof/settled/${captureId}.json`,
});

interface CaptureState {
  readonly manifestText: string | null;
  readonly receiptText: string | null;
  readonly canonicalText: string | null;
  readonly provenanceText: string | null;
  readonly settled: boolean;
}

type ItemOutcome =
  | { readonly kind: "done"; readonly detail: string }
  | { readonly kind: "settled"; readonly detail: string }
  | { readonly kind: "in-flight"; readonly detail: string }
  | { readonly kind: "pending"; readonly detail: string }
  | { readonly kind: "mismatch"; readonly mismatchKind: string; readonly detail: string }
  | { readonly kind: "submitted"; readonly detail: string }
  | { readonly kind: "completed"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string };

const MAX_STORED_FINDINGS = 100;

const parseJsonOrNull = (value: string | null): unknown => {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

/** The canonical transcript's status + capturedAt, read loosely
 * (a full Transcript decode is the day index's job, not ours). */
const canonicalLite = (
  value: string | null,
): { readonly status: string | null; readonly capturedAt: string | null; readonly text: string | null } => {
  const body = record(parseJsonOrNull(value));
  return {
    status: text(body["status"]),
    capturedAt: text(body["capturedAt"]),
    text: typeof body["text"] === "string" ? body["text"] : null,
  };
};

const capturedAtFor = (provenanceText: string | null): string | null => {
  const body = record(parseJsonOrNull(provenanceText));
  const records = Array.isArray(body["records"]) ? body["records"] : [];
  const filename = text(record(records[0])["filename"]);
  return filename === null ? null : filenameWallClock(filename);
};

/** Whether a stored receipt is a prefix-consistent view of the
 * manifest (lib fails the item when it is not). */
const receiptMatchesManifest = (
  receipt: TranscriptJobReceiptShape,
  manifest: MediaManifestShape,
): boolean =>
  receipt.chunks.length <= manifest.chunks.length &&
  receipt.chunks.every((job, index) => {
    const chunk = manifest.chunks[index];
    return (
      chunk !== undefined && job.index === chunk.index && job.key === chunk.key
    );
  });

const gatherState = (
  captureId: string,
  keys: StageKeys,
  settledIds: ReadonlySet<string>,
): Effect.Effect<CaptureState, ArtifactReadError, TranscribeData> =>
  Effect.gen(function* () {
    const data = yield* TranscribeData;
    return {
      manifestText: yield* data.readText(mediaManifestKey(captureId)),
      receiptText: yield* data.readText(keys.jobsKey),
      canonicalText: yield* data.readText(keys.canonicalKey),
      provenanceText: yield* data.readText(
        `capture/${captureId}/provenance.json`,
      ),
      settled: settledIds.has(captureId),
    };
  });

/** A two-hour presigned GET URL for one chunk (lib's presignGet
 * call in the submit path): mint the read-only temporary
 * credential scoped to the object, presign with it. */
const presignChunkUrl = (
  s3: S3CredentialsValue,
  key: string,
  now: Date,
): Effect.Effect<string, R2CredsError> =>
  Effect.gen(function* () {
    const creds = yield* mintTempCredentials({
      endpoint: s3.endpoint,
      accountId: accountIdFromEndpoint(s3.endpoint),
      parent: s3,
      bucket: s3.bucketName,
      permission: "object-read-only",
      ttlSeconds: CHUNK_URL_TTL_SECONDS,
      objects: [key],
      now,
    });
    return yield* presignGetUrl({
      endpoint: s3.endpoint,
      bucket: s3.bucketName,
      key,
      credentials: creds,
      ttlSeconds: CHUNK_URL_TTL_SECONDS,
      now,
    });
  });

type PerformServices =
  | TranscribeData
  | TranscribeVendor
  | ArtifactLedger;

/** Perform one capture (lib's transcribeMediaCapture). */
const performCapture = (options: {
  readonly captureId: string;
  readonly keys: StageKeys;
  readonly state: CaptureState;
  readonly now: Date;
}): Effect.Effect<ItemOutcome, never, PerformServices> =>
  Effect.gen(function* () {
    const data = yield* TranscribeData;
    const vendor = yield* TranscribeVendor;
    const ledger = yield* ArtifactLedger;
    const { captureId, keys, state } = options;
    if (state.settled) {
      return { kind: "settled" as const, detail: "transcribe-settled marker present" };
    }
    const manifest = parseMediaManifest(parseJsonOrNull(state.manifestText));
    if (manifest === null) {
      return {
        kind: "error" as const,
        detail: "stored manifest does not decode as a MediaManifest",
      };
    }
    if (manifest.chunks.length === 0) {
      return {
        kind: "error" as const,
        detail: `empty media manifest for ${captureId}`,
      };
    }
    if (!vendor.configured) {
      return {
        kind: "error" as const,
        detail: "ASSEMBLYAI_API_KEY is not bound to this Worker",
      };
    }
    const s3 = data.s3Credentials;
    if (s3 === null) {
      return {
        kind: "error" as const,
        detail:
          "the ARTIFACTS_S3 binding is missing or unreadable: cannot presign chunk URLs",
      };
    }

    // A stale error transcript is not evidence: clear it so the
    // capture retries cleanly (lib does the same up front).
    const canonical = canonicalLite(state.canonicalText);
    if (state.canonicalText !== null && canonical.status === "error") {
      yield* ledger.remove(keys.canonicalKey);
    } else if (state.canonicalText !== null && canonical.status === "completed") {
      return { kind: "done" as const, detail: "canonical transcript already completed" };
    }

    const receipt = parseJobReceipt(parseJsonOrNull(state.receiptText));
    if (receipt !== null && !receiptMatchesManifest(receipt, manifest)) {
      return {
        kind: "error" as const,
        detail: `transcription receipt does not match media manifest for ${captureId}`,
      };
    }

    // Submit every chunk that has no job yet, committing the
    // receipt after EACH accepted job — a later failure must never
    // duplicate a running transcript. This is the only place in
    // the system that spends AssemblyAI money.
    const jobs: Array<TranscriptChunkJobShape> = [...(receipt?.chunks ?? [])];
    if (jobs.length < manifest.chunks.length) {
      for (const chunk of manifest.chunks.slice(jobs.length)) {
        const size = yield* data.headSize(chunk.key);
        if (size === null || size <= 0) {
          const message = `media chunk is missing from R2 and local storage: ${chunk.key}`;
          yield* ledger.writeText(
            keys.settledKey,
            JSON.stringify({
              captureId,
              error: message,
              settledAt: options.now.toISOString(),
            }),
          );
          return {
            kind: "settled" as const,
            detail: `settled as impossible: ${message}`,
          };
        }
        const audioUrl = yield* presignChunkUrl(s3, chunk.key, options.now);
        const submitted = yield* vendor.submit(audioUrl);
        jobs.push({
          index: chunk.index,
          key: chunk.key,
          transcriptId: submitted.transcript.id,
          submittedAt: options.now.toISOString(),
        });
        yield* ledger.writeText(
          keys.jobsKey,
          jobReceiptJson({ captureId, version: TRANSCRIPT_VERSION, chunks: jobs }),
        );
      }
      return {
        kind: "submitted" as const,
        detail: `${jobs.length} job(s) on receipt; submissions complete, polling on a later pass`,
      };
    }

    // Poll the jobs already paid for.
    const results: Array<AssemblyAiResult> = [];
    for (const job of jobs) {
      results.push(yield* vendor.poll(job.transcriptId));
    }
    if (
      results.some(
        (result) =>
          result.transcript.status === "queued" ||
          result.transcript.status === "processing",
      )
    ) {
      return {
        kind: "submitted" as const,
        detail: "jobs still running at AssemblyAI",
      };
    }

    const parts: Array<TranscriptChunkPart> = results.map((result, index) => {
      const chunk = manifest.chunks[index]!;
      return {
        chunk,
        utterances: (result.transcript.utterances ?? []).map((utterance) => ({
          speaker: utterance.speaker,
          startMs: utterance.start,
          endMs: utterance.end,
          text: utterance.text,
          confidence: utterance.confidence,
        })),
        text: result.transcript.text,
        transcriptId: result.transcript.id,
        error:
          result.transcript.status === "error"
            ? (result.transcript.error ?? "AssemblyAI transcription failed")
            : (result.transcript.error ?? null),
      };
    });

    const capturedAt = capturedAtFor(state.provenanceText);

    // The vendor receipt is always kept, error or not.
    yield* ledger.writeText(
      keys.vendorKey,
      JSON.stringify({
        chunked: true,
        chunks: results.map((result) => result.raw),
      }),
    );

    const completedParts = parts.filter((part) => part.error === null);
    const erroredParts = parts.filter((part) => part.error !== null);
    if (erroredParts.length === 0) {
      yield* ledger.writeText(
        keys.canonicalKey,
        mergedTranscriptJson({
          captureId,
          capturedAt,
          vendorKey: keys.vendorKey,
          parts,
          completedAt: options.now.toISOString(),
        }),
      );
      return {
        kind: "completed" as const,
        detail: `canonical transcript written from ${parts.length} chunk(s)`,
      };
    }
    if (completedParts.length > 0) {
      yield* ledger.writeText(
        keys.canonicalKey,
        mergedTranscriptJson({
          captureId,
          capturedAt,
          vendorKey: keys.vendorKey,
          parts: completedParts,
          completedAt: options.now.toISOString(),
        }),
      );
      return {
        kind: "completed" as const,
        detail:
          `settled with ${completedParts.length}/${parts.length} chunks; ` +
          `dropped ${erroredParts.length} errored chunk(s): ${erroredParts[0]!.error ?? "unknown error"}`,
      };
    }
    if (erroredParts.every((part) => isNoSpokenAudioError(part.error))) {
      yield* ledger.writeText(
        keys.canonicalKey,
        mergedTranscriptJson({
          captureId,
          capturedAt,
          vendorKey: keys.vendorKey,
          parts: [],
          completedAt: options.now.toISOString(),
        }),
      );
      return {
        kind: "completed" as const,
        detail: "no spoken audio in any chunk; settled as a completed empty transcript",
      };
    }
    const merged = mergeParts(parts);
    yield* ledger.writeText(
      keys.settledKey,
      JSON.stringify({
        captureId,
        error: merged.error,
        settledAt: options.now.toISOString(),
      }),
    );
    return {
      kind: "error" as const,
      detail: `AssemblyAI transcription failed for ${captureId}: ${merged.error ?? "unknown error"} (settled; receipt kept)`,
    };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        kind: "error" as const,
        detail: String(error).slice(0, 300),
      }),
    ),
  );

/** Diff one capture against what medina-dev produced (shadow).
 * Submits nothing, polls nothing: the plan is computed from the
 * same state medina-dev's stage reads, and compared with the
 * receipts and transcripts it actually left behind. */
const diffCapture = (options: {
  readonly captureId: string;
  readonly state: CaptureState;
  readonly now: Date;
  readonly staleAfterMs: number;
}): Effect.Effect<ItemOutcome, never, TranscribeData> =>
  Effect.gen(function* () {
    const data = yield* TranscribeData;
    const { captureId, state } = options;
    if (state.settled) {
      return { kind: "settled" as const, detail: "transcribe-settled marker present" };
    }
    const manifest = parseMediaManifest(parseJsonOrNull(state.manifestText));
    if (manifest === null) {
      return {
        kind: "error" as const,
        detail: "manifest listed but does not decode as a MediaManifest",
      };
    }
    const canonical = canonicalLite(state.canonicalText);
    const receipt = parseJobReceipt(parseJsonOrNull(state.receiptText));

    if (state.canonicalText !== null && canonical.status === "completed") {
      // Extra parity: the stored capturedAt must be what the
      // provenance filename implies — the same derivation the
      // merge performs.
      const expectedCapturedAt = capturedAtFor(state.provenanceText);
      if (expectedCapturedAt !== canonical.capturedAt) {
        return {
          kind: "mismatch" as const,
          mismatchKind: "captured-at-differs",
          detail: `stored capturedAt ${canonical.capturedAt ?? "null"} vs provenance-derived ${expectedCapturedAt ?? "null"}`,
        };
      }
      if (receipt !== null && !receiptMatchesManifest(receipt, manifest)) {
        return {
          kind: "error" as const,
          detail: "stored jobs receipt does not match the manifest (medina-dev fails this item too)",
        };
      }
      return {
        kind: "done" as const,
        detail:
          receipt === null
            ? "canonical transcript completed (no jobs receipt — pre-receipt era or promoted)"
            : "canonical transcript completed; receipt consistent",
      };
    }
    if (state.canonicalText !== null && canonical.status === "error") {
      // Retryable by design on both sides (the stale error record
      // is cleared and the receipt re-polled).
      return {
        kind: "in-flight" as const,
        detail: "error transcript is retryable; both implementations would reprocess",
      };
    }
    // No canonical transcript: the plan is submit-or-poll.
    if (receipt !== null) {
      if (!receiptMatchesManifest(receipt, manifest)) {
        return {
          kind: "error" as const,
          detail: "stored jobs receipt does not match the manifest (medina-dev fails this item too)",
        };
      }
      const missingChunks: Array<string> = [];
      for (const chunk of manifest.chunks) {
        const size = yield* data.headSize(chunk.key);
        if (size === null || size <= 0) missingChunks.push(chunk.key);
      }
      if (missingChunks.length > 0) {
        return {
          kind: "done" as const,
          detail: `plan agrees the capture settles: chunk missing from the bucket (${missingChunks[0]})`,
        };
      }
      return {
        kind: "in-flight" as const,
        detail:
          receipt.chunks.length < manifest.chunks.length
            ? `receipt covers ${receipt.chunks.length}/${manifest.chunks.length} chunks; the rest would submit`
            : `${receipt.chunks.length} job(s) on receipt; polling only, nothing would submit`,
      };
    }
    // Nothing submitted yet. Would every chunk be submittable?
    for (const chunk of manifest.chunks) {
      const size = yield* data.headSize(chunk.key);
      if (size === null || size <= 0) {
        return {
          kind: "done" as const,
          detail: `plan agrees the capture settles: chunk missing from the bucket (${chunk.key})`,
        };
      }
    }
    const manifestAge =
      options.now.getTime() - Date.parse(manifest.createdAt);
    if (Number.isFinite(manifestAge) && manifestAge <= options.staleAfterMs) {
      return {
        kind: "pending" as const,
        detail: "manifest is fresh; medina-dev has not submitted yet",
      };
    }
    return {
      kind: "mismatch" as const,
      mismatchKind: "unsubmitted",
      detail: `manifest is ${Math.round(manifestAge / 60000)} min old with no jobs receipt and no transcript — medina-dev should have submitted by now`,
    };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        kind: "error" as const,
        detail: String(error).slice(0, 300),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export const runTranscribePass = (
  options: TranscribePassOptions,
): Effect.Effect<
  TranscribeReport,
  TranscribeError,
  TranscribeData | TranscribeVendor | TranscribeNotebook | ArtifactLedger | ArtifactCatalog
> =>
  Effect.gen(function* () {
    const data = yield* TranscribeData;
    const notebook = yield* TranscribeNotebook;
    const manifestIds = yield* data.manifestIds;
    const settledIdSet = new Set(yield* data.settledIds);

    let selected: Array<string>;
    if (options.captureId !== undefined) {
      selected = [options.captureId];
    } else if (options.perform) {
      // Frontier, from listings alone: manifests with no canonical
      // transcript and no settle marker, receipt holders first
      // (finish what is already paid for). A capture whose
      // canonical is a stale ERROR record still carries its jobs
      // receipt, so it lands in the receipt-first set and the item
      // flow reprocesses it; the per-capture work re-reads its
      // state fresh at the moment of work regardless.
      const canonicalIdSet = new Set(yield* data.canonicalIds);
      const receiptIdSet = new Set(yield* data.receiptIds);
      const frontier = manifestIds.filter(
        (id) => !settledIdSet.has(id) && !canonicalIdSet.has(id),
      );
      const ordered = [
        ...frontier.filter((id) => receiptIdSet.has(id)),
        ...frontier.filter((id) => !receiptIdSet.has(id)),
      ];
      selected = ordered.slice(0, options.limit);
    } else {
      const offset = options.offset ?? (yield* notebook.cursor);
      selected = manifestIds.slice(offset, offset + options.limit);
      if (options.mode === "cron" && manifestIds.length > 0) {
        yield* notebook.setCursor(
          (offset + selected.length) % manifestIds.length,
        );
      }
    }

    let matched = 0;
    let pending = 0;
    let mismatched = 0;
    let settled = 0;
    let done = 0;
    let inFlight = 0;
    let performedSubmitted = 0;
    let performedCompleted = 0;
    let performedSettled = 0;
    const mismatches: Array<{
      captureId: string;
      kind: string;
      detail: string;
    }> = [];
    const errors: Array<{ captureId: string; detail: string }> = [];
    let proof: TranscribeReport["proof"] = null;

    // Items run 8-wide (medina-dev's own pipeline bound); the
    // counters below mutate only in synchronous statements
    // between awaits.
    const processOne = (captureId: string) =>
      Effect.gen(function* () {
      const keys =
        options.proof === true
          ? proofKeys(captureId)
          : productionKeys(captureId);
      const state = yield* gatherState(
        captureId,
        keys,
        options.proof === true ? new Set<string>() : settledIdSet,
      );
      const outcome =
        options.perform || options.proof === true
          ? yield* performCapture({
              captureId,
              keys,
              state,
              now: options.now,
            })
          : yield* diffCapture({
              captureId,
              state,
              now: options.now,
              staleAfterMs: options.staleAfterMs,
            });

      if (options.proof === true) {
        // Compare the proof transcript against the canonical one.
        let detail = outcome.detail;
        let proofState: string = outcome.kind;
        if (outcome.kind === "completed" || outcome.kind === "done") {
          const proofText = yield* data.readText(keys.canonicalKey);
          const canonicalText = yield* data.readText(
            transcriptKey(captureId),
          );
          const proofLite = canonicalLite(proofText);
          const canonical = canonicalLite(canonicalText);
          if (proofLite.text !== null && canonical.text !== null) {
            proofState =
              proofLite.text === canonical.text ? "match" : "differs";
            detail =
              proofLite.text === canonical.text
                ? `proof transcript text matches the canonical transcript exactly (${proofLite.text.length} chars)`
                : `proof transcript text DIFFERS from canonical (proof ${proofLite.text.length} chars, canonical ${canonical.text.length} chars)`;
          }
        }
        proof = { captureId, state: proofState, detail };
      }

      switch (outcome.kind) {
        case "done":
          done++;
          matched++;
          break;
        case "settled":
          settled++;
          if (options.perform) performedSettled++;
          break;
        case "in-flight":
          inFlight++;
          matched++;
          break;
        case "pending":
          pending++;
          break;
        case "mismatch":
          mismatched++;
          if (mismatches.length < MAX_STORED_FINDINGS) {
            mismatches.push({
              captureId,
              kind: outcome.mismatchKind,
              detail: outcome.detail,
            });
          }
          break;
        case "submitted":
          performedSubmitted++;
          break;
        case "completed":
          performedCompleted++;
          matched++;
          break;
        case "error":
          if (outcome.detail.includes("(settled; receipt kept)")) {
            performedSettled++;
          }
          if (errors.length < MAX_STORED_FINDINGS) {
            errors.push({ captureId, detail: outcome.detail });
          }
          break;
      }
      });
    yield* Effect.forEach(
      selected,
      (captureId) =>
        processOne(captureId).pipe(
          // Per-item isolation: one capture's failure is a
          // finding in the report, never a failed pass (the
          // stage-level medina-index 500 caveat in §4.2).
          Effect.catch((cause) =>
            Effect.sync(() => {
              if (errors.length < MAX_STORED_FINDINGS) {
                errors.push({
                  captureId,
                  detail: `pass item failed: ${String(cause).slice(0, 300)}`,
                });
              }
            }),
          ),
        ),
      { concurrency: 8 },
    );

    const report = new TranscribeReport({
      ranAt: options.now.toISOString(),
      mode: options.mode,
      perform: options.perform || options.proof === true,
      totalManifests: manifestIds.length,
      checked: selected.length,
      matched,
      pending,
      mismatched,
      settled,
      done,
      inFlight,
      performedSubmitted,
      performedCompleted,
      performedSettled,
      mismatches,
      errors,
      proof,
    });
    yield* notebook.record(report);
    return report;
  });

// ---------------------------------------------------------------------------
// TranscribeShadow: the stage's notebook Durable Object.
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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export class TranscribeShadow {
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
      return jsonResponse({ ok: true });
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
      return jsonResponse({
        runCount: Number(countRows[0]?.["n"] ?? 0),
        lastReport,
      });
    }
    if (request.method === "GET" && url.pathname === "/cursor") {
      const rows = this.sql
        .exec(`SELECT v FROM meta WHERE k = 'cursor'`)
        .toArray();
      const cursor =
        rows.length > 0 && typeof rows[0]?.["v"] === "string"
          ? Number(rows[0]["v"])
          : 0;
      return jsonResponse({
        cursor: Number.isFinite(cursor) ? cursor : 0,
      });
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
      return jsonResponse({ ok: true, cursor });
    }
    return jsonResponse({ error: "not found" }, 404);
  }
}
