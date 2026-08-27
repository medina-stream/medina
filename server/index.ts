import { Hono } from "hono";
import { stream } from "../lib/stream";
import { EasyVoice } from "../resources/EasyVoice";
import { Journal, journalArtifact, type JournalResult } from "../resources/Journal";
import { Root } from "../resources/Root";
import { Triage } from "../resources/Triage";
import { SourceIngest, SourceRefresh } from "../workflows/Source";

const app = new Hono<{ Bindings: Env }>();

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function reportHtml(report: string) {
  return report
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function page(journals: JournalResult[]) {
  const sections = journals.length
    ? journals.map((journal) => `<section><h2>${escapeHtml(journal.day)}</h2>${reportHtml(journal.report)}</section>`).join("\n")
    : "<p class=empty>No journal days yet.</p>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Medina</title><style>
  :root { color-scheme: light dark; font-family: ui-serif, Georgia, serif; }
  body { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 6rem; line-height: 1.6; }
  h1 { font-size: 2.25rem; margin: 0; } header p, .empty { color: #777; } section { border-top: 1px solid #bbb; margin-top: 2.5rem; padding-top: 1.5rem; }
  h2 { font-size: 1.25rem; margin: 0 0 1rem; } p { margin: .75rem 0; }
</style></head><body><header><h1>Journal</h1><p>Daily reports from available Medina artifacts.</p></header><main>${sections}</main></body></html>`;
}

app.get("/", async (c) => {
  const reports = await stream(c.env).journalReports();
  const journals = (await Promise.all(reports.map((report) => journalArtifact(c.env, report.journalKey)))).filter((journal): journal is JournalResult => journal !== null);
  return c.html(page(journals));
});

export { Stream } from "../lib/stream";
export { AssemblyAITranscript } from "../resources/AssemblyAITranscript";
export { Journal } from "../resources/Journal";
export { Root } from "../resources/Root";
export { Triage } from "../resources/Triage";
export { SourceIngest, SourceRefresh } from "../workflows/Source";
export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(env.SOURCE_REFRESH.create({ params: EasyVoice(env) }));
  },
};
