import { describe, expect, test } from "bun:test";
import { createHomeHtml, createHomeInfo } from "./home-page";

describe("home page", () => {
  test("renders useful HTML from markdown without client-side JavaScript", () => {
    const html = createHomeHtml(`# Medina

Agents: [AGENTS.md]({{agentsUrl}})

## Endpoint

\`{{endpoint}}\`

## Token

{{tokenHelp}}
`, createHomeInfo("https://medina.example"));
    expect(html).toContain("<h1>Medina</h1>");
    expect(html).toContain('<link rel="manifest" href="/manifest.json" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).toContain('<meta name="theme-color" content="#0f172a" />');
    expect(html).toContain('navigator.serviceWorker.register("/sw.js")');
    expect(html).toContain('href="https://medina.example/agents.md"');
    expect(html).toContain("https://medina.example");
    expect(html).toContain("Ask the server owner");
    expect(html).not.toContain('href="https://medina.example/api.md"');
    expect(html).not.toContain('href="https://medina.example/app"');
    expect(html).not.toContain('href="https://medina.example/medina-cli.ts"');
    expect(html).not.toContain('id="root"');
  });
});
