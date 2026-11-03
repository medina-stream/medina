import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { LoginIdentifier } from "@yielded/auth/Identity";
import { TokenDigest } from "@yielded/auth/Schema";
import { AuthenticationAssurance } from "@yielded/auth/Operations";
import {
  SessionCredentialVersion,
  type AuthenticationRevision,
  type StatefulSessionRecord,
} from "@yielded/auth/Sessions";
import { makeMemoryObjectStore, type ObjectStoreShape } from "./ObjectStore.ts";
import { makePasswordPersistence } from "./PasswordPersistence.ts";
import { makeSessionPersistence } from "./SessionPersistence.ts";
import {
  StoredPendingRecord,
  mintRevision,
  pendingByDigestKey,
} from "./records.ts";
import {
  currentRevision,
  listSubjectCredentials,
  readRecord,
  readSubject,
  registerPassword,
  writeRecord,
} from "./subjects.ts";
import type { SessionClaims } from "./contract.ts";
import {
  IDENTIFIER,
  MODULE_ID,
  T0,
  at,
  commitFailureTag,
  evidenceFor,
  failureTag,
  mutationInput,
  prepareValue,
  readPrepared,
  replacement,
  runCommit,
} from "./test-helpers.ts";

const HOUR = 3_600_000;
type Record_ = StatefulSessionRecord<SessionClaims>;

const setup = async () => {
  const store = makeMemoryObjectStore();
  const sessions = makeSessionPersistence(store);
  const passwords = makePasswordPersistence(store);
  const decision = await Effect.runPromise(
    registerPassword(store, {
      moduleId: MODULE_ID,
      requestId: "req-1",
      identifier: IDENTIFIER,
      replacement: replacement("verifier-v1"),
      displayName: "Scott",
    }),
  );
  assert.equal(decision._tag, "Created");
  if (decision._tag !== "Created") throw new Error("setup failed");
  const subject = await Effect.runPromise(readSubject(store, decision.subjectId));
  assert.ok(subject !== null);
  const credentials = await Effect.runPromise(
    listSubjectCredentials(store, decision.subjectId),
  );
  const revision = currentRevision(
    subject.value,
    credentials.map((entry) => entry.value),
  );
  return { store, sessions, passwords, subjectId: decision.subjectId, revision };
};

const sessionFor = (
  revision: AuthenticationRevision,
  digest: string,
): Omit<Record_, "sessionId"> => ({
  subjectId: revision.subjectId,
  securityRevision: revision.securityRevision,
  assurance: AuthenticationAssurance.make({
    method: "password",
    factors: ["knowledge"],
    authenticatedAt: at(T0),
  }),
  issuedAt: at(T0),
  expiresAt: at(T0 + HOUR),
  absoluteExpiresAt: at(T0 + 12 * HOUR),
  claims: { displayName: "Scott" },
  digest: TokenDigest.make(digest),
  provenance: { evidence: evidenceFor(revision) },
  credentialVersion: SessionCredentialVersion.make("A".repeat(43)),
});

const establish = async (
  sessions: ReturnType<typeof makeSessionPersistence>,
  revision: AuthenticationRevision,
  digest: string,
  extra: { pending?: never } = {},
): Promise<Record_> => {
  const prepared = await runCommit(() =>
    sessions.establish(
      {
        session: sessionFor(revision, digest),
        evidence: evidenceFor(revision),
        now: at(T0),
        ...extra,
      },
      (record, journal) => journal.prepare(record),
    ),
  );
  return readPrepared(prepared);
};

describe("StatefulSessionPersistence.establish + verify", () => {
  it("establishes a session with an allocated id and verifies it", async () => {
    const { sessions, revision } = await setup();
    const record = await establish(sessions, revision, "digest-1");
    assert.ok(record.sessionId.startsWith("ses_"));
    assert.equal(record.claims.displayName, "Scott");

    const verified = await Effect.runPromise(
      sessions.verify({ digest: TokenDigest.make("digest-1"), now: at(T0 + 1000) }),
    );
    assert.equal(verified.sessionId, record.sessionId);
    assert.equal(verified.claims.displayName, "Scott");
  });

  it("rejects a duplicate digest with SessionConflict", async () => {
    const { sessions, revision } = await setup();
    await establish(sessions, revision, "digest-1");
    const tag = await commitFailureTag(() =>
      sessions.establish(
        {
          session: sessionFor(revision, "digest-1"),
          evidence: evidenceFor(revision),
          now: at(T0),
        },
        (record, journal) => journal.prepare(record),
      ),
    );
    assert.equal(tag, "SessionConflict");
  });

  it("rejects drifted authority with StaleAuthentication", async () => {
    const { sessions, revision } = await setup();
    const drifted = {
      ...sessionFor(revision, "digest-drift"),
      securityRevision: mintRevision(),
    };
    const tag = await commitFailureTag(() =>
      sessions.establish(
        { session: drifted, evidence: evidenceFor(revision), now: at(T0) },
        (record, journal) => journal.prepare(record),
      ),
    );
    assert.equal(tag, "StaleAuthentication");
  });

  it("rejects expired issuance bounds with StaleAuthentication", async () => {
    const { sessions, revision } = await setup();
    const tag = await commitFailureTag(() =>
      sessions.establish(
        {
          session: sessionFor(revision, "digest-late"),
          evidence: evidenceFor(revision),
          now: at(T0 + 2 * HOUR),
        },
        (record, journal) => journal.prepare(record),
      ),
    );
    assert.equal(tag, "StaleAuthentication");
  });

  it("rejects ambient use with no commit journal", async () => {
    const { sessions, revision } = await setup();
    const tag = await failureTag(
      sessions.establish(
        {
          session: sessionFor(revision, "digest-1"),
          evidence: evidenceFor(revision),
          now: at(T0),
        },
        (record, journal) => journal.prepare(record),
      ),
    );
    assert.equal(tag, "SessionUnavailable");
  });

  it("verify fails closed for unknown and expired sessions", async () => {
    const { sessions, revision } = await setup();
    await establish(sessions, revision, "digest-1");

    const unknown = await failureTag(
      sessions.verify({ digest: TokenDigest.make("digest-nope"), now: at(T0) }),
    );
    assert.equal(unknown, "SessionInvalid");

    const expired = await failureTag(
      sessions.verify({
        digest: TokenDigest.make("digest-1"),
        now: at(T0 + 2 * HOUR),
      }),
    );
    assert.equal(expired, "SessionInvalid");
  });
});

