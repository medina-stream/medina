import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

describe("markdown renderer", () => {
  test("renders headings, links, lists, and inline code", () => {
    expect(renderMarkdown(`# Title

Use [the CLI](/medina-cli.ts) with \`MEDINA_TOKEN\`.

- one
- two
`)).toContain('<a href="/medina-cli.ts">the CLI</a>');
    expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
  });
});
