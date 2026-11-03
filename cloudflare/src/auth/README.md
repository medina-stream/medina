# Medina auth — Stage 2, increment 1 (library code)

Contract + bucket-backed persistence ports for @yielded/auth
(0.1.0-beta.47), written against the framework's own port
definitions in its source, not against assumptions. Nothing here is
wired into the Worker yet — integration (routes, gate swap,
bootstrap) is the next increment, after the capture loop lands.

## Files

| File | What |
| --- | --- |
| `contract.ts` | `authContract = make("medina", …)` — claims `{ displayName }`, actions: framework session actions + `signIn` (passwordSignIn). `sessionContract = authContract.sessions`, moduleId `medina/sessions`. |
| `ObjectStore.ts` | The CAS substrate: get / conditional put (Any / IfAbsent / IfMatch-etag) / remove / list-prefix, over R2 (`makeR2ObjectStore`, onlyIf preconditions) or memory (`makeMemoryObjectStore`). |
| `records.ts` | Key layout under `auth/v1/`, opaque revisions (`r_…`), id minting, and the bucket record schemas. Framework session/pending models are stored via the framework's own codecs; subject/credential/identifier/registration records are app-owned. |
| `subjects.ts` | Shared record helpers + `registerPassword` (the registration path — see below) + `provisionSubject` (identifier reserving, no credential yet). |
| `PasswordPersistence.ts` | The framework `PasswordPersistence` port over records (`findCredential`, `readForSubject`, `recoveryTarget`, `addIfAbsent`, `replaceIfCurrent`, `rehashIfCurrent`, `resetWithProof`) + the exported `layerPasswordPersistence`. |
| `SessionPersistence.ts` | The framework `StatefulSessionPersistence` port over records (`establish`, `verify`, `rotate`, `revokeDigest`, `revoke`, `revokeAll`) via `makeSessionPersistence`. |

Tests (`bun test src/auth/`, node:test): CAS happy/conflict paths
for both ports, registration idempotency, commit-journal behavior,
proof redemption staging, pending consumption, and the
cross-adapter property that a password change invalidates live
sessions.

## Decisions worth knowing

- **Hasher: scrypt.** See `cloudflare/spike/README.md` — the
  framework's own `PasswordScrypt.layer` + `defaultScryptPasswordHashingConfig`
  composition runs on workerd nodejs_compat with zero WASM in the
  bundle. The hasher is a replaceable port stack in the framework;
  the platform package's WASM Argon2id is the proven fallback.
- **Commit journal.** Mutations run under the framework's
  `coordinateCommit` root: the adapter checks CAS guards, stages
  its decision via the caller's `prepare` into the ambient
  `CurrentCommitJournal`, then writes. Any CAS loss fails the
  effect, which discards the journal — no half-committed auth
  state. Mutations called without a journal fail closed
  (`PasswordUnavailable` / `SessionUnavailable`).
- **Registration is a different port.** It does not flow through
  `PasswordPersistence.addIfAbsent`. The framework generates a
  `RegistrationAuthority` port inside `makePasswordMethod` (tag
  `effect-auth/password/<moduleId>/RegistrationAuthority`) with
  idempotent-by-requestId, never-adopt semantics and unverified
  identifiers. `registerPassword` implements exactly those
  semantics as a plain function; the integration step binds it to
  the generated tag (derived ids from the requestId make retries
  converge; the decision is recorded for replay).
- **`addIfAbsent` does not bump the subject securityRevision.**
  Literal reading of the port doc, which reserves the bump for
  credential replacement/reset: adding a first password doesn't
  invalidate anything because there was no prior factor to protect.
  `replaceIfCurrent` / `resetWithProof` do bump it, and since
  session verify compares the subject's current revision,
  replacement rotates sessions immediately.
- **Password reset is not yet eligible.** `recoveryTarget`
  requires `identifierVerifiedAtMillis`, which these adapters never
  set (identifiers start unverified per the registration contract).
  It returns `None` until an identifier-verification flow exists;
  `resetWithProof` is implemented and tested for when it does.
- **SessionPersistence has no standalone Layer — on purpose.** The
  framework's persistence service tag is generated inside
  `makeSessionModule` (`effect-auth/sessions/<moduleId>/Persistence`)
  and the tag class is not exported. `makeSessionPersistence`
  returns the port implementation; the integration step binds it
  to the module's tag when assembling `makeSessionModule`.
- **PendingAuthentication is establish-side only.** `establish`
  consumes pending records (digest + version matched) under the
  shared `auth/v1/pending/` layout; the port's create/read/reject
  (MFA machinery) is a later increment.
- **Multi-object writes are not atomic on R2.** A commit touches
  2–4 objects sequentially; a crash mid-commit can leave an index
  row stale. Every read re-derives authority from the records and
  fails closed on skew (documented per-adapter), and the journal
  guarantee means the caller never observes success for a commit
  whose writes failed.

## What the integration step still needs

1. **Worker wiring** (worker.ts, after the capture loop lands):
   - `ObjectStore.layerR2(env.ARTIFACTS)` + `layerPasswordPersistence`
     + `makeSessionPersistence` bound to the session module tag.
   - Password method assembly: `makePasswordMethod` with
     `MODULE_ID = "medina/password"`, the scrypt hashing layer
     (recipe in the spike README), the framework's default attempt
     limiter, and the `RegistrationAuthority` binding around
     `registerPassword`.
   - Session module assembly: `makeSessionModule("medina/sessions", SessionClaims)`
     + `Sessions.stateful(...)` with these ports.
   - `AuthenticationAuthority` implementation (app port:
     capture/requirements/approve over the subject records) and the
     `SessionClaims` resolver (subject → `{ displayName }`).
   - Remaining optional ports: `SessionRepository` (session list
     UI), `SessionCleanup`, `PendingAuthentication`, and
     `ProofPersistence` + identifier verification if reset ships.
   - `Http.make` routes bridged into the Worker fetch handler via
     `HttpRouter.toWebHandler`; `Hooks.hooksLayer` at the root.
2. **Journal gate swap**: journal reads move from the capture-token
   cookie to `requireSession` on the same contract.
3. **Bootstrap route**: create-account allowed only while zero
   subject records exist (`list("auth/v1/subjects/")` empty); the
   account and its password are created in-browser by Scott — no
   credential is ever provisioned by an agent.
4. **Passkey (second increment)**: `PasskeyPersistence` port +
   WebAuthn config; the record layout already reserves
   credential modules beyond `medina/password`.
