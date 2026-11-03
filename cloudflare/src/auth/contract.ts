/**
 * contract.ts — Medina's yielded/auth contract: the browser-safe,
 * schema-only definition of the auth surface (Stage 2 design:
 * contract-first, password first, passkey second).
 *
 * The contract is the whole public vocabulary:
 *  - session claims are exactly one field, `displayName`;
 *  - the session actions the framework donates (getSession,
 *    requireSession, signOut, renewSession);
 *  - one application action, `signIn` — the framework's canonical
 *    password sign-in action, completed by the session contract's
 *    CompletionResult (Authenticated{session} | PendingAuthentication).
 *
 * Routes land at `${basePath}/${action}` = `/auth/signIn` etc. when
 * the integration step mounts this through @yielded/auth/Http.
 * Nothing here imports a service implementation, a key, or storage:
 * the same module is safe to ship to a browser bundle.
 */
import * as Schema from "effect/Schema";
import { make, passwordSignIn } from "@yielded/auth/AuthContract";

/** Session claims for Medina: the account's display name, resolved
 * at sign-in from the subject record and snapshotted into the
 * session record. */
export const SessionClaims = Schema.Struct({
  displayName: Schema.String,
});
export type SessionClaims = typeof SessionClaims.Type;

export const AUTH_NAMESPACE = "medina";

/** The yielded session module id for this app: `make` derives it as
 * `${namespace}/sessions`, and the session module + persistence are
 * bound to exactly this id at integration. */
export const SESSION_MODULE_ID = "medina/sessions";

export const authContract = make(AUTH_NAMESPACE, {
  claims: SessionClaims,
  actions: (sessions) => ({
    signIn: passwordSignIn({
      CompletionResult: sessions.CompletionResult,
    }),
  }),
});

/** The session contract the framework built inside `make` — the
 * identity-exact object the session module must be assembled with
 * (see sessionContractFor in the framework). */
export const sessionContract = authContract.sessions;
