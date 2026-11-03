/**
 * ObjectStore — the one storage primitive the auth persistence
 * adapters are built on: a string-valued key/value store whose puts
 * are conditional on etags (compare-and-swap).
 *
 * Why this shape: the yielded framework's persistence ports demand
 * CAS + commit-journal semantics, and R2 — the production backend —
 * has no transactions but does have etag-conditional puts
 * (`onlyIf.etagMatches` / `etagDoesNotMatch`). Every guard in the
 * adapters is therefore expressed as: read (value, etag) → decide →
 * `prepare(...)` into the commit journal → conditional write. A lost
 * conditional write is the store saying the world moved; the
 * adapters translate that into the framework's typed failures.
 *
 * Two implementations live here:
 *  - `layerMemory` / `makeMemoryObjectStore` — an in-process Map,
 *    used by the unit tests and usable for local dev.
 *  - `layerR2` — over a structural slice of the R2 bucket binding
 *    (the same no-workers-types approach as src/worker.ts). In
 *    production this binds to the ARTIFACTS bucket under the
 *    `auth/v1/` key prefix (see records.ts).
 *
 * Error messages carry the operation only — never a key or value:
 * keys embed login identifiers and values embed password verifiers.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ObjectStoreFailure extends Schema.TaggedError<ObjectStoreFailure>()(
  "ObjectStoreFailure",
  { operation: Schema.String },
) {}

export interface StoredObject {
  readonly value: string;
  readonly etag: string;
}

export type PutCondition =
  | { readonly _tag: "Any" }
  | { readonly _tag: "IfAbsent" }
  | { readonly _tag: "IfMatch"; readonly etag: string };

export type PutResult =
  | { readonly _tag: "Written"; readonly etag: string }
  | { readonly _tag: "Conflict" };

export interface ObjectStoreShape {
  readonly get: (
    key: string,
  ) => Effect.Effect<StoredObject | null, ObjectStoreFailure>;
  readonly put: (
    key: string,
    value: string,
    condition: PutCondition,
  ) => Effect.Effect<PutResult, ObjectStoreFailure>;
  readonly remove: (
    key: string,
  ) => Effect.Effect<boolean, ObjectStoreFailure>;
  readonly list: (
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<string>, ObjectStoreFailure>;
}

export class ObjectStore extends Context.Service<ObjectStore, ObjectStoreShape>()(
  "medina-auth/ObjectStore",
) {}

const failure = (operation: string) => () =>
  new ObjectStoreFailure({ operation });

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export const makeMemoryObjectStore = (): ObjectStoreShape => {
  const entries = new Map<string, StoredObject>();
  let counter = 0;
  const nextEtag = () => `mem-${++counter}`;

  return {
    get: (key) => Effect.sync(() => entries.get(key) ?? null),
    put: (key, value, condition) =>
      Effect.sync((): PutResult => {
        const current = entries.get(key);
        if (condition._tag === "IfAbsent" && current !== undefined) {
          return { _tag: "Conflict" };
        }
        if (
          condition._tag === "IfMatch" &&
          (current === undefined || current.etag !== condition.etag)
        ) {
          return { _tag: "Conflict" };
        }
        const etag = nextEtag();
        entries.set(key, { value, etag });
        return { _tag: "Written", etag };
      }),
    remove: (key) => Effect.sync(() => entries.delete(key)),
    list: (prefix) =>
      Effect.sync(() =>
        [...entries.keys()].filter((key) => key.startsWith(prefix)).sort(),
      ),
  };
};

export const layerMemory = Layer.succeed(ObjectStore, makeMemoryObjectStore());

// ---------------------------------------------------------------------------
// R2 implementation
// ---------------------------------------------------------------------------

/** The slice of an R2 bucket binding the store uses. A real
 * `R2Bucket` satisfies this structurally; `put` resolves to `null`
 * when an `onlyIf` condition fails, per the R2 API. */
export interface R2BucketBindingLike {
  get(key: string): Promise<{
    readonly etag: string;
    text(): Promise<string>;
  } | null>;
  put(
    key: string,
    value: string,
    options?: {
      readonly onlyIf?:
        | { readonly etagMatches: string }
        | { readonly etagDoesNotMatch: string };
      readonly httpMetadata?: { readonly contentType?: string };
    },
  ): Promise<{ readonly etag: string } | null>;
  delete(key: string): Promise<void>;
  list(options: {
    readonly prefix?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<{
    readonly objects: ReadonlyArray<{ readonly key: string }>;
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

export const makeR2ObjectStore = (
  bucket: R2BucketBindingLike,
): ObjectStoreShape => ({
  get: (key) =>
    Effect.tryPromise({
      try: async () => {
        const object = await bucket.get(key);
        if (object === null) return null;
        return { value: await object.text(), etag: object.etag };
      },
      catch: failure("get"),
    }),
  put: (key, value, condition) =>
    Effect.tryPromise({
      try: async (): Promise<PutResult> => {
        const onlyIf =
          condition._tag === "IfAbsent"
            ? { etagDoesNotMatch: "*" }
            : condition._tag === "IfMatch"
              ? { etagMatches: condition.etag }
              : undefined;
        const written = await bucket.put(key, value, {
          ...(onlyIf === undefined ? {} : { onlyIf }),
          httpMetadata: { contentType: "application/json" },
        });
        return written === null
          ? { _tag: "Conflict" }
          : { _tag: "Written", etag: written.etag };
      },
      catch: failure("put"),
    }),
  remove: (key) =>
    Effect.tryPromise({
      try: async () => {
        const existing = await bucket.get(key);
        if (existing === null) return false;
        await bucket.delete(key);
        return true;
      },
      catch: failure("remove"),
    }),
  list: (prefix) =>
    Effect.tryPromise({
      try: async () => {
        const keys: Array<string> = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await bucket.list({
            prefix,
            limit: 1000,
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const object of page.objects) keys.push(object.key);
          if (!page.truncated || page.cursor === undefined) return keys;
          cursor = page.cursor;
        }
      },
      catch: failure("list"),
    }),
});

export const layerR2 = (
  bucket: R2BucketBindingLike,
): Layer.Layer<ObjectStore> => Layer.succeed(ObjectStore, makeR2ObjectStore(bucket));
