/**
 * PasswordPersistence — Medina's bucket-backed implementation of
 * the framework's password persistence port
 * (@yielded/auth/src/password/methods/PasswordPersistence.ts).
 *
 * The port's contract, and how this adapter meets it on a store
 * with no transactions:
 *
 *  - Commit journal: every mutation first requires the ambient
 *    CurrentCommitJournal (provided by the framework's
 *    coordinateCommit at the operation boundary). No journal → the
 *    mutation fails with PasswordUnavailable before any write —
 *    the port's "a root service must reject ambient use it cannot
 *    join". The adapter calls the caller's `prepare` BEFORE its
 *    physical writes (the batch-owner order the framework
 *    documents); if a write then loses its CAS, the adapter fails
 *    and the root commit discards everything the journal staged.
 *  - CAS: guards are read (value, etag) pairs; writes are
 *    etag-conditional puts. A lost conditional write is a lost
 *    guard and maps to PasswordUnavailable — the port's documented
 *    D1 behavior ("a lost guard aborts the batch and returns
 *    unavailable") — except rehashIfCurrent, where a lost CAS is a
 *    specified no-op, and addIfAbsent's already-exists case, which
 *    is a committed "rejected" decision value, not an error.
 *  - Revisions: addIfAbsent does not bump the subject
 *    securityRevision (the port calls out the bump only for
 *    replaceIfCurrent); the factor-vector change is itself visible
 *    to fresh authority captures. replaceIfCurrent and
 *    resetWithProof bump the credential's semantic revision, its
 *    verifier version, and the subject securityRevision in the same
 *    operation — the bump is what invalidates existing sessions,
 *    since StatefulSessionPersistence.verify compares each session
 *    record's securityRevision against the subject's current one.
 *  - Identifiers: this app has exactly one login identifier per
 *    account, recorded on the subject at registration;
 *    addIfAbsent binds the new credential to it (PasswordMutationInput
 *    carries no identifier). identifierVerifiedAtMillis is never
 *    set by this adapter — nothing here observes identifier
 *    verification — so recoveryTarget returns None until a
 *    verification flow exists. Password reset therefore stays
 *    ineligible in this increment; see README.
 *
 * Known substrate limit: a mutation writes two or three objects
 * (credential, index, subject). The writes are individually
 * conditional and all guards are re-derivable from the records, so
 * a crash mid-mutation leaves a state the next read either accepts
 * coherently or fails closed on — never a silently wrong success.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  PasswordPersistence,
  PasswordUnavailable,
  type PasswordMutationInput,
} from "@yielded/auth/Password";
import type { AuthenticationRevision } from "@yielded/auth/Sessions";
import {
  CurrentCommitJournal,
  type CommitJournal,
} from "@yielded/auth/Hooks";
import {
  ObjectStore,
  ObjectStoreFailure,
  type ObjectStoreShape,
} from "./ObjectStore.ts";
import {
  CredentialRecord,
  IdentifierRecord,
  SubjectRecord,
  credentialBySubjectKey,
  credentialKey,
  identifierKey,
  mintId,
  mintRevision,
  subjectKey,
} from "./records.ts";
import {
  type Versioned,
  currentRevision,
  listSubjectCredentials,
  readCredential,
  readIdentifier,
  readSubject,
  snapshotOf,
  writeRecord,
} from "./subjects.ts";

const unavailable = PasswordUnavailable.make({});

type Failure = PasswordUnavailable;

const orUnavailable = <A, R>(
  effect: Effect.Effect<A, Failure | ObjectStoreFailure, R>,
): Effect.Effect<A, Failure, R> =>
  effect.pipe(
    Effect.catchTag("ObjectStoreFailure", () => Effect.fail(unavailable)),
  );

const requireJournal: Effect.Effect<CommitJournal, Failure> = Effect.flatMap(
  Effect.serviceOption(CurrentCommitJournal),
  (journal) =>
    Option.isSome(journal)
      ? Effect.succeed(journal.value)
      : Effect.fail(unavailable),
);

interface AuthorityState {
  readonly subject: Versioned<SubjectRecord>;
  readonly credentials: ReadonlyArray<Versioned<CredentialRecord>>;
}

const readAuthority = (
  store: ObjectStoreShape,
  subjectId: string,
): Effect.Effect<AuthorityState, Failure | ObjectStoreFailure> =>
  Effect.gen(function* () {
    const subject = yield* readSubject(store, subjectId);
    if (subject === null) return yield* Effect.fail(unavailable);
    const credentials = yield* listSubjectCredentials(store, subjectId);
    return { subject, credentials };
  });

/** The captured revision must still be the authority's revision:
 * same subject, same securityRevision, same complete factor vector. */
