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
  h3 { font-size: 1.05rem; margin: 1.5rem 0 .25rem; }
  p { margin: .75rem 0; }
  .stale { font-size: .75rem; font-weight: normal; color: #999; margin-left: .5rem; }
  .vtable-tools { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; color: #777; }
  .vtable-tools input { font: inherit; padding: .25rem .5rem; }
  .vtable-tools button { font: inherit; padding: .25rem .75rem; cursor: pointer; }
  .vtable { overflow-y: auto; height: 70vh; border-top: 1px solid #bbb; margin-top: 1rem; position: relative; }
  .vspacer { position: relative; width: 100%; }
  .vrow { position: absolute; left: 0; right: 0; height: 100px; }
  .vrow-inner { box-sizing: border-box; height: 100px; padding: 10px 0; overflow: hidden; border-bottom: 1px solid #ddd; }
  .vrow-inner h2 { font-size: 1.1rem; margin: 0 0 .25rem; }
  .vrow-inner p { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vrow-inner p.preview { color: #333; }
  .prow { display: flex; gap: .5rem; align-items: baseline; flex-wrap: wrap; margin: .5rem 0; }
  .prow input { font: inherit; padding: .25rem .5rem; }
  .prow input.num { width: 6.5rem; }
  .pcand { border-bottom: 1px solid #ddd; padding: .5rem 0; }
  .pplace { border-bottom: 1px solid #ddd; padding: .5rem 0; }
  .pmap { display: block; margin: .5rem 0; border: 1px solid #ddd; }
  button { font: inherit; padding: .25rem .75rem; cursor: pointer; }
  @media (prefers-color-scheme: dark) { .vrow-inner p.preview { color: #ccc; } }
  .skel { height: .9rem; margin: .2rem 0; background: #e2e2e2; }
  @media (prefers-color-scheme: dark) { .skel { background: #333; } }
`

const Layout = ({ title, children, scriptSrc }: { title: string; children?: Child; scriptSrc?: string }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{raw(STYLE)}</style>
    </head>
    <body>
      {children}
      {scriptSrc ? <script src={scriptSrc} defer></script> : ""}
    </body>
  </html>
)

/** The report is a summary line followed by `##` time-chunk headers with
 * terse lines under each: blank lines separate blocks, single newlines are
 * line breaks. Each line is escaped on the way in. */
const Report = ({ text }: { text: string }) => (
  <>
    {text.split(/\n\s*\n/).filter(Boolean).map((block) => {
      const [first, ...rest] = block.split("\n")
      if (first!.trim().startsWith("## ")) {
        return (
          <>
            <h3>{first!.trim().replace(/^##\s+/, "")}</h3>
            {rest.length > 0 ? (
              <p>
                {rest.map((line, index) => (
                  <>{index > 0 ? raw("<br>") : ""}{line}</>
                ))}
              </p>
            ) : ""}
          </>
        )
      }
      return (
        <p>
          {block.split("\n").map((line, index) => (
            <>{index > 0 ? raw("<br>") : ""}{line}</>
          ))}
        </p>
      )
    })}
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

/** The SPA shell: static markup plus the client bundle. Journal content
 * loads over the typed RPC, so this page needs no data at serve time. */
export const spaHome = () =>
  "<!doctype html>" + render(
    <Layout title="Medina" scriptSrc="/app.js">
      <header>
        <h1>Journal</h1>
        <p>Daily reports from the Medina data dir.</p>
      </header>
      <main id="app">
        <p class="empty">Loading…</p>
      </main>
      <noscript><p class="empty">The journal loads over a typed RPC and needs JavaScript.</p></noscript>
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

/** Placeholder for a day whose journal is not on disk yet. The hourly
 * pipeline pass materializes it; the request path never does. */
export const pendingPage = (day: string) =>
  "<!doctype html>" + render(
    <Layout title={`Medina — ${day}`}>
      <header>
        <h1>{day}</h1>
        <p><a href="/">All days</a></p>
      </header>
      <main>
        <p class="empty">writing…</p>
      </main>
    </Layout>
  )
