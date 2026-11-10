import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { hooksLayer } from "@yielded/auth/Persistence";
import { LoginIdentifier } from "@yielded/auth/Identity";
import {
  EncodedPasswordHash,
  type PasswordCredentialSnapshot,
} from "@yielded/auth/Password";
import type { ProofRedemptionPlan } from "@yielded/auth/Proofs";
import { makeMemoryObjectStore, type ObjectStoreShape } from "./ObjectStore.ts";
import { makePasswordPersistence } from "./PasswordPersistence.ts";
import { provisionSubject, registerPassword } from "./subjects.ts";
import {
  IDENTIFIER,
  MODULE_ID,
  commitFailureTag,
  failureTag,
  mutationInput,
  prepareValue,
  readPrepared,
  replacement,
  runCommit,
} from "./test-helpers.ts";

const register = (
  store: ObjectStoreShape,
  requestId = "req-1",
  verifier = "verifier-v1",
) =>
  Effect.runPromise(
    registerPassword(store, {
      moduleId: MODULE_ID,
      requestId,
      identifier: IDENTIFIER,
      replacement: replacement(verifier),
      displayName: "Scott",
    }),
  );

const find = (
  persistence: ReturnType<typeof makePasswordPersistence>,
  identifier: { namespace: string; value: string } = IDENTIFIER,
) =>
  Effect.runPromise(
    persistence.findCredential({
      moduleId: MODULE_ID,
      identifier: LoginIdentifier.make(identifier),
    }),
  );

const someSnapshot = async (
  persistence: ReturnType<typeof makePasswordPersistence>,
): Promise<PasswordCredentialSnapshot> => {
  const found = await find(persistence);
  assert.ok(Option.isSome(found), "expected a credential snapshot");
  return found.value;
};

describe("registration (registerPassword)", () => {
  it("creates a credential that findCredential returns coherently", async () => {
    const store = makeMemoryObjectStore();
    const persistence = makePasswordPersistence(store);
    const decision = await register(store);
    assert.equal(decision._tag, "Created");
    if (decision._tag !== "Created") return;

    const snapshot = await someSnapshot(persistence);
    assert.equal(snapshot.moduleId, MODULE_ID);
    assert.equal(snapshot.revision.subjectId, decision.subjectId);
    assert.equal(Redacted.value(snapshot.verifier), "verifier-v1");
    assert.equal(snapshot.identifier.namespace, "email");
    assert.equal(snapshot.identifier.value, IDENTIFIER.value);
    assert.equal(snapshot.revision.credentials.length, 1);
    assert.equal(
      snapshot.revision.credentials[0]?.credentialId,
      snapshot.credentialId,
    );
    assert.equal(
      snapshot.revision.credentials[0]?.revision,
      snapshot.credentialRevision,
    );

    const bySubject = await Effect.runPromise(
      persistence.readForSubject({
        moduleId: MODULE_ID,
        subjectId: decision.subjectId,
      }),
    );
    assert.ok(Option.isSome(bySubject));

    // The identifier starts unverified: no recovery target yet.
    const recovery = await Effect.runPromise(
      persistence.recoveryTarget({
        moduleId: MODULE_ID,
        identifier: LoginIdentifier.make(IDENTIFIER),
      }),
    );
    assert.ok(Option.isNone(recovery));
  });

  it("suppresses unknown identifiers, wrong modules, wrong subjects", async () => {
    const store = makeMemoryObjectStore();
    const persistence = makePasswordPersistence(store);
    await register(store);

    const unknown = await find(persistence, {
      namespace: "email",
      value: "nobody@example.com",
    });
    assert.ok(Option.isNone(unknown));

    const wrongModule = await Effect.runPromise(
      persistence.findCredential({
        moduleId: "other/module",
        identifier: LoginIdentifier.make(IDENTIFIER),
      }),
    );
    assert.ok(Option.isNone(wrongModule));

    const wrongSubject = await Effect.runPromise(
      persistence.findCredential({
        moduleId: MODULE_ID,
        identifier: LoginIdentifier.make(IDENTIFIER),
        subjectId: "sub_someone_else" as PasswordCredentialSnapshot["revision"]["subjectId"],
      }),
    );
    assert.ok(Option.isNone(wrongSubject));
  });

  it("is idempotent by requestId and never adopts an existing login", async () => {
    const store = makeMemoryObjectStore();
    const persistence = makePasswordPersistence(store);

    const first = await register(store, "req-1");
    const retry = await register(store, "req-1", "verifier-RETRY");
    assert.deepEqual(retry, first);

    const duplicate = await register(store, "req-2", "verifier-OTHER");
    assert.equal(duplicate._tag, "Suppressed");

    const snapshot = await someSnapshot(persistence);
    assert.equal(Redacted.value(snapshot.verifier), "verifier-v1");
  });
});

