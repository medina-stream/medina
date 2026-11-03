/**
 * records.ts — the on-bucket layout of Medina's auth store.
 *
 * Everything lives under `auth/v1/` in one bucket (the ARTIFACTS
 * bucket in production). Records are JSON documents encoded through
 * the framework's own schemas wherever the framework defines one —
 * session records through SessionMetadata + provenance + the app
 * claims schema, pending records through AuthenticationEvidence — so
 * storage encoding cannot drift from the types the framework
 * consumes. The remaining records (subject, credential, identifier,
 * registration) are app-owned authority data the framework reads
 * only through the adapters in this directory.
 *
 * Layout (`<…>` segments are encodeURIComponent'd):
 *
 *   auth/v1/subjects/<subjectId>                        SubjectRecord
 *   auth/v1/credentials/<credentialId>                  CredentialRecord
 *   auth/v1/credentials-by-subject/<subjectId>/<credentialId>
 *                                                       index: "" (presence)
 *   auth/v1/identifiers/<namespace>/<value>             IdentifierRecord
 *   auth/v1/registrations/<requestId>                   RegistrationRecord
 *   auth/v1/sessions/by-digest/<digest>                 StoredSessionRecord
 *   auth/v1/sessions/by-subject/<subjectId>/<sessionId> SessionIndexRecord
 *   auth/v1/pending/by-digest/<digest>                  StoredPendingRecord
 *
 * The pending layout is the shape the framework's optional
 * PendingAuthentication port (sessions/PendingAuthentication.ts)
 * describes. This increment only *consumes* pending records in
 * StatefulSessionPersistence.establish; creating them belongs to
 * the MFA increment.
 *
 * Revisions (securityRevision, credentialRevision, verifierVersion,
 * identifierBindingRevision) are opaque random tokens: equality is
 * the only operation the framework performs on them, and a "bump"
 * is minting a fresh one. Randomness comes from WebCrypto, present
 * in workerd, Bun, and Node ≥ 19.
 */
import * as Schema from "effect/Schema";
import { SubjectId, TokenDigest } from "@yielded/auth/Schema";
import { PasswordNormalization } from "@yielded/auth/Password";
import {
  AuthenticationEvidence,
  SecurityRevision,
  SessionAuthenticationProvenance,
  SessionCredentialVersion,
  SessionMetadata,
} from "@yielded/auth/Sessions";
import { SessionClaims } from "./contract.ts";

// ---------------------------------------------------------------------------
// Ids and revisions
// ---------------------------------------------------------------------------

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const randomToken = (bytes = 18): string =>
  base64Url(crypto.getRandomValues(new Uint8Array(bytes)));

/** A fresh opaque revision token. */
export const mintRevision = (): SecurityRevision =>
  SecurityRevision.make(`r_${randomToken()}`);

/** A fresh prefixed id (`sub_…`, `cred_…`, `ses_…`). */
export const mintId = (prefix: string): string => `${prefix}_${randomToken()}`;

// ---------------------------------------------------------------------------
// Key layout
// ---------------------------------------------------------------------------

const segment = (value: string): string => encodeURIComponent(value);

export const subjectKey = (subjectId: string): string =>
  `auth/v1/subjects/${segment(subjectId)}`;

export const credentialKey = (credentialId: string): string =>
  `auth/v1/credentials/${segment(credentialId)}`;

export const credentialsBySubjectPrefix = (subjectId: string): string =>
  `auth/v1/credentials-by-subject/${segment(subjectId)}/`;

export const credentialBySubjectKey = (
  subjectId: string,
  credentialId: string,
): string =>
  `${credentialsBySubjectPrefix(subjectId)}${segment(credentialId)}`;

export const identifierKey = (identifier: {
  readonly namespace: string;
  readonly value: string;
}): string =>
  `auth/v1/identifiers/${segment(identifier.namespace)}/${segment(identifier.value)}`;

export const registrationKey = (requestId: string): string =>
  `auth/v1/registrations/${segment(requestId)}`;

export const sessionByDigestKey = (digest: string): string =>
  `auth/v1/sessions/by-digest/${segment(digest)}`;