const checkExpectedRevision = (
  state: AuthorityState,
  expected: AuthenticationRevision,
): Effect.Effect<void, Failure> =>
  Effect.gen(function* () {
    const current = currentRevision(
      state.subject.value,
      state.credentials.map((entry) => entry.value),
    );
    if (expected.subjectId !== current.subjectId) {
      return yield* Effect.fail(unavailable);
    }
    if (expected.securityRevision !== current.securityRevision) {
      return yield* Effect.fail(unavailable);
    }
    if (expected.credentials.length !== current.credentials.length) {
      return yield* Effect.fail(unavailable);
    }
    const byId = new Map(
      current.credentials.map((entry) => [entry.credentialId, entry.revision]),
    );
    for (const entry of expected.credentials) {
      if (byId.get(entry.credentialId) !== entry.revision) {
        return yield* Effect.fail(unavailable);
      }
    }
  });

const findSnapshot = (
  store: ObjectStoreShape,
  input: {
    readonly moduleId: string;
    readonly identifier: { readonly namespace: string; readonly value: string };
    readonly subjectId?: string;
    readonly requireVerified: boolean;
  },
) =>
  Effect.gen(function* () {
    const binding = yield* readIdentifier(store, input.identifier);
    if (binding === null) return Option.none();
    if (binding.value.moduleId !== input.moduleId) return Option.none();
    if (
      input.subjectId !== undefined &&
      binding.value.subjectId !== input.subjectId
    ) {
      return Option.none();
    }
    const credential = yield* readCredential(store, binding.value.credentialId);
    if (credential === null) return Option.none();
    const record = credential.value;
    if (record.moduleId !== input.moduleId) return Option.none();
    if (
      record.identifier.namespace !== input.identifier.namespace ||
      record.identifier.value !== input.identifier.value
    ) {
      return Option.none();
    }
    if (input.requireVerified && record.identifierVerifiedAtMillis === undefined) {
      return Option.none();
    }
    const subject = yield* readSubject(store, record.subjectId);
    if (subject === null || subject.value.status !== "active") {
      return Option.none();
    }
    const all = yield* listSubjectCredentials(store, record.subjectId);
    return Option.some(
      snapshotOf(
        record,
        currentRevision(
          subject.value,
          all.map((entry) => entry.value),
        ),
      ),
    );
  });

/** Shared guard for replaceIfCurrent / resetWithProof: current
 * authority, active subject, and an exact CAS match against the
 * snapshot the caller captured. */
const guardMutation = (
  store: ObjectStoreShape,
  input: PasswordMutationInput,
) =>
  Effect.gen(function* () {
    const snapshot = input.credential;
    if (snapshot === undefined) return yield* Effect.fail(unavailable);
    const state = yield* readAuthority(store, input.expectedRevision.subjectId);
    if (state.subject.value.status !== "active") {
      return yield* Effect.fail(unavailable);
    }
    yield* checkExpectedRevision(state, input.expectedRevision);
    const stored = state.credentials.find(
      (entry) => entry.value.credentialId === snapshot.credentialId,
    );
    if (stored === undefined) return yield* Effect.fail(unavailable);
    const current = stored.value;
    const exact =
      current.moduleId === snapshot.moduleId &&
      current.subjectId === snapshot.revision.subjectId &&
      current.credentialRevision === snapshot.credentialRevision &&
      current.verifierVersion === snapshot.verifierVersion &&
      current.verifier === Redacted.value(snapshot.verifier) &&
      current.identifierBindingRevision ===
        snapshot.identifierBindingRevision &&
      current.identifier.namespace === snapshot.identifier.namespace &&
      current.identifier.value === snapshot.identifier.value &&
      current.normalization === snapshot.normalization;
    if (!exact) return yield* Effect.fail(unavailable);
    return { state, stored };
  });