describe("StatefulSessionPersistence.rotate", () => {
  it("rotates digest + credential version, preserving the session", async () => {
    const { sessions, revision } = await setup();
    const record = await establish(sessions, revision, "digest-1");

    const prepared = await runCommit(() =>
      sessions.rotate(
        {
          record,
          nextDigest: TokenDigest.make("digest-2"),
          nextCredentialVersion: SessionCredentialVersion.make("B".repeat(43)),
          nextExpiresAt: at(T0 + 2 * HOUR),
          now: at(T0 + 60_000),
        },
        (rotated, journal) => journal.prepare(rotated),
      ),
    );
    const rotated = await readPrepared(prepared);
    assert.equal(rotated.sessionId, record.sessionId);
    assert.equal(rotated.digest, TokenDigest.make("digest-2"));
    assert.equal(
      DateTime.toEpochMillis(rotated.absoluteExpiresAt),
      DateTime.toEpochMillis(record.absoluteExpiresAt),
    );
    assert.equal(rotated.securityRevision, record.securityRevision);

    const verified = await Effect.runPromise(
      sessions.verify({ digest: TokenDigest.make("digest-2"), now: at(T0 + 61_000) }),
    );
    assert.equal(verified.sessionId, record.sessionId);

    const oldGone = await failureTag(
      sessions.verify({ digest: TokenDigest.make("digest-1"), now: at(T0 + 61_000) }),
    );
    assert.equal(oldGone, "SessionInvalid");
  });

  it("a second rotation from the same capture loses: Conflict on version mismatch, Invalid once rotated away", async () => {
    const { sessions, revision } = await setup();
    const record = await establish(sessions, revision, "digest-1");

    // Same digest still stored, but the caller's credentialVersion
    // no longer matches it: the CAS loses with SessionConflict.
    const conflict = await commitFailureTag(() =>
      sessions.rotate(
        {
          record: {
            ...record,
            credentialVersion: SessionCredentialVersion.make("C".repeat(43)),
          },
          nextDigest: TokenDigest.make("digest-x"),
          nextCredentialVersion: SessionCredentialVersion.make("D".repeat(43)),
          nextExpiresAt: at(T0 + 2 * HOUR),
          now: at(T0 + 1000),
        },
        (rotated, journal) => journal.prepare(rotated),
      ),
    );
    assert.equal(conflict, "SessionConflict");

    // A real rotation wins; replaying the original capture then
    // finds nothing under the old digest.
    await runCommit(() =>
      sessions.rotate(
        {
          record,
          nextDigest: TokenDigest.make("digest-2"),
          nextCredentialVersion: SessionCredentialVersion.make("B".repeat(43)),
          nextExpiresAt: at(T0 + 2 * HOUR),
          now: at(T0 + 2000),
        },
        (rotated, journal) => journal.prepare(rotated),
      ),
    );
    const replay = await commitFailureTag(() =>
      sessions.rotate(
        {
          record,
          nextDigest: TokenDigest.make("digest-3"),
          nextCredentialVersion: SessionCredentialVersion.make("E".repeat(43)),
          nextExpiresAt: at(T0 + 2 * HOUR),
          now: at(T0 + 3000),
        },
        (rotated, journal) => journal.prepare(rotated),
      ),
    );
    assert.equal(replay, "SessionInvalid");
  });
});

