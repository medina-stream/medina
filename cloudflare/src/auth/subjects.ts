/**
 * subjects.ts — reads, writes, and derivations over the app-owned
 * authority records (subjects + credentials + identifier index).
 *
 * Both persistence adapters are built on these helpers so the two
 * can never disagree about what the current authority state is: the
 * AuthenticationRevision a password snapshot carries and the
 * securityRevision a session is checked against come from the same
 * functions.
 *
 * Also here: `provisionSubject` (create the account record) and
 * `registerPassword` — the registration operation. Registration is
 * NOT part of PasswordPersistence in the framework: it is a
 * separate app-owned port (RegistrationAuthority, generated inside
 * makePasswordMethod with tag
 * `effect-auth/password/<moduleId>/RegistrationAuthority`) whose
 * input is { moduleId, requestId, identifier, registration,
 * replacement } and whose prepare receives a
 * PasswordRegistrationDecision. `registerPassword` implements
 * exactly that operation's semantics over this store — idempotent
 * by requestId, never adopting an existing login — as a plain
 * function the integration step can wrap in that service. Medina's
 * registration payload (the framework's app-defined Registration
 * codec) is `{ displayName }`.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { SubjectId } from "@yielded/auth/Schema";
import {
  EncodedPasswordHash,
  type PasswordCredentialSnapshot,
  type PasswordRegistrationDecision,
  type PasswordReplacement,
} from "@yielded/auth/Password";
import { LoginIdentifier } from "@yielded/auth/Identity";
import type { AuthenticationRevision } from "@yielded/auth/Sessions";
import {
  ObjectStoreFailure,
  type ObjectStoreShape,
  type PutCondition,
  type PutResult,
} from "./ObjectStore.ts";
import {
  CredentialRecord,
  IdentifierRecord,
  RegistrationRecord,
  SubjectRecord,
  credentialBySubjectKey,
  credentialKey,
  credentialsBySubjectPrefix,
  identifierKey,
  mintId,
  mintRevision,
  registrationKey,
  subjectKey,
} from "./records.ts";

export interface Versioned<A> {
  readonly value: A;
  readonly etag: string;
}

const decodeFailure = new ObjectStoreFailure({ operation: "decode" });

/** Read + schema-decode one record; null when absent. A present but
 * undecodable record is a store failure, not an absence — the
 * adapters must fail closed, never treat corruption as "no such
 * account". */
export const readRecord = <A, E>(
  store: ObjectStoreShape,
  key: string,
  schema: Schema.Codec<A, E>,
): Effect.Effect<Versioned<A> | null, ObjectStoreFailure> =>
  Effect.gen(function* () {
    const stored = yield* store.get(key);
    if (stored === null) return null;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(stored.value) as E,
      catch: () => decodeFailure,
    });
    const value = yield* Schema.decodeEffect(schema)(parsed).pipe(
      Effect.mapError(() => decodeFailure),
    );
    return { value, etag: stored.etag };
  });

export const writeRecord = <A, E>(
  store: ObjectStoreShape,
  key: string,
  schema: Schema.Codec<A, E>,
  value: A,
  condition: PutCondition,
): Effect.Effect<PutResult, ObjectStoreFailure> =>
  Effect.flatMap(
    Schema.encodeEffect(schema)(value).pipe(
      Effect.mapError(() => new ObjectStoreFailure({ operation: "encode" })),
    ),
    (encoded) => store.put(key, JSON.stringify(encoded), condition),
  );

export const readSubject = (
  store: ObjectStoreShape,
  subjectId: string,
): Effect.Effect<Versioned<SubjectRecord> | null, ObjectStoreFailure> =>
  readRecord(store, subjectKey(subjectId), SubjectRecord);

export const readCredential = (
  store: ObjectStoreShape,
  credentialId: string,
): Effect.Effect<Versioned<CredentialRecord> | null, ObjectStoreFailure> =>
  readRecord(store, credentialKey(credentialId), CredentialRecord);

export const readIdentifier = (
  store: ObjectStoreShape,
  identifier: { readonly namespace: string; readonly value: string },
): Effect.Effect<Versioned<IdentifierRecord> | null, ObjectStoreFailure> =>
  readRecord(store, identifierKey(identifier), IdentifierRecord);

/** All credential records owned by a subject, ordered by
 * credentialId so revision vectors are deterministic. */
export const listSubjectCredentials = (
  store: ObjectStoreShape,
  subjectId: string,
): Effect.Effect<ReadonlyArray<Versioned<CredentialRecord>>, ObjectStoreFailure> =>
  Effect.gen(function* () {
    const keys = yield* store.list(credentialsBySubjectPrefix(subjectId));
    const records: Array<Versioned<CredentialRecord>> = [];
    for (const key of keys) {
      const credentialId = decodeURIComponent(
        key.slice(credentialsBySubjectPrefix(subjectId).length),
      );
      const record = yield* readCredential(store, credentialId);
      if (record !== null) records.push(record);
    }
    return records.sort((a, b) =>
      a.value.credentialId < b.value.credentialId
        ? -1
        : a.value.credentialId > b.value.credentialId
          ? 1
          : 0,
    );
  });

/** The complete active factor revision vector for a subject, in the
 * framework's AuthenticationRevision shape. */
export const currentRevision = (
  subject: SubjectRecord,
  credentials: ReadonlyArray<CredentialRecord>,
): AuthenticationRevision => ({
  subjectId: subject.subjectId,
  securityRevision: subject.securityRevision,
  credentials: [...credentials]
    .sort((a, b) =>
      a.credentialId < b.credentialId ? -1 : a.credentialId > b.credentialId ? 1 : 0,
    )
    .map((credential) => ({
      credentialId: credential.credentialId,
      revision: credential.credentialRevision,
    })),
});