/** Apply a replacement verifier: new credential revision, new
 * verifier version, and the subject securityRevision bump that
 * invalidates existing sessions — each write etag-conditional. */
const applyReplacement = (
  store: ObjectStoreShape,
  state: AuthorityState,
  stored: Versioned<CredentialRecord>,
  input: PasswordMutationInput,
) =>
  Effect.gen(function* () {
    const next: CredentialRecord = {
      ...stored.value,
      verifier: Redacted.value(input.replacement.verifier),
      normalization: input.replacement.normalization,
      credentialRevision: mintRevision(),
      verifierVersion: mintRevision(),
    };
    const credentialWrite = yield* writeRecord(
      store,
      credentialKey(next.credentialId),
      CredentialRecord,
      next,
      { _tag: "IfMatch", etag: stored.etag },
    );
    if (credentialWrite._tag === "Conflict") {
      return yield* Effect.fail(unavailable);
    }
    const subjectWrite = yield* writeRecord(
      store,
      subjectKey(state.subject.value.subjectId),
      SubjectRecord,
      { ...state.subject.value, securityRevision: mintRevision() },
      { _tag: "IfMatch", etag: state.subject.etag },
    );
    if (subjectWrite._tag === "Conflict") {
      return yield* Effect.fail(unavailable);
    }
  });

