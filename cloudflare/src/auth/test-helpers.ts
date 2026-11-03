/**
 * Shared fixtures for the auth adapter tests. Not a test file.
 *
 * Mutations are always driven the way the framework's operation
 * layer drives them: inside `coordinateCommit`, which provides the
 * CurrentCommitJournal the adapters require, with the framework's
 * default (empty) lifecycle hooks.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { TokenDigest } from "@yielded/auth/Schema";
import {
  EncodedPasswordHash,
  PasswordActionChallenge,
  PasswordCommandId,
  type PasswordCredentialSnapshot,
  type PasswordMutationInput,
  type PasswordReplacement,
} from "@yielded/auth/Password";
import {
  AuthenticationFlowId,
  type AuthenticationEvidence,
  type AuthenticationRequirement,
  type AuthenticationRevision,
} from "@yielded/auth/Sessions";
import {
  coordinateCommit,
  type CommitJournal,
  type PreparedCommit,
} from "@yielded/auth/Hooks";
import { hooksLayer } from "@yielded/auth/Persistence";

export const MODULE_ID = "medina/password";

export const IDENTIFIER = {
  namespace: "email",
  value: "scott@example.com",
} as const;

export const T0 = 1_700_000_000_000;
export const at = (millis: number): DateTime.Utc => DateTime.makeUnsafe(millis);

export const replacement = (verifier: string): PasswordReplacement => ({
  verifier: Redacted.make(EncodedPasswordHash.make(verifier)),
  normalization: "none",
});

export const evidenceFor = (
  revision: AuthenticationRevision,
  credentialId = "cred_fixture",
): AuthenticationEvidence => ({
  revision,
  flowId: AuthenticationFlowId.make("flow-1"),
  bindingDigest: TokenDigest.make("binding-digest-1"),
  proofs: [
    {
      method: "password",
      credentialId,
      factors: ["knowledge"],
      userVerified: false,
      phishingResistant: false,
      verifiedAt: at(T0),
    },
  ],
});

export const REQUIREMENT: AuthenticationRequirement = {
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

export const mutationInput = (args: {
  readonly expectedRevision: AuthenticationRevision;
  readonly credential?: PasswordCredentialSnapshot;
  readonly replacement: PasswordReplacement;
  readonly commandId?: string;
}): PasswordMutationInput => {
  const commandId = PasswordCommandId.make(args.commandId ?? "cmd-1");
  return {
    moduleId: MODULE_ID,
    commandId,
    expectedRevision: args.expectedRevision,
    ...(args.credential === undefined ? {} : { credential: args.credential }),
    replacement: args.replacement,
    authorization: {
      challenge: PasswordActionChallenge.make({
        moduleId: MODULE_ID,
        action: args.credential === undefined ? "add-password" : "change-password",
        commandId,
        revision: args.expectedRevision,
        ...(args.credential === undefined
          ? {}
          : { targetCredentialId: args.credential.credentialId }),
        bindingDigest: TokenDigest.make("binding-digest-1"),
      }),
      evidence: evidenceFor(
        args.expectedRevision,
        args.credential?.credentialId ?? "cred_fixture",
      ),
      requirement: REQUIREMENT,
    },
    invalidation: {
      trigger: "credential-change",
      existingSessions: "immediate",
      maximumExposureMillis: 0,
      oldAuthenticationEvidence: "rejected",
    },
  };
};

/** A prepare callback that prepares the decision/value verbatim. */
export const prepareValue = <V>(value: V, journal: CommitJournal) =>
  journal.prepare(value);

/** Run an owner inside the framework's root commit; returns the
 * owner's value on success, throws on failure. */
export const runCommit = async <A, E>(
  owner: (journal: CommitJournal) => Effect.Effect<A, E>,
): Promise<A> => {
  const result = await Effect.runPromise(
    coordinateCommit(owner).pipe(Effect.provide(hooksLayer)),
  );
  return result.value;
};

/** Run an owner inside the root commit and report the _tag of the
 * first failure reason (or undefined on success). */
export const commitFailureTag = async <A, E>(
  owner: (journal: CommitJournal) => Effect.Effect<A, E>,
): Promise<string | undefined> => {
  const exit = await Effect.runPromise(
    Effect.exit(coordinateCommit(owner).pipe(Effect.provide(hooksLayer))),
  );
  return exitFailureTag(exit);
};

/** Report the _tag of the first failure reason of an Exit. */
export const exitFailureTag = (
  exit: Exit.Exit<unknown, unknown>,
): string | undefined => {
  if (exit._tag !== "Failure") return undefined;
  for (const reason of exit.cause.reasons) {
    if (reason._tag === "Fail") {
      return (reason.error as { readonly _tag?: string })._tag;
    }
    if (reason._tag === "Die") return `Die:${String(reason.defect).slice(0, 200)}`;
  }
  return undefined;
};

/** Run a plain effect and report its first failure _tag. */
export const failureTag = async (
  effect: Effect.Effect<unknown, unknown>,
): Promise<string | undefined> =>
  exitFailureTag(await Effect.runPromise(Effect.exit(effect)));

/** Read a prepared commit after its root commit has committed. */
export const readPrepared = async <A>(
  prepared: PreparedCommit<A>,
): Promise<A> => Effect.runPromise(prepared.read);
