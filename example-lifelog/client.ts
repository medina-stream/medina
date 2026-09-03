/**
 * Home-page SPA: fetches every journal over the typed RPC at POST /rpc and
 * renders it client-side. The RPC group is shared with the server, so a
 * shape change breaks this build instead of the page at runtime.
 *
 * Journal text is LLM output derived from untrusted transcripts: every
 * dynamic string goes through `escapeHtml` before it touches the DOM.
 */
import "./browser-prelude.ts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import { JournalsGroup } from "./JournalApi.ts"
import type { ApiError } from "./JournalApi.ts"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import type { Journal } from "./Resources.ts"

const RpcLive = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerJson)
)

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)

/** Plain-text report: blank lines separate paragraphs, single newlines break. */
const renderReport = (text: string) =>
  text.split(/\n\s*\n/).filter(Boolean).map((paragraph) =>
    `<p>${paragraph.split("\n").map((line) => escapeHtml(line)).join("<br>")}</p>`
  ).join("")

const renderList = (entries: ReadonlyArray<{ journal: Journal; stale: boolean }>) =>
  entries.length === 0
    ? `<p class="empty">No journal days yet.</p>`
    : entries.map(({ journal, stale }) => `
      <section>
        <h2><a href="#/day/${escapeHtml(journal.day)}">${escapeHtml(journal.day)}</a>${
          stale ? `<span class="stale">rewriting</span>` : ""
        }</h2>
        ${journal.report ? renderReport(journal.report) : `<p class="empty">Nothing recorded.</p>`}
      </section>`).join("")

const renderDay = (day: string, journal: Journal | null) =>
  `<p><a href="#/">All days</a></p>
   <h2>${escapeHtml(day)}</h2>` +
  (journal === null
    ? `<p class="empty">writing…</p>`
    : journal.report
      ? renderReport(journal.report)
      : `<p class="empty">Nothing recorded.</p>`)

const mount = document.getElementById("app")!

const failureMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message)
  return String(error)
}

const showError = (error: unknown) => {
  mount.innerHTML =
    `<p class="empty">Could not load the journal: ${escapeHtml(failureMessage(error))}</p>` +
    `<p><a href="${escapeHtml(location.hash || "#/")}">Retry</a></p>`
}

const isRpcFailure = (error: unknown): error is ApiError | RpcClientError => true

const program = Effect.gen(function*() {
  const client = yield* RpcClient.make(JournalsGroup)

  const loadRoute = (): Effect.Effect<void> =>
    Effect.gen(function*() {
      const hash = location.hash
      const day = hash.startsWith("#/day/") ? hash.slice("#/day/".length) : null
      if (day === null) {
        mount.innerHTML = renderList(yield* client.ListJournals({}))
        return
      }
      const journal = yield* client.GetJournal({ day })
      mount.innerHTML = renderDay(day, journal)
      if (journal === null) {
        const route = location.hash
        yield* Effect.sleep("10 seconds").pipe(
          Effect.flatMap(() => route === location.hash ? loadRoute() : Effect.void),
          Effect.forkDetach
        )
      }
    }).pipe(
      Effect.catchIf(isRpcFailure, (error) => Effect.sync(() => showError(error))),
      Effect.catchCause((cause) => Effect.sync(() => showError(cause)))
    )

  yield* loadRoute()
  window.addEventListener("hashchange", () => {
    Effect.runFork(loadRoute())
  })
  // Keep this scope — and the RPC client living in it — open for the life of
  // the page. Route loads fork into it; closing it would strand them.
  yield* Effect.never
})

Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(RpcLive)))).catch(showError)