/** Project a stored credential into the framework's snapshot shape,
 * given the authority revision in force at read time. */
export const snapshotOf = (
  credential: CredentialRecord,
  revision: AuthenticationRevision,
): PasswordCredentialSnapshot => ({
  moduleId: credential.moduleId,
  revision,
  credentialId: credential.credentialId,
  credentialRevision: credential.credentialRevision,
  verifierVersion: credential.verifierVersion,
  verifier: Redacted.make(EncodedPasswordHash.make(credential.verifier)),
  normalization: credential.normalization,
  identifier: LoginIdentifier.make({
    namespace: credential.identifier.namespace,
    value: credential.identifier.value,
  }),
  identifierBindingRevision: credential.identifierBindingRevision,
  ...(credential.identifierVerifiedAtMillis === undefined
    ? {}
    : { identifierVerifiedAtMillis: credential.identifierVerifiedAtMillis }),
});

/** Create the subject record if absent (idempotent). Returns the
 * record in force and whether this call created it. */
export const provisionSubject = (
  store: ObjectStoreShape,
  input: {
    readonly subjectId?: SubjectId;
    readonly displayName: string;
    readonly identifier: { readonly namespace: string; readonly value: string };
  },
): Effect.Effect<
  { readonly subject: SubjectRecord; readonly created: boolean },
  ObjectStoreFailure
> =>
  Effect.gen(function* () {
    const subjectId = input.subjectId ?? (mintId("sub") as SubjectId);
    const record: SubjectRecord = {
      subjectId,
      status: "active",
      securityRevision: mintRevision(),
      displayName: input.displayName,
      loginIdentifier: input.identifier,
    };
    const result = yield* writeRecord(
      store,
      subjectKey(subjectId),
      SubjectRecord,
      record,
      { _tag: "IfAbsent" },
    );
    if (result._tag === "Written") return { subject: record, created: true };
    const existing = yield* readSubject(store, subjectId);
    if (existing === null) {
      return yield* new ObjectStoreFailure({ operation: "provision" });
    }
    return { subject: existing.value, created: false };
  });

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
 * The RegistrationAuthority operation, as a plain function over the
 * store. Semantics per the framework: join application provisioning
 * + the (unverified) identifier + the create-if-absent password
 * under one owner; provision idempotently by requestId; never adopt
 * or replace an existing login; suppress conflicts uniformly as
 * `{ _tag: "Suppressed" }` without exposing the existing subject.
 *
 * Subject and credential ids are derived deterministically from the
 * requestId, so a retry after a crash mid-provisioning converges on
 * the same records instead of orphaning a second account.
 */
export const registerPassword = (
  store: ObjectStoreShape,
  input: {
    readonly moduleId: string;
    readonly requestId: string;
    readonly identifier: { readonly namespace: string; readonly value: string };
    readonly replacement: PasswordReplacement;
    readonly displayName: string;
  },
): Effect.Effect<PasswordRegistrationDecision, ObjectStoreFailure> =>
  Effect.gen(function* () {
    const key = registrationKey(input.requestId);
    const prior = yield* readRecord(store, key, RegistrationRecord);
    if (prior !== null) return prior.value.decision;

    const suffix = (yield* sha256Hex(`medina-registration:${input.requestId}`)).slice(
      0,
      24,
    );
    const subjectId = `sub_${suffix}` as SubjectId;
    const credentialId = `cred_${suffix}`;

    const binding = yield* readIdentifier(store, input.identifier);
    if (binding !== null && binding.value.credentialId !== credentialId) {
      const decision: PasswordRegistrationDecision = { _tag: "Suppressed" };
      const written = yield* writeRecord(
        store,
        key,
        RegistrationRecord,
        { decision },
        { _tag: "IfAbsent" },
      );
      if (written._tag === "Conflict") {
        const winner = yield* readRecord(store, key, RegistrationRecord);
        if (winner !== null) return winner.value.decision;
      }
      return decision;
    }

    const decision: PasswordRegistrationDecision = {
      _tag: "Created",
      subjectId,
    };
    const written = yield* writeRecord(
      store,
      key,
      RegistrationRecord,
      { decision },
      { _tag: "IfAbsent" },
    );
    if (written._tag === "Conflict") {
      const winner = yield* readRecord(store, key, RegistrationRecord);
      if (winner !== null) return winner.value.decision;
      return yield* new ObjectStoreFailure({ operation: "register" });
    }

    // Provision idempotently: every write is create-if-absent, so a
    // retry fills whatever a crashed first attempt missed. The
    // identifier starts unverified (no identifierVerifiedAtMillis):
    // verification is a later flow, per the framework's model.
    yield* provisionSubject(store, {
      subjectId,
      displayName: input.displayName,
      identifier: input.identifier,
    });
    const credential: CredentialRecord = {
      moduleId: input.moduleId,
      credentialId,
      subjectId,
      credentialRevision: mintRevision(),
      verifierVersion: mintRevision(),
      verifier: Redacted.value(input.replacement.verifier),
      normalization: input.replacement.normalization,
      identifier: input.identifier,
      identifierBindingRevision: mintRevision(),
    };
    yield* writeRecord(
      store,
      credentialKey(credentialId),
      CredentialRecord,
      credential,
      { _tag: "IfAbsent" },
    );
    yield* store.put(
      credentialBySubjectKey(subjectId, credentialId),
      input.moduleId,
      { _tag: "IfAbsent" },
    );
    yield* writeRecord(
      store,
      identifierKey(input.identifier),
      IdentifierRecord,
      { moduleId: input.moduleId, credentialId, subjectId },
      { _tag: "IfAbsent" },
    );
    return decision;
  });