describe("StatefulSessionPersistence revocation", () => {
  it("revokeDigest reports true once, then false", async () => {
    const { sessions, revision } = await setup();
    await establish(sessions, revision, "digest-1");

    const first = await runCommit(() =>
      sessions.revokeDigest(TokenDigest.make("digest-1"), prepareValue),
    );
    assert.equal(await readPrepared(first), true);
    const gone = await failureTag(
      sessions.verify({ digest: TokenDigest.make("digest-1"), now: at(T0) }),
    );
    assert.equal(gone, "SessionInvalid");

    const second = await runCommit(() =>
      sessions.revokeDigest(TokenDigest.make("digest-1"), prepareValue),
    );
    assert.equal(await readPrepared(second), false);
  });

  it("revoke targets one session of the subject", async () => {
    const { sessions, revision, subjectId } = await setup();
    const one = await establish(sessions, revision, "digest-1");
    await establish(sessions, revision, "digest-2");

    await runCommit(() =>
      sessions.revoke(
        { subjectId, sessionId: one.sessionId },
        (value, journal) => journal.prepare(value),
      ),
    );
    const gone = await failureTag(
      sessions.verify({ digest: TokenDigest.make("digest-1"), now: at(T0) }),
    );
    assert.equal(gone, "SessionInvalid");
    const alive = await Effect.runPromise(
      sessions.verify({ digest: TokenDigest.make("digest-2"), now: at(T0) }),
    );
    assert.equal(alive.digest, TokenDigest.make("digest-2"));
  });

  it("revokeAll drops every session and bumps the security revision", async () => {
    const { sessions, revision, subjectId } = await setup();
    await establish(sessions, revision, "digest-1");
    await establish(sessions, revision, "digest-2");

    await runCommit(() =>
      sessions.revokeAll(
        { subjectId, expectedSecurityRevision: revision.securityRevision },
        (value, journal) => journal.prepare(value),
      ),
    );
    for (const digest of ["digest-1", "digest-2"]) {
      const tag = await failureTag(
        sessions.verify({ digest: TokenDigest.make(digest), now: at(T0) }),
      );
      assert.equal(tag, "SessionInvalid");
    }

    const stale = await commitFailureTag(() =>
      sessions.revokeAll(
        { subjectId, expectedSecurityRevision: revision.securityRevision },
        (value, journal) => journal.prepare(value),
      ),
    );
    assert.equal(stale, "StaleAuthentication");
  });

  it("a password change invalidates live sessions via the revision bump", async () => {
    const { sessions, passwords, revision } = await setup();
    await establish(sessions, revision, "digest-1");

    const snapshot = await Effect.runPromise(
      passwords.findCredential({
        moduleId: MODULE_ID,
        identifier: LoginIdentifier.make(IDENTIFIER),
      }),
    );
    assert.ok(Option.isSome(snapshot));
    if (Option.isNone(snapshot)) return;
    await runCommit(() =>
      passwords.replaceIfCurrent(
        mutationInput({
          expectedRevision: snapshot.value.revision,
          credential: snapshot.value,
          replacement: replacement("verifier-v2"),
        }),
        prepareValue,
      ),
    );

    const tag = await failureTag(
      sessions.verify({ digest: TokenDigest.make("digest-1"), now: at(T0) }),
    );
    assert.equal(tag, "SessionInvalid");
  });
});

describe("StatefulSessionPersistence pending consumption", () => {
  const seedPending = async (
    store: ObjectStoreShape,
    revision: AuthenticationRevision,
    digest: string,
  ) => {
    const version = mintRevision();
    await Effect.runPromise(
      writeRecord(
        store,
        pendingByDigestKey(digest),
        StoredPendingRecord,
        {
          digest: TokenDigest.make(digest),
          version,
          evidence: evidenceFor(revision),
          expiresAt: at(T0 + HOUR),
          attemptLimit: 5,
          claims: { displayName: "Scott" },
        },
        { _tag: "Any" },
      ),
    );
    return {
      flowId: evidenceFor(revision).flowId,
      digest: TokenDigest.make(digest),
      bindingDigest: evidenceFor(revision).bindingDigest,
      version,
    };
  };

  it("consumes a matching pending record in the same commit", async () => {
    const { store, sessions, revision } = await setup();
    const pending = await seedPending(store, revision, "pending-digest-1");

    const prepared = await runCommit(() =>
      sessions.establish(
        {
          session: sessionFor(revision, "digest-1"),
          evidence: evidenceFor(revision),
          pending,
          now: at(T0),
        },
        (record, journal) => journal.prepare(record),
      ),
    );
    await readPrepared(prepared);

    const remaining = await Effect.runPromise(
      readRecord(store, pendingByDigestKey("pending-digest-1"), StoredPendingRecord),
    );
    assert.equal(remaining, null);
  });

  it("rejects a mismatched pending version", async () => {
    const { store, sessions, revision } = await setup();
    const pending = await seedPending(store, revision, "pending-digest-1");
    const tag = await commitFailureTag(() =>
      sessions.establish(
        {
          session: sessionFor(revision, "digest-1"),
          evidence: evidenceFor(revision),
          pending: { ...pending, version: mintRevision() },
          now: at(T0),
        },
        (record, journal) => journal.prepare(record),
      ),
    );
    assert.equal(tag, "PendingAuthenticationInvalid");
  });
});