describe("PasswordPersistence.addIfAbsent", () => {
  it("binds a first password; a second add commits as rejected", async () => {
    const store = makeMemoryObjectStore();
    const persistence = makePasswordPersistence(store);
    const { subject } = await Effect.runPromise(
      provisionSubject(store, { displayName: "Scott", identifier: IDENTIFIER }),
    );
    const freshRevision = {
      subjectId: subject.subjectId,
      securityRevision: subject.securityRevision,
      credentials: [],
    };

    const prepared = await runCommit(() =>
      persistence.addIfAbsent(
        mutationInput({
          expectedRevision: freshRevision,
          replacement: replacement("verifier-v1"),
        }),
        prepareValue,
      ),
    );
    assert.equal(await readPrepared(prepared), "changed");

    const snapshot = await someSnapshot(persistence);
    assert.equal(Redacted.value(snapshot.verifier), "verifier-v1");

    const second = await runCommit(() =>
      persistence.addIfAbsent(
        mutationInput({
          expectedRevision: snapshot.revision,
          replacement: replacement("verifier-v2"),
          commandId: "cmd-2",
        }),
        prepareValue,
      ),
    );
    assert.equal(await readPrepared(second), "rejected");
    assert.equal(
      Redacted.value((await someSnapshot(persistence)).verifier),
      "verifier-v1",
    );
  });

  it("roots its own commit when no journal is ambient", async () => {
    const store = makeMemoryObjectStore();
    const persistence = makePasswordPersistence(store);
    const { subject } = await Effect.runPromise(
      provisionSubject(store, { displayName: "Scott", identifier: IDENTIFIER }),
    );
    // Production shape: no ambient root — the port opens its own,
    // so the prepared decision reads as soon as the call returns.
    const prepared = await Effect.runPromise(
      persistence
        .addIfAbsent(
          mutationInput({
            expectedRevision: {
              subjectId: subject.subjectId,
              securityRevision: subject.securityRevision,
              credentials: [],
            },
            replacement: replacement("verifier-v1"),
          }),
          prepareValue,
        )
        .pipe(Effect.provide(hooksLayer)),
    );
    assert.equal(await readPrepared(prepared), "changed");
    const snapshot = await someSnapshot(persistence);
    assert.equal(Redacted.value(snapshot.verifier), "verifier-v1");
  });
});

describe("PasswordPersistence.replaceIfCurrent", () => {
  it("replaces the verifier and bumps credential + security revisions", async () => {
    const store = makeMemoryObjectStore();
    const persistence = makePasswordPersistence(store);
    await register(store);
    const before = await someSnapshot(persistence);

    const prepared = await runCommit(() =>
      persistence.replaceIfCurrent(
        mutationInput({
          expectedRevision: before.revision,
          credential: before,
          replacement: replacement("verifier-v2"),
        }),
        prepareValue,
      ),
    );
    assert.equal(await readPrepared(prepared), "changed");

    const after = await someSnapshot(persistence);
    assert.equal(Redacted.value(after.verifier), "verifier-v2");
    assert.notEqual(after.credentialRevision, before.credentialRevision);
    assert.notEqual(after.verifierVersion, before.verifierVersion);
    assert.notEqual(
      after.revision.securityRevision,
      before.revision.securityRevision,
    );
    assert.equal(after.credentialId, before.credentialId);
  });

  it("loses the CAS when the snapshot is stale, even with a fresh revision", async () => {
    const store = makeMemoryObjectStore();
    const persistence = makePasswordPersistence(store);
    await register(store);
    const stale = await someSnapshot(persistence);

    await runCommit(() =>
      persistence.replaceIfCurrent(
        mutationInput({
          expectedRevision: stale.revision,
          credential: stale,
          replacement: replacement("verifier-v2"),
        }),
        prepareValue,
      ),
    );
    const fresh = await someSnapshot(persistence);

    // Fresh authority revision, stale credential snapshot: the exact
    // credential CAS must lose.
    const tag = await commitFailureTag(() =>
      persistence.replaceIfCurrent(
        mutationInput({
          expectedRevision: fresh.revision,
          credential: stale,
          replacement: replacement("verifier-v3"),
          commandId: "cmd-2",
        }),
        prepareValue,
      ),
    );
    assert.equal(tag, "PasswordUnavailable");
    assert.equal(
      Redacted.value((await someSnapshot(persistence)).verifier),
      "verifier-v2",
    );
  });
});