export const sessionsBySubjectPrefix = (subjectId: string): string =>
  `auth/v1/sessions/by-subject/${segment(subjectId)}/`;

export const sessionBySubjectKey = (
  subjectId: string,
  sessionId: string,
): string => `${sessionsBySubjectPrefix(subjectId)}${segment(sessionId)}`;

export const pendingByDigestKey = (digest: string): string =>
  `auth/v1/pending/by-digest/${segment(digest)}`;

// ---------------------------------------------------------------------------
// Stored records
// ---------------------------------------------------------------------------

/** The application's identity-authority record for one account. The
 * framework's AuthenticationAuthority (an app-owned port) reads the
 * same data at integration. `loginIdentifier` is the account's
 * single login identifier, recorded at registration: this app has
 * exactly one identifier per account (its email), and
 * PasswordPersistence.addIfAbsent binds new password credentials to
 * it, because PasswordMutationInput carries no identifier field. */
export const SubjectRecord = Schema.Struct({
  subjectId: SubjectId,
  status: Schema.Literals(["active", "disabled", "deleting"]),
  securityRevision: SecurityRevision,
  displayName: Schema.String,
  loginIdentifier: Schema.Struct({
    namespace: Schema.NonEmptyString,
    value: Schema.NonEmptyString,
  }),
});
export type SubjectRecord = typeof SubjectRecord.Type;

/** One password credential. `verifier` is the framework's
 * EncodedPasswordHash as a plain string; adapters wrap it in
 * Redacted at the framework boundary and never log it. */
export const CredentialRecord = Schema.Struct({
  moduleId: Schema.NonEmptyString,
  credentialId: Schema.NonEmptyString,
  subjectId: SubjectId,
  credentialRevision: SecurityRevision,
  verifierVersion: SecurityRevision,
  verifier: Schema.String,
  normalization: PasswordNormalization,
  identifier: Schema.Struct({
    namespace: Schema.NonEmptyString,
    value: Schema.NonEmptyString,
  }),
  identifierBindingRevision: SecurityRevision,
  identifierVerifiedAtMillis: Schema.optionalKey(Schema.Int),
});
export type CredentialRecord = typeof CredentialRecord.Type;

/** Identifier → credential index entry. */
export const IdentifierRecord = Schema.Struct({
  moduleId: Schema.NonEmptyString,
  credentialId: Schema.NonEmptyString,
  subjectId: SubjectId,
});
export type IdentifierRecord = typeof IdentifierRecord.Type;

/** Idempotency record for one registration request: the decision the
 * first attempt reached, replayed verbatim on retries. */
export const RegistrationRecord = Schema.Struct({
  decision: Schema.Union([
    Schema.TaggedStruct("Created", { subjectId: SubjectId }),
    Schema.TaggedStruct("Suppressed", {}),
  ]),
});
export type RegistrationRecord = typeof RegistrationRecord.Type;

/** A stateful session: exactly the framework's
 * StatefulSessionRecord<SessionClaims> (SessionMetadata + claims +
 * digest + provenance + credentialVersion). */
export const StoredSessionRecord = Schema.Struct({
  ...SessionMetadata.fields,
  claims: SessionClaims,
  digest: TokenDigest,
  provenance: SessionAuthenticationProvenance,
  credentialVersion: SessionCredentialVersion,
});
export type StoredSessionRecord = typeof StoredSessionRecord.Type;

/** The by-subject session index entry. */
export const SessionIndexRecord = Schema.Struct({ digest: TokenDigest });
export type SessionIndexRecord = typeof SessionIndexRecord.Type;

/** A pending (MFA) authentication awaiting completion: the
 * framework's PendingAuthenticationState plus the claims to issue
 * with the session on completion. */
export const StoredPendingRecord = Schema.Struct({
  digest: TokenDigest,
  version: SecurityRevision,
  evidence: AuthenticationEvidence,
  expiresAt: Schema.DateTimeUtcFromMillis,
  attemptLimit: Schema.Int,
  claims: SessionClaims,
});
export type StoredPendingRecord = typeof StoredPendingRecord.Type;
