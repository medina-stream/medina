/**
 * SessionPersistence — Medina's bucket-backed implementation of
 * the framework's StatefulSessionPersistence<SessionClaims> port
 * (@yielded/auth/src/sessions/persistence.ts).
 *
 * How the port's semantics map onto etag-CAS object storage:
 *
 *  - IDs: the adapter allocates the sessionId at establish (the
 *    framework's issuance plan deliberately carries none — "consumer
 *    mapping owns IDs").
 *  - establish re-checks, at the conditional write, everything the
 *    sign-in flow captured before credential verification: the
 *    subject is active, the subject's current securityRevision
 *    equals both the session's and the evidence's, the evidence's
 *    factor revision vector equals the current vector exactly, and
 *    both expiry bounds are still in the future at `now`. Any drift
 *    is StaleAuthentication. A digest that already exists is
 *    SessionConflict — an existing row is never returned, since its
 *    digest cannot recover this attempt's bearer. A supplied
 *    PendingConsumption must match a stored pending record (digest,
 *    flow, binding, version, unexpired) and is deleted in the same
 *    commit; any mismatch is PendingAuthenticationInvalid.
 *  - verify is authoritative: the record must exist under the
 *    digest, be inside both expiry bounds at `now`, and its
 *    securityRevision must still equal the subject's current one —
 *    that comparison is what makes password changes and revokeAll
 *    invalidate sessions immediately.
 *  - rotate is a single-winner CAS: the stored record must still be
 *    the captured one (identity + credentialVersion). A
 *    credentialVersion mismatch means another rotation won —
 *    SessionConflict; a missing/expired/superseded record is
 *    SessionInvalid. The new record preserves securityRevision,
 *    assurance, provenance, and absolute expiry; issuedAt is the
 *    later of the commit clock and the source issuedAt.
 *  - Revocations delete records (stateful storage needs no
 *    tombstones: absence is authoritative). revokeAll additionally
 *    bumps the subject securityRevision under an etag guard, so a
 *    stale expectation fails with StaleAuthentication.
 *  - Mutations require the ambient CurrentCommitJournal, exactly
 *    as in the password adapter; `prepare` runs before the physical
 *    writes, and a lost CAS fails the effect so the root commit
 *    discards the staged journal entries.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  PendingAuthenticationInvalid,
  SessionConflict,
  SessionInvalid,
  SessionUnavailable,
  StaleAuthentication,
  type StatefulSessionPersistence,
  type StatefulSessionRecord,
} from "@yielded/auth/Sessions";
import {
  CurrentCommitJournal,
  LifecycleHooks,
  coordinateCommit,
  type CommitJournal,
} from "@yielded/auth/Hooks";
import {
  ObjectStoreFailure,
  type ObjectStoreShape,
} from "./ObjectStore.ts";
import {
  SessionIndexRecord,
  StoredPendingRecord,
  StoredSessionRecord,
  SubjectRecord,
  mintId,
  mintRevision,
  pendingByDigestKey,
  sessionByDigestKey,
  sessionBySubjectKey,
  sessionsBySubjectPrefix,
  subjectKey,
} from "./records.ts";
import type { SessionClaims } from "./contract.ts";
import {
  currentRevision,
  listSubjectCredentials,
  readRecord,
  readSubject,
  writeRecord,
} from "./subjects.ts";

type Record_ = StatefulSessionRecord<SessionClaims>;

const unavailable = SessionUnavailable.make({});

/**
 * Map store failures to SessionUnavailable while preserving each
 * method's own narrower framework error channel. The cast is exact:
 * catchTag removes ObjectStoreFailure and adds only
 * SessionUnavailable; every other error the body can produce passes
 * through untouched, and each body below only constructs the errors
 * its port method declares.
 */
const orUnavailable = <A, E, R>(
  effect: Effect.Effect<A, E | ObjectStoreFailure, R>,
): Effect.Effect<A, E | SessionUnavailable, R> =>
  effect.pipe(
    Effect.catchTag("ObjectStoreFailure", () => Effect.fail(unavailable)),
  ) as Effect.Effect<A, E | SessionUnavailable, R>;

