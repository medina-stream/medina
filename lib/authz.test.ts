import { describe, expect, test } from "bun:test";
import { authorizeRequest, constantTimeTokenEquals, extractMedinaToken, parseTailscaleAuthLogins, tailscaleUserLoginHeader, type AuthPolicy } from "./authz";

function request(headers?: Record<string, string>, url = "https://example.test/status.json") {
  return new Request(url, { headers });
}

describe("stream authz", () => {
  test("public policy allows anonymous requests", () => {
    const decision = authorizeRequest({ mode: "public" }, request(), {});
    expect(decision).toEqual({ allowed: true, reason: "public" });
  });

  test("token policy checks bearer, basic, query, and Medina token headers", () => {
    const secured: AuthPolicy = { mode: "token", tokenEnvVar: "MEDINA_TEST_TOKEN" };
    const env = { MEDINA_TEST_TOKEN: "right-token" };
    expect(authorizeRequest(secured, request(), env)).toMatchObject({ allowed: false, reason: "missing-token", status: 401 });
    expect(authorizeRequest(secured, request({ Authorization: "Bearer wrong-token" }), env)).toMatchObject({ allowed: false, reason: "bad-token", status: 403 });
    expect(authorizeRequest(secured, request({ Authorization: "Bearer right-token" }), env)).toEqual({ allowed: true, reason: "token" });
    expect(authorizeRequest(secured, request({ Authorization: `Basic ${btoa(':right-token')}` }), env)).toEqual({ allowed: true, reason: "token" });
    expect(authorizeRequest(secured, request({ "X-Medina-Token": "right-token" }), env)).toEqual({ allowed: true, reason: "token" });
    expect(authorizeRequest(secured, request(undefined, "https://example.test/status.json?token=right-token"), env)).toEqual({ allowed: true, reason: "token" });
  });

  test("token_or_tailscale accepts either credential", () => {
    const secured: AuthPolicy = { mode: "token_or_tailscale", tokenEnvVar: "MEDINA_TEST_TOKEN" };
    const env = { MEDINA_TEST_TOKEN: "right-token" };

    expect(authorizeRequest(secured, request({ Authorization: "Bearer right-token" }), env)).toEqual({ allowed: true, reason: "token" });
    expect(authorizeRequest(secured, request({ [tailscaleUserLoginHeader]: "Alice@example.com" }), env)).toEqual({ allowed: true, reason: "tailscale" });
    expect(authorizeRequest(secured, request(), env)).toMatchObject({ allowed: false, reason: "missing-token", status: 401 });
  });

  test("tailscale login allowlist uses policy allowlist before global fallback", () => {
    const perStream: AuthPolicy = {
      mode: "tailscale",
      allowedTailscaleLogins: ["alice@example.com"],
    };
    const fallbackGlobal: AuthPolicy = { mode: "tailscale" };
    const env = { MEDINA_TAILSCALE_AUTH_LOGINS: "bob@example.com" };

    expect(authorizeRequest(perStream, request({ [tailscaleUserLoginHeader]: "alice@example.com" }), env)).toEqual({ allowed: true, reason: "tailscale" });
    expect(authorizeRequest(perStream, request({ [tailscaleUserLoginHeader]: "bob@example.com" }), env)).toMatchObject({ allowed: false, reason: "tailscale-login-forbidden", status: 403 });
    expect(authorizeRequest(fallbackGlobal, request({ [tailscaleUserLoginHeader]: "bob@example.com" }), env)).toEqual({ allowed: true, reason: "tailscale" });
  });

  test("tailscale policy requires a login header", () => {
    const secured: AuthPolicy = { mode: "tailscale" };

    expect(authorizeRequest(secured, request({ [tailscaleUserLoginHeader]: "alice@example.com" }), {})).toEqual({ allowed: true, reason: "tailscale" });
    expect(authorizeRequest(secured, request(), {})).toMatchObject({ allowed: false, reason: "missing-tailscale-login", status: 401 });
  });
});

describe("auth helpers", () => {
  test("extracts bearer token before Basic auth and X-Medina-Token", () => {
    const basic = btoa(":basic-pass");
    expect(extractMedinaToken(new Headers({ Authorization: "Bearer abc", "X-Medina-Token": "fallback" }))).toBe("abc");
    expect(extractMedinaToken(new Headers({ Authorization: `Basic ${basic}`, "X-Medina-Token": "fallback" }))).toBe("basic-pass");
    expect(extractMedinaToken(new Headers({ "X-Medina-Token": "fallback" }))).toBe("fallback");
  });

  test("constant-time token compare matches exact strings only", () => {
    expect(constantTimeTokenEquals("abc", "abc")).toBe(true);
    expect(constantTimeTokenEquals("abc", "abd")).toBe(false);
    expect(constantTimeTokenEquals("abc", "abcd")).toBe(false);
    expect(constantTimeTokenEquals(null, "abc")).toBe(false);
  });

  test("parses and deduplicates tailscale allowlist", () => {
    expect(parseTailscaleAuthLogins(" Alice@example.com,alice@example.com, bob@example.com ,, ")).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });
});