describe("PasswordPersistence.rehashIfCurrent", () => {
  it("swaps only verifier + verifierVersion; stale snapshots are no-ops", async () => {
    const store = makeMemoryObjectStore();
    const persistence = makePasswordPersistence(store);
    await register(store);
    const before = await someSnapshot(persistence);

    await Effect.runPromise(
      persistence.rehashIfCurrent({
        credential: before,
        nextVerifier: Redacted.make(EncodedPasswordHash.make("verifier-v1-new-cost")),
      }),
    );
    const after = await someSnapshot(persistence);
    assert.equal(Redacted.value(after.verifier), "verifier-v1-new-cost");
    assert.notEqual(after.verifierVersion, before.verifierVersion);
    assert.equal(after.credentialRevision, before.credentialRevision);
    assert.equal(
      after.revision.securityRevision,
      before.revision.securityRevision,
    );

    // The pre-rehash snapshot no longer matches: silent no-op.
    await Effect.runPromise(
      persistence.rehashIfCurrent({
        credential: before,
        nextVerifier: Redacted.make(EncodedPasswordHash.make("verifier-STALE")),
      }),
    );
    assert.equal(
      Redacted.value((await someSnapshot(persistence)).verifier),
      "verifier-v1-new-cost",
    );
  });
});

describe("PasswordPersistence.resetWithProof", () => {
  const fakePlan = (seen: { decision?: string; called: boolean }) =>
    ({
      // The adapter treats the plan as opaque: it never reads
      // `input`, it only stages `prepare` into the journal.
      input: undefined as unknown as ProofRedemptionPlan["input"],
      prepare: (decision, journal, project) => {
        seen.called = true;
        seen.decision = decision;
        return journal.prepare(project(decision));
      },
    }) satisfies ProofRedemptionPlan;

  it("redeems the proof in the same commit as the replacement", async () => {
    const store = makeMemoryObjectStore();
    const persistence = makePasswordPersistence(store);
    await register(store);
    const before = await someSnapshot(persistence);
    const seen: { decision?: string; called: boolean } = { called: false };

    const prepared = await runCommit(() =>
      persistence.resetWithProof(
        {
          ...mutationInput({
            expectedRevision: before.revision,
            credential: before,
            replacement: replacement("verifier-reset"),
          }),
          redemption: fakePlan(seen),
        },
        prepareValue,
      ),
    );
    assert.equal(await readPrepared(prepared), "changed");
    assert.equal(seen.called, true);
    assert.equal(seen.decision, "redeemed");
    assert.equal(
      Redacted.value((await someSnapshot(persistence)).verifier),
      "verifier-reset",
    );
  });

  it("never stages the redemption when the credential guard loses", async () => {
    const store = makeMemoryObjectStore();
    const persistence = makePasswordPersistence(store);
    await register(store);
    const stale = await someSnapshot(persistence);
    await runCommit(() =>
      persistence.replaceIfCurrent(
        mutationInput({
          expectedRevision: stale.revision,
          credential: stale,
          replacement: replacement("verifier-v2"),
        }),
        prepareValue,
      ),
    );
    const seen: { decision?: string; called: boolean } = { called: false };
    const tag = await commitFailureTag(() =>
      persistence.resetWithProof(
        {
          ...mutationInput({
            expectedRevision: stale.revision,
            credential: stale,
            replacement: replacement("verifier-reset"),
            commandId: "cmd-2",
          }),
          redemption: fakePlan(seen),
        },
        prepareValue,
      ),
    );
    assert.equal(tag, "PasswordUnavailable");
    assert.equal(seen.called, false);
  });
});
