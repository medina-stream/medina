import { expect, test } from "bun:test";
import { getAppPath } from "./app-path";

test("getAppPath strips the expo base path prefix", () => {
  expect(getAppPath(new URL("http://localhost/app"))).toBe("");
  expect(getAppPath(new URL("http://localhost/app/"))).toBe("");
  expect(getAppPath(new URL("http://localhost/app/_expo/static/js/web/entry.js"))).toBe("_expo/static/js/web/entry.js");
});

test("getAppPath preserves non-app routes", () => {
  expect(getAppPath(new URL("http://localhost/"))).toBe("");
  expect(getAppPath(new URL("http://localhost/docs"))).toBe("docs");
});