const requireJournal: Effect.Effect<CommitJournal, SessionUnavailable> =
  Effect.flatMap(Effect.serviceOption(CurrentCommitJournal), (journal) =>
    Option.isSome(journal)
      ? Effect.succeed(journal.value)
      : Effect.fail(unavailable),
  );

/**
 * Run a port call under a commit root. The framework's operations
 * deliberately run OUTSIDE any commit scope while credentials are
 * verified (`passwordNoAmbient`), and the completion machinery then
 * calls the mutating port methods, which require an ambient
 * CurrentCommitJournal (requireJournal above). The root therefore
 * lives here, at the native persistence boundary: when the caller
 * already runs inside a root (the adapter tests do), the ambient
 * journal is used untouched; otherwise this call opens its own
 * `coordinateCommit` root, so staged decisions commit — and their
 * PreparedCommit receipts become readable — exactly when the call's
 * writes have all succeeded.
 */
const rootCommit = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SessionUnavailable, R> => {
  // The self-rooted branch's true context gains LifecycleHooks (the
  // commit coordinator's requirement); every caller of these ports
  // already runs with the assembly's hooks layer in context, exactly
  // as it runs with the journal in context when a root is ambient.
  const rooted = Effect.map(
    coordinateCommit(() => effect).pipe(
      Effect.catchTag("HookConfigurationError", () =>
        Effect.fail(unavailable),
      ),
    ),
    (result) => result.value,
  ) as Effect.Effect<A, E | SessionUnavailable, R>;
  return Effect.flatMap(
    Effect.serviceOption(CurrentCommitJournal),
    (ambient) => (Option.isSome(ambient) ? effect : rooted),
  );
};

const readSession = (store: ObjectStoreShape, digest: string) =>
  readRecord(store, sessionByDigestKey(digest), StoredSessionRecord);

const deleteSession = (
  store: ObjectStoreShape,
  record: StoredSessionRecord,
) =>
  Effect.gen(function* () {
    yield* store.remove(sessionByDigestKey(record.digest));
    yield* store.remove(
      sessionBySubjectKey(record.subjectId, record.sessionId),
    );
  });

