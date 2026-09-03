/**
 * Server-rendered pages. Components are plain functions returning markup;
 * `lib/Html.ts` escapes every interpolated string, so journal text — which
 * is LLM output derived from untrusted transcripts — cannot inject markup.
 */
import { raw, render, type Child } from "../lib/Html.ts"
import type { Journal } from "./Resources.ts"
import type { JournalView } from "./Views.ts"

const STYLE = `
  :root { color-scheme: light dark; font-family: ui-serif, Georgia, serif; }
  body { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 6rem; line-height: 1.6; }
  h1 { font-size: 2.25rem; margin: 0; }
  header p, .empty { color: #777; }
  section { border-top: 1px solid #bbb; margin-top: 2.5rem; padding-top: 1.5rem; }
  h2 { font-size: 1.25rem; margin: 0 0 1rem; }
  h2 a { color: inherit; text-decoration: none; }
  h2 a:hover { text-decoration: underline; }
  p { margin: .75rem 0; }
  .stale { font-size: .75rem; font-weight: normal; color: #999; margin-left: .5rem; }
`

const Layout = ({ title, children }: { title: string; children?: Child }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{raw(STYLE)}</style>
    </head>
    <body>{children}</body>
  </html>
)

/** The report is plain text: blank lines separate paragraphs, single
 * newlines are line breaks. Each line is escaped on the way in. */
const Report = ({ text }: { text: string }) => (
  <>
    {text.split(/\n\s*\n/).filter(Boolean).map((paragraph) => (
      <p>
        {paragraph.split("\n").map((line, index) => (
          <>{index > 0 ? raw("<br>") : ""}{line}</>
        ))}
      </p>
    ))}
  </>
)

const DayEntry = ({ view }: { view: JournalView }) => (
  <section>
    <h2>
      <a href={`/journal/${view.journal.day}`}>{view.journal.day}</a>
      {view.stale ? <span class="stale">rewriting</span> : ""}
    </h2>
    <Report text={view.journal.report} />
  </section>
)

export const journalPage = (views: ReadonlyArray<JournalView>) =>
  "<!doctype html>" + render(
    <Layout title="Medina">
      <header>
        <h1>Journal</h1>
        <p>Daily reports from the Medina data dir.</p>
      </header>
      <main>
        {views.length === 0
          ? <p class="empty">No journal days yet.</p>
          : views.map((view) => <DayEntry view={view} />)}
      </main>
    </Layout>
  )

export const dayPage = (journal: Journal) =>
  "<!doctype html>" + render(
    <Layout title={`Medina — ${journal.day}`}>
      <header>
        <h1>{journal.day}</h1>
        <p><a href="/">All days</a></p>
      </header>
      <main>
        {journal.report ? <Report text={journal.report} /> : <p class="empty">Nothing recorded.</p>}
      </main>
    </Layout>
  )
