/**
 * The @yielded/auth host for the Medina Worker (step 12 — the gate
 * swap): assembles the framework service from the Stage-2 contract
 * and the bucket-backed persistence ports (src/auth/), mounts its
 * HTTP routes under /auth, and serves the two app-owned pages the
 * framework deliberately does NOT provide: sign-in and bootstrap.
 *
 * Assembly (all vendor parts, no WASM — the Stage-2 spike's verified
 * hashing stack):
 *
 *   Auth.make("medina", { password strategy (sign-in only),
 *   stateful sessions, defaultStrategy "password" }, authContract)
 *     provided by:
 *       - PasswordPersistence: src/auth's layer over the R2 store
 *       - StatefulSessionPersistence: src/auth's port, bound to the
 *         session module's tag
 *       - SessionRepository: a minimal list over the same records
 *         (the by-subject index + the session records themselves)
 *       - the password strategy's SessionClaims resolver: the
 *         subject record's displayName
 *       - AuthenticationAuthority: capture/requirements/approve over
 *         the subject + credential records (approve is the signed
 *         flow's linearization point; the stateful flow completes
 *         through SessionPersistence.establish and never calls it,
 *         but the port must exist and be faithful)
 *       - PasswordHashing: the framework's scrypt hasher over
 *         node:crypto (PasswordScrypt), WebCrypto for randomness
 *         and digests, bounded KDF admission
 *       - the framework's default (empty) lifecycle hooks
 *
 * The session cookie is the framework's `__Host-effect-auth-session`
 * (host-only, Secure, SameSite=Lax). The journal gate verifies it
 * programmatically through the service's verifySession — no request
 * context needed — and that check is this module's `sessionActive`.
 *
 * Bootstrap: while the store holds zero subjects, GET/POST
 * /auth/bootstrap are open without a session; the POST hashes the
 * submitted password with the same PasswordHashing service and
 * registers it through src/auth's registerPassword. The moment one
 * account exists the route closes (404). This is the one account
 * creation path — Medina has no public sign-up, and password reset
 * stays ineligible until an identifier-verification flow exists
 * (identifiers start unverified by design).
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Kdf from "effect/crypto/Kdf";
import { make as makeAuthService } from "@yielded/auth/Auth";
import * as AuthHttp from "@yielded/auth/Http";
import { Password } from "@yielded/auth/strategies";
import {
  AuthenticationAuthority,
  SessionUnavailable,
  StaleAuthentication,
  stateful,
  type AuthenticationRequirement,
  type AuthenticationRevision,
  type SessionMetadata,
} from "@yielded/auth/Sessions";
import type { SubjectId } from "@yielded/auth/Schema";
import {
  CurrentCommitJournal,
  type CommitJournal,
  type PreparedCommit,
} from "@yielded/auth/Hooks";
import { hooksLayer } from "@yielded/auth/Persistence";
import {
  KdfAdmission,
  PasswordHashing,
  PasswordUnavailable,
  defaultScryptPasswordHashingConfig,
} from "@yielded/auth/Password";
import * as PasswordScrypt from "@yielded/auth/PasswordScrypt";
import * as WebCrypto from "@yielded/auth/WebCrypto";
import { authContract } from "./auth/contract.ts";
import {
  layerR2,
  makeR2ObjectStore,
  type ObjectStoreShape,
  type R2BucketBindingLike,
} from "./auth/ObjectStore.ts";
import { layerPasswordPersistence } from "./auth/PasswordPersistence.ts";
import { makeSessionPersistence } from "./auth/SessionPersistence.ts";
import {
  currentRevision,
  listSubjectCredentials,
  readRecord,
  readSubject,
  registerPassword,
} from "./auth/subjects.ts";
import {
  SessionIndexRecord,
  StoredSessionRecord,
  sessionByDigestKey,
  sessionsBySubjectPrefix,
} from "./auth/records.ts";

export const SESSION_COOKIE = "__Host-effect-auth-session";
const SUBJECTS_PREFIX = "auth/v1/subjects/";
const PASSWORD_MODULE_ID = "medina/password";

const REQUIREMENT: AuthenticationRequirement = {
  alternatives: [
    {
      factors: ["knowledge"],
      userVerified: false,
      phishingResistant: false,
      minimumCredentials: 1,
    },
  ],
  maximumAgeMillis: 300_000,
};

const revisionEquals = (
  a: AuthenticationRevision,
  b: AuthenticationRevision,
): boolean =>
  a.subjectId === b.subjectId &&
  a.securityRevision === b.securityRevision &&
  a.credentials.length === b.credentials.length &&
  a.credentials.every(
    (credential, index) =>
      credential.credentialId === b.credentials[index]!.credentialId &&
      credential.revision === b.credentials[index]!.revision,
  );

const stale = StaleAuthentication.make({});
const unavailable = SessionUnavailable.make({});

/** Read the subject + its credentials and produce the current
 * revision vector, or the authority's stale/unavailable failures. */
