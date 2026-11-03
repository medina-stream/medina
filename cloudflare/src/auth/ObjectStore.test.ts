import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import {
  makeMemoryObjectStore,
  makeR2ObjectStore,
  type ObjectStoreShape,
  type R2BucketBindingLike,
} from "./ObjectStore.ts";

const exercise = async (store: ObjectStoreShape) => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  assert.equal(await run(store.get("k1")), null);

  const first = await run(store.put("k1", "v1", { _tag: "IfAbsent" }));
  assert.equal(first._tag, "Written");

  const dupe = await run(store.put("k1", "v2", { _tag: "IfAbsent" }));
  assert.equal(dupe._tag, "Conflict");
  assert.equal((await run(store.get("k1")))?.value, "v1");

  const etag = (await run(store.get("k1")))?.etag;
  assert.ok(etag !== undefined);

  const stale = await run(
    store.put("k1", "v3", { _tag: "IfMatch", etag: "not-the-etag" }),
  );
  assert.equal(stale._tag, "Conflict");

  const swapped = await run(store.put("k1", "v3", { _tag: "IfMatch", etag }));
  assert.equal(swapped._tag, "Written");
  assert.equal((await run(store.get("k1")))?.value, "v3");

  await run(store.put("auth/v1/a", "1", { _tag: "Any" }));
  await run(store.put("auth/v1/b", "2", { _tag: "Any" }));
  await run(store.put("other/c", "3", { _tag: "Any" }));
  assert.deepEqual(await run(store.list("auth/v1/")), ["auth/v1/a", "auth/v1/b"]);

  assert.equal(await run(store.remove("k1")), true);
  assert.equal(await run(store.remove("k1")), false);
  assert.equal(await run(store.get("k1")), null);
};

describe("ObjectStore (memory)", () => {
  it("honors etag CAS conditions", async () => {
    await exercise(makeMemoryObjectStore());
  });
});

describe("ObjectStore (R2 over a fake binding)", () => {
  it("honors etag CAS conditions through onlyIf puts", async () => {
    // A minimal in-memory stand-in for the R2 binding contract,
    // including put resolving to null on a failed onlyIf.
    const objects = new Map<string, { value: string; etag: string }>();
    let counter = 0;
    const bucket: R2BucketBindingLike = {
      get: async (key) => {
        const found = objects.get(key);
        return found === undefined
          ? null
          : { etag: found.etag, text: async () => found.value };
      },
      put: async (key, value, options) => {
        const current = objects.get(key);
        const onlyIf = options?.onlyIf;
        if (onlyIf !== undefined && "etagDoesNotMatch" in onlyIf && current !== undefined) {
          return null;
        }
        if (
          onlyIf !== undefined &&
          "etagMatches" in onlyIf &&
          current?.etag !== onlyIf.etagMatches
        ) {
          return null;
        }
        const etag = `r2-${++counter}`;
        objects.set(key, { value, etag });
        return { etag };
      },
      delete: async (key) => {
        objects.delete(key);
      },
      list: async ({ prefix }) => ({
        objects: [...objects.keys()]
          .filter((key) => prefix === undefined || key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }),
    };
    await exercise(makeR2ObjectStore(bucket));
  });
});
