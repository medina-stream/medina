/**
 * Server-rendered pages. Components are plain functions returning markup;
 * `lib/Html.ts` escapes every interpolated string, so journal text — which
 * is LLM output derived from untrusted transcripts — cannot inject markup.
 */
import { raw, render, type Child } from "../Html.ts"
import { dayId } from "./DayLabels.ts"
import type { Journal } from "./Resources.ts"
import type { JournalView } from "./Views.ts"

const STYLE = `
  /* Inter, self-hosted (see the /inter.woff2 route). One typeface for the
     whole UI: no serif stack, no second family for controls. */
  @font-face {
    font-family: "Inter";
    font-style: normal;
    font-weight: 100 900;
    font-display: swap;
    src: url("/inter.woff2") format("woff2");
  }
  :root {
    color-scheme: light dark;
    --ui: "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
    font-family: var(--ui);
    /* Inter's optical sizing and tabular figures: dates line up in a column
       when the digits are all the same width. */
    font-optical-sizing: auto;
    --ink: #1a1a1a;
    --muted: #6b6b6b;
    --rule: #d8d4cc;
    --rule-soft: #e8e5df;
    --bg: #fdfdfc;
    --surface: #f5f3ef;
    --accent: #2f6f4f;
    --bad: #b93f3f;
    --warn: #b07d1a;
    /* Tap targets: 44px is the accessibility floor on touch. */
    --tap: 2.75rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #ececec; --muted: #9a9a9a; --rule: #3a3a3a; --rule-soft: #2c2c2c;
      --bg: #151515; --surface: #1e1e1e; --accent: #6fbf8f; --bad: #e07070; --warn: #d6a94a;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--ui);
    max-width: 46rem;
    margin: 0 auto;
    padding: 1.25rem 1.25rem 4rem;
    line-height: 1.55;
    color: var(--ink);
    background: var(--bg);
    /* Keep long place names and URLs from forcing a sideways scroll. */
    overflow-wrap: break-word;
  }
  @media (max-width: 34rem) { body { padding: .75rem 1rem 3rem; } }
  h1 { font-size: 1.5rem; margin: 0; line-height: 1.2; letter-spacing: -.01em; }
  h2 { font-size: 1.15rem; margin: 0 0 1rem; line-height: 1.3; letter-spacing: -.01em; }
  h3 { font-size: 1rem; margin: 1.5rem 0 .25rem; }
  header p, .empty { color: var(--muted); }
  section { border-top: 1px solid var(--rule); margin-top: 2.5rem; padding-top: 1.5rem; }
  h2 a { color: inherit; text-decoration: none; }
  h2 a:hover { text-decoration: underline; }
  p { margin: .7rem 0; }
  a { color: var(--accent); }
  .stale { font-size: .7rem; font-weight: 500; color: var(--muted); }

  /* Room for the floating account button above whatever the view puts
     first -- a day row's badge or the Places heading. Set on the mount
     rather than inside the table, so the virtual scroll math keeps its
     one-to-one mapping from scrollTop to row index. */
  #app { padding-top: 3.25rem; }

  /* Controls: one look, and never smaller than a comfortable tap. */
  input, button, select {
    font-family: var(--ui);
    font-size: 1rem; /* iOS zooms the page on focus below 16px. */
    color: inherit;
    border: 1px solid var(--rule);
    border-radius: .4rem;
    background: var(--bg);
    padding: .45rem .6rem;
    min-height: var(--tap);
  }
  button {
    background: var(--surface);
    cursor: pointer;
    padding-inline: .9rem;
    white-space: nowrap;
  }
  button:hover { border-color: var(--muted); }
  button:active { transform: translateY(1px); }
  button.danger { color: var(--bad); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* The account button floats over the list's top-right corner. The list
     gets matching top padding so the first row's badge never sits under it. */
  .accountbutton {
    position: fixed; top: .6rem; right: max(.6rem, calc((100vw - 46rem) / 2));
    z-index: 2; background: var(--bg); border-color: var(--rule-soft);
  }
  .iconbutton {
    display: inline-flex; align-items: center; justify-content: center; gap: .35rem;
    min-width: var(--tap); min-height: var(--tap);
    padding: .25rem .5rem; border-radius: .5rem;
    background: transparent; border: 1px solid transparent; color: var(--muted);
  }
  .iconbutton:hover { background: var(--surface); border-color: var(--rule); color: var(--ink); }
  #account-dot { margin: 0; }
  .accountnav { display: flex; gap: 1rem; padding-bottom: .9rem; margin-bottom: .3rem; border-bottom: 1px solid var(--rule-soft); }
  .accountnav a { font-weight: 550; text-decoration: none; }
  .accountnav a:hover { text-decoration: underline; }

  /* Status and live feed (inside the account modal) */
  .status { font-size: .875rem; }
  .status-line { margin: 0 0 .5rem; font-weight: 600; }
  .status-dot {
    display: inline-block; width: .6rem; height: .6rem; border-radius: 50%;
    background: var(--muted); flex: none;
  }
  .status.good #account-dot, .status-dot.good { background: var(--accent); }
  .status.warn #account-dot, .status-dot.warn { background: var(--warn); }
  .status.bad #account-dot, .status-dot.bad { background: var(--bad); }
  .status ul { margin: .5rem 0 1rem; padding-left: 1.25rem; }
  .status li { margin: .15rem 0; }
  .live-list {
    font-size: .8rem;
    max-height: 40vh; overflow-y: auto; margin: .5rem 0 0; padding-left: 1.5rem;
  }
  .live-list li { margin: .2rem 0; }
  .event-time { color: var(--muted); margin-right: .4rem; }
  .event-failing { color: var(--bad); }

  /* Modals. A native dialog gives focus trapping and Esc for free. */
  .modal {
    width: min(42rem, 100vw - 2rem);
    max-height: min(85vh, 60rem);
    padding: 0; border: 1px solid var(--rule); border-radius: .75rem;
    background: var(--bg); color: var(--ink);
    box-shadow: 0 12px 40px rgb(0 0 0 / .28);
    overflow: hidden;
  }
  .modal::backdrop { background: rgb(0 0 0 / .45); }
  .modal-head {
    display: flex; align-items: center; gap: .75rem;
    padding: .85rem 1.1rem; border-bottom: 1px solid var(--rule-soft);
    position: sticky; top: 0; background: var(--bg);
  }
  .modal-head h2 { flex: 1 1 auto; margin: 0; font-size: 1.15rem; }
  .modal-body { padding: 1rem 1.1rem 1.5rem; overflow-y: auto; max-height: calc(85vh - 4rem); }
  .modal-body h3 { margin-top: 1.25rem; }
  @media (max-width: 34rem) {
    /* Full-bleed sheet on a phone: more room, and a familiar shape. */
    .modal {
      width: 100vw; max-width: 100vw; max-height: 92vh;
      margin: auto auto 0; border-radius: .9rem .9rem 0 0; border-bottom: 0;
    }
    .modal-body { max-height: calc(92vh - 4rem); }
  }

  /* Days table. No page header any more, so the list starts at the top. */
  .vtable { overflow-y: auto; height: min(84vh, 58rem); position: relative; -webkit-overflow-scrolling: touch; }
  .vspacer { position: relative; width: 100%; }
  .vrow { position: absolute; left: 0; right: 0; height: 100px; }
  /* The whole row is the target, so it is a button, not a link inside text. */
  .vrow-inner {
    display: block; width: 100%; height: 100px; text-align: left;
    padding: 14px .5rem; margin: 0; overflow: hidden;
    background: none; border: 0; border-bottom: 1px solid var(--rule-soft);
    border-radius: 0; cursor: pointer; color: inherit;
  }
  .vrow-inner:hover { background: var(--surface); }
  .vrow-inner:active { transform: none; }
  .vrow-title { display: flex; align-items: baseline; gap: .55rem; margin-bottom: .3rem; }
  /* Tabular figures keep the compact dates in a true column. */
  .vrow-day {
    font-size: 1rem; font-weight: 620; letter-spacing: -.01em;
    font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1;
  }
  .vrow-rel { font-size: .8rem; color: var(--muted); }
  .vrow-audio {
    margin-left: auto; flex: none;
    font-size: .7rem; font-variant-numeric: tabular-nums;
    color: var(--muted); background: var(--surface);
    border: 1px solid var(--rule-soft); border-radius: 999px;
    padding: .1rem .45rem;
  }
  .vrow-inner p { margin: 0; font-size: .9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vrow-inner p.preview { color: var(--ink); }

  /* Transcript search: results are whole buttons so the day target is
     generous on touch without a nested-link focus trap. */
  .search-form { display: flex; gap: .5rem; margin: 0 0 1rem; }
  .search-form input { flex: 1 1 auto; min-width: 0; }
  .search-hit { display: flex; flex-direction: column; gap: .2rem; width: 100%; text-align: left; white-space: normal; border: 0; border-bottom: 1px solid var(--rule-soft); border-radius: 0; padding: .85rem 0; background: transparent; }
  .search-hit:hover { background: var(--surface); }
  .search-hit-meta { color: var(--muted); font-size: .78rem; font-variant-numeric: tabular-nums; }

  /* Day detail keeps the generated summary first, followed by the source
     turns. Chunk headings behave as links to their nearest transcript time. */
  .transcripts { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--rule); }
  .transcript-jump { min-height: 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: inherit; font: inherit; font-weight: inherit; text-align: left; }
  .transcript-jump:hover { color: var(--accent); text-decoration: underline; }
  .transcript-recording { margin: 1rem 0 1.35rem; }
  .transcript-recording h4 { margin: 0 0 .45rem; color: var(--muted); font-size: .8rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .transcript-turn { margin: 0; padding: .42rem 0 .42rem 4.4rem; position: relative; scroll-margin-block: 5rem; }
  .transcript-time { position: absolute; left: 0; width: 3.6rem; color: var(--muted); font-size: .78rem; font-variant-numeric: tabular-nums; }
  .transcript-speaker { font-weight: 650; margin-right: .45rem; }

  /* Places editor. The row is a wrapping grid: wide screens get one line,
     narrow screens stack into labelled fields instead of a jumble. */
  .pplace, .pcand { border-bottom: 1px solid var(--rule-soft); padding: 1rem 0; }
  .prow { display: flex; gap: .5rem .6rem; flex-wrap: wrap; align-items: end; margin: .5rem 0; }
  .pfield { display: flex; flex-direction: column; gap: .15rem; flex: 1 1 7rem; min-width: 0; }
  .pfield-name { flex: 2 1 11rem; }
  .pfield-narrow { flex: 0 1 6rem; }
  .pfield span { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .pfield input { width: 100%; }
  .prow button { align-self: end; }
  @media (max-width: 34rem) {
    .pfield, .pfield-name, .pfield-narrow { flex: 1 1 100%; }
    .prow button { width: 100%; }
  }
  .pcand-head { display: flex; flex-wrap: wrap; gap: .25rem .5rem; align-items: baseline; }
  .pcand-meta { font-size: .8rem; color: var(--muted); }
  .psave { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; margin: 1rem 0; }
  #place-status { font-size: .85rem; color: var(--muted); }
  .paddr { display: flex; gap: .5rem; margin: .5rem 0; }
  .paddr input { flex: 1 1 auto; min-width: 0; }

  /* Map: a tile grid with a fixed centre pin. Clipped to its box, so the
     tiles that overhang the edges simply do not show. */
  .pmap {
    position: relative; overflow: hidden; cursor: crosshair;
    width: 100%; height: 220px; margin: .5rem 0;
    border: 1px solid var(--rule); border-radius: .5rem;
    background: var(--surface); touch-action: manipulation;
  }
  .ptiles {
    position: absolute; top: 0; bottom: 0;
    /* The grid is generated for the widest case (MAP_COVER) and centred, so
       one set of tiles covers every viewport without a refetch on resize. */
    left: 50%; width: 768px; margin-left: -384px;
  }
  .ptile { position: absolute; width: 256px; height: 256px; user-select: none; }
  .ppin {
    position: absolute; left: 50%; top: 50%; width: 14px; height: 14px;
    margin: -7px 0 0 -7px; border-radius: 50%;
    background: var(--bad); border: 2px solid #fff;
    box-shadow: 0 1px 4px rgb(0 0 0 / .5); pointer-events: none;
  }
  .pattrib {
    position: absolute; right: 0; bottom: 0; z-index: 1;
    font-size: .65rem; color: var(--ink);
    background: rgb(255 255 255 / .75); padding: .1rem .3rem; border-top-left-radius: .3rem;
  }
  @media (prefers-color-scheme: dark) { .pattrib { background: rgb(0 0 0 / .6); } }

  .skel { height: .9rem; margin: .2rem 0; background: var(--rule-soft); border-radius: .2rem; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
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
      {/* No page title: the list is the page. The account button floats over
          it so nothing competes with the days for vertical space. */}
      <button type="button" id="account-open" class="iconbutton accountbutton" aria-label="Account and status" aria-haspopup="dialog">
        <span class="status-dot" id="account-dot"></span>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <circle cx="12" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.7" />
          <path d="M4.5 20c0-4.1 3.4-6.4 7.5-6.4s7.5 2.3 7.5 6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
      </button>
      <main id="app">
        <p class="empty">Loading…</p>
      </main>
      <noscript><p class="empty">The journal loads over a typed RPC and needs JavaScript.</p></noscript>

      {/* Account: navigation, pipeline health, and the live feed. */}
      <dialog id="account-modal" class="modal" aria-labelledby="account-title">
        <div class="modal-head">
          <h2 id="account-title">Account</h2>
          <button type="button" class="iconbutton" data-close-modal aria-label="Close">✕</button>
        </div>
        <div class="modal-body">
          <nav class="accountnav">
            <a href="#/search" data-close-modal>Search</a>
            <a href="#/places" data-close-modal>Places</a>
          </nav>
          <div class="status" id="pipeline-status">
            <p id="status-summary" class="status-line">Checking data flow…</p>
            <div id="status-details"></div>
          </div>
          <h3>Live events</h3>
          <ol id="live-event-list" class="live-list"><li class="empty">Waiting for events…</li></ol>
        </div>
      </dialog>

      {/* Day detail, opened by tapping a row. */}
      <dialog id="day-modal" class="modal" aria-labelledby="day-title">
        <div class="modal-head">
          <h2 id="day-title"></h2>
          <button type="button" class="iconbutton" data-close-modal aria-label="Close">✕</button>
        </div>
        <div class="modal-body" id="day-body"></div>
      </dialog>
    </Layout>
  )

export const dayPage = (journal: Journal) =>
  "<!doctype html>" + render(
    <Layout title={`Medina — ${dayId(journal.day)}`}>
      <header>
        <h1>{dayId(journal.day)}</h1>
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
    <Layout title={`Medina — ${dayId(day)}`}>
      <header>
        <h1>{dayId(day)}</h1>
        <p><a href="/">All days</a></p>
      </header>
      <main>
        <p class="empty">writing…</p>
      </main>
    </Layout>
  )
