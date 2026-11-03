import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  SessionClaims,
  authContract,
  sessionContract,
} from "./contract.ts";
import { T0 } from "./test-helpers.ts";

describe("auth contract", () => {
  it("exposes the framework session actions plus password signIn", () => {
    assert.equal(authContract.namespace, "medina");
    assert.equal(authContract.basePath, "/auth");
    for (const name of [
      "getSession",
      "requireSession",
      "signOut",
      "renewSession",
      "signIn",
    ]) {
      assert.ok(name in authContract.actions, `missing action ${name}`);
    }
  });

  it("routes signIn as a credentialed POST under /auth", () => {
    const signIn = authContract.actions.signIn;
    assert.equal(signIn.route.path, "/auth/signIn");
    assert.equal(signIn.route.method, "POST");
    assert.equal(signIn.route.operation.credentials, true);
    assert.equal(signIn.method, "signIn");
  });

  it("binds the session contract to medina/sessions with the same claims codec", () => {
    assert.equal(sessionContract.moduleId, "medina/sessions");
    assert.equal(authContract.sessions, sessionContract);
    assert.equal(sessionContract.Session.fields.claims, SessionClaims);
  });

  it("round-trips the claims codec", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeEffect(SessionClaims)({ displayName: "Scott" }),
    );
    assert.equal(decoded.displayName, "Scott");
    const encoded = await Effect.runPromise(
      Schema.encodeEffect(SessionClaims)(decoded),
    );
    assert.deepEqual(encoded, { displayName: "Scott" });
  });

  it("decodes an Authenticated completion in wire form", async () => {
    const wire = {
      _tag: "Authenticated",
      session: {
        sessionId: "ses_1",
        subjectId: "sub_1",
        securityRevision: "r_1",
        assurance: {
          method: "password",
          factors: ["knowledge"],
          authenticatedAt: T0,
        },
        issuedAt: T0,
        expiresAt: T0 + 3_600_000,
        absoluteExpiresAt: T0 + 43_200_000,
        claims: { displayName: "Scott" },
      },
    } as const;
    const decoded = await Effect.runPromise(
      Schema.decodeEffect(sessionContract.CompletionResult)(wire),
    );
    assert.equal(decoded._tag, "Authenticated");
    if (decoded._tag !== "Authenticated") return;
    assert.equal(decoded.session.claims.displayName, "Scott");
    assert.equal(decoded.session.subjectId, "sub_1");
  });
});