const currentVector = (store: ObjectStoreShape, subjectId: SubjectId) =>
  Effect.gen(function* () {
    const subject = yield* readSubject(store, subjectId).pipe(
      Effect.mapError(() => unavailable),
    );
    if (subject === null || subject.value.status !== "active") {
      return yield* Effect.fail(stale);
    }
    const credentials = yield* listSubjectCredentials(
      store,
      subjectId,
    ).pipe(Effect.mapError(() => unavailable));
    return currentRevision(
      subject.value,
      credentials.map((credential) => credential.value),
    );
  });

/** The AuthenticationAuthority port over the bucket records. */
const makeAuthority = (store: ObjectStoreShape) => ({
  capture: (
    subjectId: SubjectId,
    credentialIds: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const revision = yield* currentVector(store, subjectId);
      for (const id of credentialIds) {
        if (
          !revision.credentials.some(
            (credential) => credential.credentialId === id,
          )
        ) {
          return yield* Effect.fail(stale);
        }
      }
      return { revision, requirement: REQUIREMENT };
    }),
  requirements: (evidence: { readonly revision: AuthenticationRevision }) =>
    Effect.gen(function* () {
      const current = yield* currentVector(
        store,
        evidence.revision.subjectId,
      );
      if (!revisionEquals(current, evidence.revision)) {
        return yield* Effect.fail(stale);
      }
      return REQUIREMENT;
    }),
  approve: <A>(
    input: {
      readonly evidence: {
        readonly revision: AuthenticationRevision;
      };
      readonly now: DateTime.Utc;
      readonly issuedAt: DateTime.Utc;
      readonly expiresAt: DateTime.Utc;
      readonly absoluteExpiresAt: DateTime.Utc;
    },
    prepare: (
      record: void,
      journal: CommitJournal,
    ) => PreparedCommit<A>,
  ) =>
    Effect.gen(function* () {
      const current = yield* currentVector(
        store,
        input.evidence.revision.subjectId,
      );
      if (!revisionEquals(current, input.evidence.revision)) {
        return yield* Effect.fail(stale);
      }
      const nowMillis = DateTime.toEpochMillis(input.now);
      if (
        nowMillis >= DateTime.toEpochMillis(input.expiresAt) ||
        nowMillis >= DateTime.toEpochMillis(input.absoluteExpiresAt)
      ) {
        return yield* Effect.fail(stale);
      }
      // The commit journal is ambient inside the framework's
      // coordinateCommit (provided via provideService, removed
      // from the port's requirement type) — read it with
      // serviceOption, the same pattern src/auth's ports use.
      const journal = yield* Effect.flatMap(
        Effect.serviceOption(CurrentCommitJournal),
        (option) =>
          option._tag === "Some"
            ? Effect.succeed(option.value)
            : Effect.fail(unavailable),
      );
      return prepare(undefined, journal);
    }),
});

/** The SessionRepository port: page the subject's live sessions out
 * of the by-subject index + the session records. Digests are read
 * only to find the records; the metadata projection never carries
 * them. */
const makeSessionRepository = (store: ObjectStoreShape) => ({
  list: (input: {
    readonly subjectId: SubjectId;
    readonly cursor?: string;
    readonly limit: number;
    readonly now: DateTime.Utc;
  }) =>
    Effect.gen(function* () {
      const prefix = sessionsBySubjectPrefix(input.subjectId);
      const keys = yield* store
        .list(prefix)
        .pipe(Effect.mapError(() => unavailable));
      const nowMillis = DateTime.toEpochMillis(input.now);
      const sessions: Array<SessionMetadata> = [];
      for (const key of keys) {
        const index = yield* readRecord(
          store,
          key,
          SessionIndexRecord,
        ).pipe(Effect.mapError(() => unavailable));
        if (index === null) continue;
        const record = yield* readRecord(
          store,
          sessionByDigestKey(index.value.digest),
          StoredSessionRecord,
        ).pipe(Effect.mapError(() => unavailable));
        if (record === null) continue;
        if (
          DateTime.toEpochMillis(record.value.expiresAt) <= nowMillis ||
          DateTime.toEpochMillis(record.value.absoluteExpiresAt) <=
            nowMillis
        ) {
          continue;
        }
        const {
          sessionId,
          subjectId,
          securityRevision,
          assurance,
          issuedAt,
          expiresAt,
          absoluteExpiresAt,
        } = record.value;
        sessions.push({
          sessionId,
          subjectId,
          securityRevision,
          assurance,
          issuedAt,
          expiresAt,
          absoluteExpiresAt,
        });
      }
      sessions.sort(
        (a, b) =>
          DateTime.toEpochMillis(a.issuedAt) -
          DateTime.toEpochMillis(b.issuedAt),
      );
      const start =
        input.cursor === undefined
          ? 0
          : Number.parseInt(input.cursor, 10) || 0;
      const page = sessions.slice(start, start + input.limit);
      const next = start + input.limit;
      return {
        sessions: page,
        ...(next < sessions.length ? { nextCursor: String(next) } : {}),
      };
    }),
});