const isLive = (record: StoredSessionRecord, now: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(now) < DateTime.toEpochMillis(record.expiresAt) &&
  DateTime.toEpochMillis(now) < DateTime.toEpochMillis(record.absoluteExpiresAt);

export const makeSessionPersistence = (
  store: ObjectStoreShape,
): StatefulSessionPersistence<SessionClaims> => ({
  establish: (input, prepare) =>
    rootCommit(orUnavailable(
      Effect.gen(function* () {
        const journal = yield* requireJournal;
        const { session, evidence, pending, now } = input;

        const subject = yield* readSubject(store, session.subjectId);
        if (subject === null || subject.value.status !== "active") {
          return yield* Effect.fail(StaleAuthentication.make({}));
        }
        if (subject.value.securityRevision !== session.securityRevision) {
          return yield* Effect.fail(StaleAuthentication.make({}));
        }
        if (
          evidence.revision.subjectId !== session.subjectId ||
          evidence.revision.securityRevision !== subject.value.securityRevision
        ) {
          return yield* Effect.fail(StaleAuthentication.make({}));
        }
        const credentials = yield* listSubjectCredentials(
          store,
          session.subjectId,
        );
        const current = currentRevision(
          subject.value,
          credentials.map((entry) => entry.value),
        );
        const byId = new Map(
          current.credentials.map((entry) => [entry.credentialId, entry.revision]),
        );
        const vectorMatches =
          evidence.revision.credentials.length === current.credentials.length &&
          evidence.revision.credentials.every(
            (entry) => byId.get(entry.credentialId) === entry.revision,
          );
        if (!vectorMatches) {
          return yield* Effect.fail(StaleAuthentication.make({}));
        }
        if (
          DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(session.expiresAt) ||
          DateTime.toEpochMillis(now) >=
            DateTime.toEpochMillis(session.absoluteExpiresAt)
        ) {
          return yield* Effect.fail(StaleAuthentication.make({}));
        }

        const existing = yield* readSession(store, session.digest);
        if (existing !== null) {
          return yield* Effect.fail(SessionConflict.make({}));
        }

        let pendingRecord: StoredPendingRecord | null = null;
        if (pending !== undefined) {
          const stored = yield* readRecord(
            store,
            pendingByDigestKey(pending.digest),
            StoredPendingRecord,
          );
          const candidate = stored?.value ?? null;
          if (
            candidate === null ||
            candidate.digest !== pending.digest ||
            candidate.version !== pending.version ||
            candidate.evidence.flowId !== pending.flowId ||
            candidate.evidence.bindingDigest !== pending.bindingDigest ||
            DateTime.toEpochMillis(now) >=
              DateTime.toEpochMillis(candidate.expiresAt)
          ) {
            return yield* Effect.fail(PendingAuthenticationInvalid.make({}));
          }
          pendingRecord = candidate;
        }

        const record: Record_ = {
          ...session,
          sessionId: mintId("ses") as Record_["sessionId"],
        };
        const prepared = yield* Effect.sync(() => prepare(record, journal));

        const sessionWrite = yield* writeRecord(
          store,
          sessionByDigestKey(record.digest),
          StoredSessionRecord,
          record,
          { _tag: "IfAbsent" },
        );
        if (sessionWrite._tag === "Conflict") {
          return yield* Effect.fail(SessionConflict.make({}));
        }
        const indexWrite = yield* writeRecord(
          store,
          sessionBySubjectKey(record.subjectId, record.sessionId),
          SessionIndexRecord,
          { digest: record.digest },
          { _tag: "IfAbsent" },
        );
        if (indexWrite._tag === "Conflict") {
          return yield* Effect.fail(SessionConflict.make({}));
        }
        if (pendingRecord !== null) {
          yield* store.remove(pendingByDigestKey(pendingRecord.digest));
        }
        return prepared;
      }),
    )),

  verify: (input) =>
    orUnavailable(
      Effect.gen(function* () {
        const stored = yield* readSession(store, input.digest);
        if (stored === null) return yield* Effect.fail(SessionInvalid.make({}));
        const record = stored.value;
        if (!isLive(record, input.now)) {
          return yield* Effect.fail(SessionInvalid.make({}));
        }
        const subject = yield* readSubject(store, record.subjectId);
        if (
          subject === null ||
          subject.value.status !== "active" ||
          subject.value.securityRevision !== record.securityRevision
        ) {
          return yield* Effect.fail(SessionInvalid.make({}));
        }
        return record as Record_;
      }),
    ),

  rotate: (input, prepare) =>
    rootCommit(orUnavailable(
      Effect.gen(function* () {
        const journal = yield* requireJournal;
        const { record, nextDigest, nextCredentialVersion, nextExpiresAt, now } =
          input;
        const stored = yield* readSession(store, record.digest);
        if (stored === null) return yield* Effect.fail(SessionInvalid.make({}));
        const current = stored.value;
        if (
          current.sessionId !== record.sessionId ||
          current.subjectId !== record.subjectId ||
          current.digest !== record.digest
        ) {
          return yield* Effect.fail(SessionInvalid.make({}));
        }
        if (current.credentialVersion !== record.credentialVersion) {
          return yield* Effect.fail(SessionConflict.make({}));
        }
        if (!isLive(current, now)) {
          return yield* Effect.fail(SessionInvalid.make({}));
        }
        const subject = yield* readSubject(store, current.subjectId);
        if (
          subject === null ||
          subject.value.status !== "active" ||
          subject.value.securityRevision !== current.securityRevision
        ) {
          return yield* Effect.fail(SessionInvalid.make({}));
        }
        const rotated: Record_ = {
          ...current,
          digest: nextDigest,
          credentialVersion: nextCredentialVersion,
          expiresAt: nextExpiresAt,
          issuedAt: DateTime.makeUnsafe(
            Math.max(
              DateTime.toEpochMillis(now),
              DateTime.toEpochMillis(current.issuedAt),
            ),
          ),
        };
        const prepared = yield* Effect.sync(() => prepare(rotated, journal));
        const write = yield* writeRecord(
          store,
          sessionByDigestKey(nextDigest),
          StoredSessionRecord,
          rotated,
          { _tag: "IfAbsent" },
        );
        if (write._tag === "Conflict") {
          return yield* Effect.fail(SessionConflict.make({}));
        }
        yield* store.remove(sessionByDigestKey(current.digest));
        yield* writeRecord(
          store,
          sessionBySubjectKey(rotated.subjectId, rotated.sessionId),
          SessionIndexRecord,
          { digest: nextDigest },
          { _tag: "Any" },
        );
        return prepared;
      }),
    )),

  revokeDigest: (digest, prepare) =>
    rootCommit(orUnavailable(
      Effect.gen(function* () {
        const journal = yield* requireJournal;
        const stored = yield* readSession(store, digest);
        const revoked = stored !== null;
        const prepared = yield* Effect.sync(() =>
          prepare(revoked, journal),
        );
        if (stored !== null) yield* deleteSession(store, stored.value);
        return prepared;
      }),
    )),

  revoke: (input, prepare) =>
    rootCommit(orUnavailable(
      Effect.gen(function* () {
        const journal = yield* requireJournal;
        const index = yield* readRecord(
          store,
          sessionBySubjectKey(input.subjectId, input.sessionId),
          SessionIndexRecord,
        );
        const prepared = yield* Effect.sync(() =>
          prepare(undefined as void, journal),
        );
        if (index !== null) {
          const stored = yield* readSession(store, index.value.digest);
          if (stored !== null && stored.value.subjectId === input.subjectId) {
            yield* deleteSession(store, stored.value);
          } else {
            yield* store.remove(
              sessionBySubjectKey(input.subjectId, input.sessionId),
            );
          }
        }
        return prepared;
      }),
    )),

  revokeAll: (input, prepare) =>
    rootCommit(orUnavailable(
      Effect.gen(function* () {
        const journal = yield* requireJournal;
        const subject = yield* readSubject(store, input.subjectId);
        if (
          subject === null ||
          subject.value.securityRevision !== input.expectedSecurityRevision
        ) {
          return yield* Effect.fail(StaleAuthentication.make({}));
        }
        const prepared = yield* Effect.sync(() =>
          prepare(undefined as void, journal),
        );
        const keys = yield* store.list(
          sessionsBySubjectPrefix(input.subjectId),
        );
        for (const key of keys) {
          const index = yield* readRecord(store, key, SessionIndexRecord);
          if (index !== null) {
            yield* store.remove(sessionByDigestKey(index.value.digest));
          }
          yield* store.remove(key);
        }
        const bump = yield* writeRecord(
          store,
          subjectKey(input.subjectId),
          SubjectRecord,
          { ...subject.value, securityRevision: mintRevision() },
          { _tag: "IfMatch", etag: subject.etag },
        );
        if (bump._tag === "Conflict") {
          // Lost a race with another authority mutation: re-read to
          // report staleness precisely when that is what happened.
          const again = yield* readSubject(store, input.subjectId);
          if (
            again !== null &&
            again.value.securityRevision !== input.expectedSecurityRevision
          ) {
            return yield* Effect.fail(StaleAuthentication.make({}));
          }
          return yield* Effect.fail(unavailable);
        }
        return prepared;
      }),
    )),
});

// Binding note: unlike PasswordPersistence (an exported service
// class), StatefulSessionPersistence is a bare interface in the
// framework; the session module generates its service tag
// internally (`effect-auth/sessions/<moduleId>/Persistence`) when
// makeSessionModule runs. The integration step therefore binds
// `makeSessionPersistence` into that generated tag — there is no
// honest standalone Layer to export from this file, and inventing
// one would create a second, wrong identity for the service.
