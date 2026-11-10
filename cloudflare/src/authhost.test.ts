/**
 * Host-level regression tests: the full sign-in loop through
 * makeAuthHost's HTTP handler against a fake R2 bucket —
 * bootstrap → sign in → session cookie → session check → sign out.
 * The port-level suites root commits explicitly (test-helpers'
 * runCommit); this suite exists because production operations run
 * WITHOUT an ambient commit root, and sign-in silently failed with
 * PasswordUnavailable until the ports learned to root their own
 * commits (Nov 9–10, 2026).
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { makeAuthHost } from "./authhost.ts";

interface Obj {
  value: string;
  etag: string;
}

const fakeBucket = () => {
  const objects = new Map<string, Obj>();
  let counter = 0;
  return {
    async get(key: string) {
      const obj = objects.get(key);
      return obj === undefined
        ? null
        : { etag: obj.etag, text: async () => obj.value };
    },
    async put(
      key: string,
      value: string,
      options?: {
        onlyIf?: { etagMatches: string } | { etagDoesNotMatch: string };
      },
    ) {
      const existing = objects.get(key);
      const onlyIf = options?.onlyIf;
      if (onlyIf !== undefined) {
        if ("etagDoesNotMatch" in onlyIf) {
          if (existing !== undefined) return null;
        } else if (
          existing === undefined ||
          existing.etag !== onlyIf.etagMatches
        ) {
          return null;
        }
      }
      const etag = `"etag-${++counter}"`;
      objects.set(key, { value, etag });
      return { etag };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(options: { prefix?: string; cursor?: string }) {
      const prefix = options.prefix ?? "";
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };
};

const ORIGIN = "https://sco.medina.stream";

const setup = () =>
  makeAuthHost(fakeBucket() as never, {
    origin: ORIGIN,
    trustedOrigins: [ORIGIN],
  });

const call = async (
  host: ReturnType<typeof setup>,
  request: Request,
): Promise<Response> => {
  const response = await Effect.runPromise(host.handle(request));
  assert.notEqual(response, null);
  return response as Response;
};

const bootstrap = async (
  host: ReturnType<typeof setup>,
  email = "first@example.com",
  password = "correct horse battery staple",
) => {
  const form = new FormData();
  form.set("email", email);
  form.set("displayName", "First User");
  form.set("password", password);
  return call(
    host,
    new Request(`${ORIGIN}/auth/bootstrap`, {
      method: "POST",
      body: form,
    }),
  );
};

const signIn = async (
  host: ReturnType<typeof setup>,
  email: string,
  password: string,
) =>
  call(
    host,
    new Request(`${ORIGIN}/auth/signIn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-effect-auth-csrf": "1",
      },
      body: JSON.stringify({
        payload: { email, password, flowId: crypto.randomUUID() },
      }),
    }),
  );

describe("authhost sign-in loop", () => {
  it("bootstrap closes after the first account; sign-in issues a working session", async () => {
    const host = setup();
    assert.equal(await Effect.runPromise(host.bootstrapOpen), true);

    const created = await bootstrap(host);
    assert.equal(created.status, 302);
    assert.equal(await Effect.runPromise(host.bootstrapOpen), false);

    // Signing up leaves you signed in: the bootstrap response
    // itself carries a session cookie and redirects to `next`
    // (default "/"), and the cookie opens a session-gated read
    // with no sign-in call in between.
    assert.equal(created.headers.get("location"), "/");
    const bootstrapCookie = created.headers.get("set-cookie") ?? "";
    assert.match(bootstrapCookie, /__Host-effect-auth-session=/);
    const sessionCookie = bootstrapCookie.split(";")[0]!;
    const gated = await call(
      host,
      new Request(`${ORIGIN}/auth/requireSession`, {
        method: "GET",
        headers: { origin: ORIGIN, cookie: sessionCookie },
      }),
    );
    assert.equal(gated.status, 200);
    const gatedRequest = new Request(`${ORIGIN}/`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(
      await Effect.runPromise(host.sessionActive(gatedRequest)),
      true,
    );

    // Bootstrap is closed now.
    const second = await bootstrap(host, "second@example.com");
    assert.equal(second.status, 404);

    // Wrong password is a rejection, not an availability failure.
    const wrong = await signIn(
      host,
      "first@example.com",
      "not the password",
    );
    assert.equal(wrong.status, 400);
    const wrongBody = (await wrong.json()) as {
      error?: { _tag?: string };
    };
    assert.equal(wrongBody.error?._tag, "PasswordRejected");

    // Right password: 200 + the session cookie.
    const ok = await signIn(
      host,
      "first@example.com",
      "correct horse battery staple",
    );
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /__Host-effect-auth-session=/);
    const cookie = setCookie.split(";")[0]!;

    // The session verifies through the host's gate check.
    const authed = new Request(`${ORIGIN}/`, {
      headers: { cookie },
    });
    assert.equal(await Effect.runPromise(host.sessionActive(authed)), true);
    const anon = new Request(`${ORIGIN}/`);
    assert.equal(await Effect.runPromise(host.sessionActive(anon)), false);
  });
});