export interface AuthHostConfig {
  /** The origin the auth HTTP layer is configured for — the
   * canonical host (https://sco.medina.stream). */
  readonly origin: string;
  /** Origins whose pages may call the auth operations. */
  readonly trustedOrigins: ReadonlyArray<string>;
}

export interface AuthHost {
  /** Serve /auth/* (framework operations + the app pages), or null
   * for paths outside the auth surface. */
  readonly handle: (
    request: Request,
  ) => Effect.Effect<Response | null>;
  /** True when the request carries a session cookie that verifies
   * against the subject's current records. */
  readonly sessionActive: (
    request: Request,
  ) => Effect.Effect<boolean>;
  /** True while zero accounts exist (bootstrap open). */
  readonly bootstrapOpen: Effect.Effect<boolean>;
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );

const pageShell = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 24rem; padding: 0 1rem; line-height: 1.5; }
  label { display: block; margin-top: 1rem; font-size: .9rem; }
  input { width: 100%; padding: .5rem; margin-top: .25rem; box-sizing: border-box; }
  button { margin-top: 1.25rem; padding: .55rem 1.1rem; }
  .error { color: #a00; min-height: 1.2em; }
  .note { color: #555; font-size: .9rem; }
</style></head><body>${body}</body></html>`;

const signInPage = (next: string): string =>
  pageShell(
    "Sign in — Medina",
    `<h1>Sign in</h1>
<p class="error" id="error"></p>
<form id="sign-in">
  <label>Email<input id="email" type="email" autocomplete="username" required></label>
  <label>Password<input id="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
</form>
<script>
  const next = ${JSON.stringify(next)};
  document.getElementById("sign-in").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("error");
    error.textContent = "";
    try {
      const res = await fetch("/auth/signIn", {
        method: "POST",
        headers: { "content-type": "application/json", "x-effect-auth-csrf": "1" },
        body: JSON.stringify({
          payload: {
            email: document.getElementById("email").value,
            password: document.getElementById("password").value,
            flowId: crypto.randomUUID(),
          },
        }),
      });
      if (!res.ok) throw new Error("Sign-in failed (" + res.status + "). Check the email and password.");
      window.location.assign(next);
    } catch (e) {
      error.textContent = String(e && e.message || e);
    }
  });
</script>`,
  );

const bootstrapPage = (): string =>
  pageShell(
    "Create your account — Medina",
    `<h1>Create your account</h1>
<p class="note">This page exists only while no account does. The
first account created here becomes the owner account; the page
closes itself afterwards.</p>
<form method="POST" action="/auth/bootstrap">
  <label>Email<input name="email" type="email" autocomplete="username" required></label>
  <label>Display name<input name="displayName" type="text" autocomplete="name" required></label>
  <label>Password<input name="password" type="password" autocomplete="new-password" required></label>
  <button type="submit">Create account</button>