export const makePasswordPersistence = (
  store: ObjectStoreShape,
): PasswordPersistence["Service"] => ({
  findCredential: (input) =>
    orUnavailable(
      findSnapshot(store, {
        moduleId: input.moduleId,
        identifier: input.identifier,
        ...(input.subjectId === undefined
          ? {}
          : { subjectId: input.subjectId }),
        requireVerified: false,
      }),
    ),

  readForSubject: (input) =>
    orUnavailable(
      Effect.gen(function* () {
        const subject = yield* readSubject(store, input.subjectId);
        if (subject === null || subject.value.status !== "active") {
          return Option.none();
        }
        const all = yield* listSubjectCredentials(store, input.subjectId);
        const own = all.find((entry) => entry.value.moduleId === input.moduleId);
        if (own === undefined) return Option.none();
        return Option.some(
          snapshotOf(
            own.value,
            currentRevision(
              subject.value,
              all.map((entry) => entry.value),
            ),
          ),
        );
      }),
    ),

  recoveryTarget: (input) =>
    orUnavailable(
      findSnapshot(store, {
        moduleId: input.moduleId,
        identifier: input.identifier,
        requireVerified: true,
      }),
    ),

  rehashIfCurrent: (input) =>
    orUnavailable(
      Effect.gen(function* () {
        const stored = yield* readCredential(
          store,
          input.credential.credentialId,
        );
        if (stored === null) return;
        const current = stored.value;
        const snapshot = input.credential;
        const matches =
          current.moduleId === snapshot.moduleId &&
          current.subjectId === snapshot.revision.subjectId &&
          current.credentialRevision === snapshot.credentialRevision &&
          current.verifierVersion === snapshot.verifierVersion &&
          current.verifier === Redacted.value(snapshot.verifier) &&
          current.identifierBindingRevision ===
            snapshot.identifierBindingRevision;
        if (!matches) return;
        // Only verifier + verifierVersion change. A lost CAS here is
        // a specified no-op, so the write result is ignored.
        yield* writeRecord(
          store,
          credentialKey(current.credentialId),
          CredentialRecord,
          {
            ...current,
            verifier: Redacted.value(input.nextVerifier),
            verifierVersion: mintRevision(),
          },
          { _tag: "IfMatch", etag: stored.etag },
        );
      }),
    ),

  addIfAbsent: (input, prepare) =>
    orUnavailable(
      Effect.gen(function* () {
        const journal = yield* requireJournal;
        const state = yield* readAuthority(
          store,
          input.expectedRevision.subjectId,
        );
        if (state.subject.value.status !== "active") {
          return yield* Effect.fail(unavailable);
        }
        yield* checkExpectedRevision(state, input.expectedRevision);
        const existing = state.credentials.find(
          (entry) => entry.value.moduleId === input.moduleId,
        );
        if (existing !== undefined) {
          return yield* Effect.sync(() => prepare("rejected", journal));
        }
        const identifier = state.subject.value.loginIdentifier;
        const binding = yield* readIdentifier(store, identifier);
        if (binding !== null) {
          if (binding.value.subjectId !== state.subject.value.subjectId) {
            return yield* Effect.sync(() => prepare("rejected", journal));
          }
          // Bound to this subject, yet no credential is listed for
          // it: the store disagrees with itself — fail closed.
          return yield* Effect.fail(unavailable);
        }
        const credential: CredentialRecord = {
          moduleId: input.moduleId,
          credentialId: mintId("cred"),
          subjectId: state.subject.value.subjectId,
          credentialRevision: mintRevision(),
          verifierVersion: mintRevision(),
          verifier: Redacted.value(input.replacement.verifier),
          normalization: input.replacement.normalization,
          identifier,
          identifierBindingRevision: mintRevision(),
        };
        const prepared = yield* Effect.sync(() => prepare("changed", journal));
        const credentialWrite = yield* writeRecord(
          store,
          credentialKey(credential.credentialId),
          CredentialRecord,
          credential,
          { _tag: "IfAbsent" },
        );
        if (credentialWrite._tag === "Conflict") {
          return yield* Effect.fail(unavailable);
        }
        const indexWrite = yield* store.put(
          credentialBySubjectKey(credential.subjectId, credential.credentialId),
          input.moduleId,
          { _tag: "IfAbsent" },
        );
        if (indexWrite._tag === "Conflict") {
          return yield* Effect.fail(unavailable);
        }
        const identifierWrite = yield* writeRecord(
          store,
          identifierKey(identifier),
          IdentifierRecord,
          {
            moduleId: input.moduleId,
            credentialId: credential.credentialId,
            subjectId: credential.subjectId,
          },
          { _tag: "IfAbsent" },
        );
        if (identifierWrite._tag === "Conflict") {
          return yield* Effect.fail(unavailable);
        }
        return prepared;
      }),
    ),

  replaceIfCurrent: (input, prepare) =>
    orUnavailable(
      Effect.gen(function* () {
        const journal = yield* requireJournal;
        const { state, stored } = yield* guardMutation(store, input);
        const prepared = yield* Effect.sync(() => prepare("changed", journal));
        yield* applyReplacement(store, state, stored, input);
        return prepared;
      }),
    ),

  resetWithProof: (input, prepare) =>
    orUnavailable(
      Effect.gen(function* () {
        const journal = yield* requireJournal;
        const { state, stored } = yield* guardMutation(store, input);
        const prepared = yield* Effect.sync(() => prepare("changed", journal));
        // Stage the proof redemption into the same journal: the
        // proof is consumed iff the root commit commits, which is
        // exactly "redeemed iff ALL apply" — if applyReplacement
        // loses its CAS below, this whole effect fails and the
        // root commit discards the redemption with everything else.
        yield* Effect.sync(() => {
          input.redemption.prepare("redeemed", journal, (decision) => decision);
        });
        yield* applyReplacement(store, state, stored, input);
        return prepared;
      }),
    ),
});

export const layerPasswordPersistence: Layer.Layer<
  PasswordPersistence,
  never,
  ObjectStore
> = Layer.effect(
  PasswordPersistence,
  Effect.map(ObjectStore, (store) => makePasswordPersistence(store)),
);
