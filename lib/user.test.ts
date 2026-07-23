import { expect, test } from "bun:test";
import { isValidUser, userFromEnv, userFromRequest } from "./user";
import { tailscaleUserLoginHeader } from "./authz";

test("returns the configured default user", () => {
  expect(userFromEnv({
    MEDINA_EMAILS: "owner@example.com",
    MEDINA_TOKEN: "secret",
    MEDINA_PROFILE_PIC_URL: "https://example.com/avatar.jpg",
  })).toEqual({
    credentials: [{ type: "email", value: "owner@example.com" }],
    profile_pic_url: "https://example.com/avatar.jpg",
    tokens: [{ label: "default", token: "secret" }],
    username: "default",
  });
});

test("requires the default token", () => {
  expect(() => userFromEnv({})).toThrow("Missing MEDINA_TOKEN");
});

test("uses the hosted default profile pic when none is configured", () => {
  expect(userFromEnv({ MEDINA_TOKEN: "secret" }).profile_pic_url).toBe("/default-profile.jpg");
});

test("valid users need a username and profile pic", () => {
  expect(isValidUser({ username: "default", profile_pic_url: "/default-profile.jpg", credentials: [], tokens: [] })).toBe(true);
  expect(isValidUser({ username: "", profile_pic_url: "/default-profile.jpg", credentials: [], tokens: [] })).toBe(false);
});

test("derives a current user from Tailscale headers", () => {
  const headers = new Headers({
    "Tailscale-User-Login": "ScottRaymond@Example.com",
    "Tailscale-User-Name": "Scott Raymond",
    "Tailscale-User-Profile-Pic": "https://example.com/scott.jpg",
  });

  expect(userFromRequest(new Request("https://example.test", { headers }), [])).toMatchObject({
    auth_method: "tailscale",
    credentials: [{ type: "tailscale", value: "ScottRaymond@Example.com" }],
    profile_pic_url: "https://example.com/scott.jpg",
    username: "Scott Raymond",
  });
});

test("links token authorization to the user that owns the token", () => {
  const request = new Request("https://example.test/recordings.json", {
    headers: { Authorization: "Bearer secret" },
  });

  expect(userFromRequest(request, [{
    credentials: [],
    profile_pic_url: "/default-profile.jpg",
    tokens: [{ token: "secret" }],
    username: "default",
  }])).toMatchObject({
    auth_method: "token",
    username: "default",
  });
});

test("links Tailscale authorization by credential", () => {
  const request = new Request("https://example.test/recordings.json", {
    headers: { [tailscaleUserLoginHeader]: "owner@example.com" },
  });

  expect(userFromRequest(request, [{
    credentials: [{ type: "tailscale", value: "owner@example.com" }],
    profile_pic_url: "/default-profile.jpg",
    tokens: [],
    username: "default",
  }])).toMatchObject({
    auth_method: "tailscale",
    username: "default",
  });
});