</form>`,
  );

const cookieValue = (request: Request, name: string): string | null => {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name && rest.length > 0) return rest.join("=");
  }
  return null;
};

export const makeAuthHost = (
  bucket: R2BucketBindingLike,
  config: AuthHostConfig,
): AuthHost => {
  const store = makeR2ObjectStore(bucket);

  const authService = makeAuthService(authContract, {
    strategies: { password: Password.make({}) },
    sessions: stateful({}),
    defaultStrategy: "password",
  });

  const hashingLayer = PasswordHashing.layer(
    defaultScryptPasswordHashingConfig,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        WebCrypto.layer,
        Kdf.layerWebCrypto,
        PasswordScrypt.layer,
        KdfAdmission.layer(),
      ),
    ),
  );

  const portsLayer = Layer.mergeAll(
    layerPasswordPersistence.pipe(Layer.provide(layerR2(bucket))),
    Layer.succeed(
      authService.sessions.StatefulSessionPersistence,
      makeSessionPersistence(store),
    ),
    Layer.succeed(
      authService.sessions.SessionRepository,
      makeSessionRepository(store),
    ),
    Layer.succeed(authService.strategies.password.SessionClaims, {
      resolve: ({ subjectId }) =>
        Effect.gen(function* () {
          const subject = yield* readSubject(store, subjectId).pipe(
            Effect.mapError(() => PasswordUnavailable.make({})),
          );
          if (subject === null || subject.value.status !== "active") {
            return yield* Effect.fail(PasswordUnavailable.make({}));
          }
          return { displayName: subject.value.displayName };
        }),
    }),
    Layer.succeed(AuthenticationAuthority, makeAuthority(store)),
    hooksLayer,
    hashingLayer,
    WebCrypto.layer,
  );

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      authService.layer.pipe(Layer.provide(portsLayer)),
      hashingLayer,
    ),
  );

  const httpPlatformLayer = Layer.mergeAll(
    FileSystem.layerNoop({}),
    Path.layer,
    Etag.layer,
    HttpPlatform.layer.pipe(
      Layer.provide(FileSystem.layerNoop({})),
    ),
  );

  const webHandler = HttpRouter.toWebHandler(
    AuthHttp.layer(authService, {
      origin: config.origin,
      trustedOrigins: [...config.trustedOrigins],
    }).pipe(
      Layer.provide(portsLayer),
      Layer.provide(httpPlatformLayer),
    ),
    { disableLogger: true },
  );

  const bootstrapOpen: AuthHost["bootstrapOpen"] = store
    .list(SUBJECTS_PREFIX)
    .pipe(
      Effect.map((keys) => keys.length === 0),
      // Fail closed: a store that cannot be read never reads as
      // "zero accounts".
      Effect.catch(() => Effect.succeed(false)),
    );

  const verifyCredential = (credential: string) =>
    Effect.flatMap(authService, (api) =>
      api.verifySession(Redacted.make(credential)),
    );

  const sessionActive: AuthHost["sessionActive"] = (request) =>
    Effect.gen(function* () {
      const credential = cookieValue(request, SESSION_COOKIE);
      if (credential === null || credential === "") return false;
      const exit = yield* Effect.promise(() =>
        runtime.runPromiseExit(verifyCredential(credential)),
      );
      return Exit.isSuccess(exit);
    });

  const handleBootstrapPost = (
    request: Request,
  ): Effect.Effect<Response> =>
    Effect.gen(function* () {
      const open = yield* bootstrapOpen;
      if (!open) {
        return new Response("not found", { status: 404 });
      }
      const form = yield* Effect.promise(() => request.formData());
      const email = String(form.get("email") ?? "").trim();
      const displayName = String(form.get("displayName") ?? "").trim();
      const password = String(form.get("password") ?? "");
      if (email === "" || displayName === "" || password === "") {
        return new Response(
          pageShell(
            "Create your account — Medina",
            `<h1>Create your account</h1><p class="error">All three fields are required.</p><p><a href="/auth/bootstrap">Back</a></p>`,
          ),
          {
            status: 400,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
      // The framework's password policy normalization is NFC; hash
      // exactly the normalized form sign-in will present.
      const verifier = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const hashing = yield* PasswordHashing;
            return yield* hashing.hash(
              Redacted.make(password.normalize("NFC")),
            );
          }),
        ),
      );
      const decision = yield* registerPassword(store, {
        moduleId: PASSWORD_MODULE_ID,
        requestId: crypto.randomUUID(),
        identifier: { namespace: "email", value: email },
        replacement: { verifier, normalization: "NFC" },
        displayName,
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (decision === null) {
        return new Response("registration failed", { status: 500 });
      }
      if (decision._tag !== "Created") {
        return new Response("not found", { status: 404 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "/auth/sign-in?next=%2F" },
      });
    });

  const handle: AuthHost["handle"] = (request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/auth")) return null;
      if (request.method === "GET" && url.pathname === "/auth/sign-in") {
        const rawNext = url.searchParams.get("next") ?? "/";
        const next =
          rawNext.startsWith("/") && !rawNext.startsWith("//")
            ? rawNext
            : "/";
        return new Response(signInPage(next), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/auth/bootstrap") {
        if (request.method === "GET") {
          const open = yield* bootstrapOpen;
          if (!open) return new Response("not found", { status: 404 });
          return new Response(bootstrapPage(), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (request.method === "POST") {
          return yield* handleBootstrapPost(request);
        }
        return new Response("not found", { status: 404 });
      }
      // Everything else under /auth is the framework's operation
      // surface (signIn, getSession, requireSession, signOut,
      // renewSession).
      return yield* Effect.promise(() => webHandler.handler(request));
    });

  return { handle, sessionActive, bootstrapOpen };
};
