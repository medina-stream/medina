/**
 * The artifact catalog: listing and heading the canonical artifact
 * bucket (sco-lifelog) — the read side the capture loop's ledger
 * (src/capture.ts) does not need but the milestone-4 stage ports do.
 * The star detector enumerates `star/` records; the archive sweep
 * enumerates `capture/` directories and heads the files it reconciles.
 *
 * R2 returns listings in ascending key order — the same order the
 * server's artifact store contract promises ("full keys under
 * prefix, sorted") — so a catalog listing and a store listing name
 * the same objects in the same order, which is what makes the stage
 * shadows' diffs meaningful.
 *
 * Etags: the R2 binding exposes both a bare `etag` and the quoted
 * HTTP form (`httpEtag`); the server's S3-shaped bucket carries the
 * bare form (its archive receipts store bare etags). Everything the
 * catalog hands out is normalized to the bare form, so a receipt the
 * Worker writes reads the same as one medina-dev wrote.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// ---------------------------------------------------------------------------
// Platform: minimal structural types for the R2 binding surface the
// catalog uses (the same standalone approach as capture.ts).
// ---------------------------------------------------------------------------

export interface CatalogListedObjectLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
}

export interface CatalogHeadLike {
  readonly size: number;
  readonly etag?: string;
  readonly httpEtag?: string;
  readonly uploaded?: Date;
}

export interface CatalogPutResultLike {
  readonly etag?: string;
  readonly httpEtag?: string;
}

export interface CatalogBucketLike {
  head(key: string): Promise<CatalogHeadLike | null>;
  put(
    key: string,
    value: string | Uint8Array,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
    },
  ): Promise<CatalogPutResultLike | unknown>;
  list(options: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly delimiter?: string;
  }): Promise<{
    readonly objects: ReadonlyArray<CatalogListedObjectLike>;
    readonly delimitedPrefixes?: ReadonlyArray<string>;
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

/** One object in the artifact bucket, as a listing reports it. */
export interface CatalogObject {
  readonly key: string;
  readonly size: number;
  /** Bare (unquoted) etag, the server's S3-shaped form. */
  readonly etag: string;
  readonly uploaded: Date;
}

/** One object as a head reports it. */
export interface CatalogHead {
  readonly size: number;
  /** Bare (unquoted) etag, the server's S3-shaped form. */
  readonly etag: string | null;
  /** Bucket lastModified, when the binding reports it. */
  readonly uploaded: string | null;
}

/** Strip the HTTP quoting from an etag, if present. */
export const normalizeEtag = (etag: string): string =>
  etag.length >= 2 && etag.startsWith("\"") && etag.endsWith("\"")
    ? etag.slice(1, -1)
    : etag;

export class CatalogError extends Data.TaggedError("CatalogError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class ArtifactCatalog extends Context.Service<
  ArtifactCatalog,
  {
    /** Every object under `prefix`, ascending by key. */
    readonly listAll: (
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<CatalogObject>, CatalogError>;
    /**
     * The immediate child prefixes under `prefix` (delimited
     * listing), ascending — e.g. every `capture/<id>/` directory.
     */
    readonly listPrefixes: (
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<string>, CatalogError>;
    /** Head one object; null when absent. */
    readonly head: (
      key: string,
    ) => Effect.Effect<CatalogHead | null, CatalogError>;
    /**
     * Copy-grade put for the archive sweep's bucket-to-bucket move:
     * write bytes under a key and resolve to the stored (bare) etag.
     * Unlike the ledger's writes this does NOT register in the
     * index — the sweep's objects are already artifacts; the move
     * reconciles bucket presence, and its receipt is the write that
     * registers.
     */
    readonly putBytes: (
      key: string,
      bytes: Uint8Array,
      contentType: string | undefined,
    ) => Effect.Effect<string | null, CatalogError>;
  }
>()("medina-cloudflare/ArtifactCatalog") {}

const MAX_LIST_PAGES = 200;

export const artifactCatalogLayer = (
  bucket: CatalogBucketLike,
): Layer.Layer<ArtifactCatalog> =>
  Layer.succeed(ArtifactCatalog, {
    listAll: (prefix) =>
      Effect.tryPromise({
        try: async () => {
          const all: Array<CatalogObject> = [];
          let cursor: string | undefined;
          for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const result = await bucket.list({
              prefix,
              limit: 1000,
              ...(cursor === undefined ? {} : { cursor }),
            });
            for (const object of result.objects) {
              all.push({
                key: object.key,
                size: object.size,
                etag: normalizeEtag(object.etag),
                uploaded: object.uploaded,
              });
            }
            if (!result.truncated || result.cursor === undefined) break;
            cursor = result.cursor;
          }
          return all;
        },
        catch: (cause) =>
          new CatalogError({
            message: `listing ${prefix} in the artifact bucket failed`,
            cause,
          }),
      }),
    listPrefixes: (prefix) =>
      Effect.tryPromise({
        try: async () => {
          const all: Array<string> = [];
          let cursor: string | undefined;
          for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const result = await bucket.list({
              prefix,
              limit: 1000,
              delimiter: "/",
              ...(cursor === undefined ? {} : { cursor }),
            });
            for (const child of result.delimitedPrefixes ?? []) {
              all.push(child);
            }
            if (!result.truncated || result.cursor === undefined) break;
            cursor = result.cursor;
          }
          return all;
        },
        catch: (cause) =>
          new CatalogError({
            message: `listing prefixes under ${prefix} in the artifact bucket failed`,
            cause,
          }),
      }),
    head: (key) =>
      Effect.tryPromise({
        try: async () => {
          const object = await bucket.head(key);
          if (object === null) return null;
          const raw = object.httpEtag ?? object.etag;
          return {
            size: object.size,
            etag: raw === undefined ? null : normalizeEtag(raw),
            uploaded:
              object.uploaded === undefined
                ? null
                : object.uploaded.toISOString(),
          };
        },
        catch: (cause) =>
          new CatalogError({
            message: `heading ${key} in the artifact bucket failed`,
            cause,
          }),
      }),
    putBytes: (key, bytes, contentType) =>
      Effect.tryPromise({
        try: async () => {
          const result = (await bucket.put(key, bytes, {
            ...(contentType === undefined
              ? {}
              : { httpMetadata: { contentType } }),
          })) as CatalogPutResultLike | null;
          const raw = result?.httpEtag ?? result?.etag;
          return raw === undefined ? null : normalizeEtag(raw);
        },
        catch: (cause) =>
          new CatalogError({
            message: `writing ${key} to the artifact bucket failed`,
            cause,
          }),
      }),
  });
