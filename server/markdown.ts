import { createServiceWorkerRegistrationScript } from "./service-worker";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInline(markdown: string) {
  return escapeHtml(markdown)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function flushParagraph(out: string[], paragraph: string[]) {
  if (paragraph.length === 0) return;
  out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  paragraph.length = 0;
}

function flushList(out: string[], list: string[]) {
  if (list.length === 0) return;
  out.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
  list.length = 0;
}

export function renderMarkdown(markdown: string) {
  const out: string[] = [];
  const paragraph: string[] = [];
  const list: string[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let code: { lang: string; lines: string[] } | null = null;

  for (const line of lines) {
    const fence = line.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      if (code) {
        out.push(`<pre><code${code.lang ? ` class="language-${escapeHtml(code.lang)}"` : ""}>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
        code = null;
      } else {
        flushParagraph(out, paragraph);
        flushList(out, list);
        code = { lang: fence[1] ?? "", lines: [] };
      }
      continue;
    }

    if (code) {
      code.lines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph(out, paragraph);
      flushList(out, list);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(out, paragraph);
      flushList(out, list);
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
      continue;
    }

    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph(out, paragraph);
      list.push(listItem[1]!);
      continue;
    }

    flushList(out, list);
    paragraph.push(line.trim());
  }

  if (code) out.push(`<pre><code${code.lang ? ` class="language-${escapeHtml(code.lang)}"` : ""}>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
  flushParagraph(out, paragraph);
  flushList(out, list);

  return out.join("\n");
}

export function renderMarkdownDocument(markdown: string, options: { title: string }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="manifest" href="/manifest.json" />
    <link rel="icon" type="image/svg+xml" href="/icon.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="theme-color" content="#0f172a" />
    <title>${escapeHtml(options.title)}</title>
    <style>
      :root { font-family: Inter, system-ui, sans-serif; line-height: 1.5; color: #f4f4f4; background: #111; }
      * { box-sizing: border-box; }
      body { margin: 0; min-width: 320px; min-height: 100vh; background: #111; color: #f4f4f4; }
      main { max-width: 900px; margin: 0 auto; padding: 32px 20px 64px; }
      main::before { content: ""; display: block; width: 72px; height: 72px; margin-bottom: 16px; background: url('/icon.svg') center / contain no-repeat; }
      h1 { font-size: 32px; line-height: 1.1; margin: 0 0 8px; }
      h2 { margin-top: 28px; }
      p, ul { color: #d7d7d7; }
      a { color: #8ab4ff; }
      code { background: #0d0d0d; border: 1px solid #262626; border-radius: 6px; padding: 0.1em 0.35em; color: #f4f4f4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      pre code { display: block; overflow-x: auto; padding: 12px; }
    </style>
  </head>
  <body>
    <main>
${renderMarkdown(markdown)}
    </main>
    ${createServiceWorkerRegistrationScript()}
  </body>
</html>`;
}
