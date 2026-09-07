/**
 * Home-page SPA: a virtualized days table over the typed RPC at POST /rpc.
 * The RPC group is shared with the server, so a shape change breaks this
 * build instead of the page at runtime.
 *
 * Table rows arrive in `ListDays` pages — day, staleness, and a
 * truncated preview per row — appended as the scroll nears the bottom, so
 * the table scrolls endlessly with a constant-time initial load. In-flight
 * pages are cancelled on navigation. Row previews arrive truncated to one
 * line, keeping every cell a fixed height regardless of report length.
 *
 * Tapping a row opens the day in a modal and fetches the full journal via
 * `GetJournal`; the list stays mounted behind it, so closing costs nothing
 * and returns to the same scroll position. The modal is driven by the hash,
 * which is what makes back close it and a day link shareable.
 *
 * Journal text is LLM output derived from untrusted transcripts: every
 * dynamic string goes through `escapeHtml` before it touches the DOM.
 */
import "./browser-prelude.ts"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import { RuntimeEvent } from "../RuntimeEvents.ts"
import { audioLabel, dayId, parseDayId, relativeDay } from "./DayLabels.ts"
import { JournalsGroup } from "./JournalApi.ts"
import { Place } from "./Places.ts"
import { MAP_COVER, MAP_ZOOM, mapTiles, nudgeLatLon, TILE_SIZE } from "./Maps.ts"
import type { DayRow, PipelineStatus, SourceStatus, StageStatus } from "./JournalApi.ts"
import type { ApiError } from "./JournalApi.ts"
import type { PlaceCandidate } from "./Places.ts"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import type { Journal } from "./Resources.ts"

const RpcLive = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson)
)

/** Fixed row pitch in px; must match `.vrow` in Pages.tsx. */
const ROW_H = 100
/** Rows rendered past each edge of the viewport. */
const OVERSCAN = 6
/** Rows per ListDays page: constant-time initial load, endless scroll. */
const PAGE_SIZE = 40

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)

/** Summary line plus `##` time-chunk headers: blank lines separate blocks, single newlines break. */
const renderReport = (text: string) =>
  text.split(/\n\s*\n/).filter(Boolean).map((block) => {
    const [first, ...rest] = block.split("\n")
    if (first!.trim().startsWith("## ")) {
      const heading = `<h3>${escapeHtml(first!.trim().replace(/^##\s+/, ""))}</h3>`
      return heading + (rest.length > 0 ? `<p>${rest.map((line) => escapeHtml(line)).join("<br>")}</p>` : "")
    }
    return `<p>${block.split("\n").map((line) => escapeHtml(line)).join("<br>")}</p>`
  }).join("")

/** A day's report, for the day modal. The heading lives in the modal head. */
const renderDay = (journal: Journal | null) =>
  journal === null
    ? `<p class="empty">writing…</p>`
    : journal.report
    ? renderReport(journal.report)
    : `<p class="empty">Nothing recorded.</p>`

/** Today as a civil day in the viewer's zone. Read per paint rather than
 * cached: a page left open overnight should relabel itself. */
const todayDay = () => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Hash routes carry the day id (`#/day/020260907`), so a shared link reads
 * the same as the row it came from. `parseDayId` still accepts a civil day,
 * so links made before this change keep resolving.
 */
const dayRoute = (day: string) => `#/day/${dayId(day)}`

const routeDay = (hash: string): string | null =>
  hash.startsWith("#/day/") ? parseDayId(hash.slice("#/day/".length)) : null

const mount = document.getElementById("app")!

/**
 * Modal helpers over the native `dialog`, which brings focus trapping, Esc,
 * and inertness of the page behind it -- none of which is worth
 * reimplementing.
 *
 * `showModal` throws if the dialog is already open, so opening is guarded;
 * that happens when a row is tapped twice before the first paint lands.
 */
const openModal = (id: string) => {
  const dialog = document.getElementById(id) as HTMLDialogElement | null
  if (dialog && !dialog.open) dialog.showModal()
  return dialog
}

const closeModal = (id: string) => {
  const dialog = document.getElementById(id) as HTMLDialogElement | null
  if (dialog?.open) dialog.close()
}

/** Close buttons, and a click on the backdrop. */
const wireModals = () => {
  for (const el of Array.from(document.querySelectorAll("dialog.modal"))) {
    const dialog = el as HTMLDialogElement
    for (const button of Array.from(dialog.querySelectorAll("[data-close-modal]"))) {
      button.addEventListener("click", () => dialog.close())
    }
    // A click landing on the dialog itself (not its content) is the
    // backdrop, since the padding belongs to the inner elements.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close()
    })
  }
}

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

  // --- pipeline status --------------------------------------------------
  // Sources and stages are rendered from their own types: only a source can
  // be `disabled`, which is why the counts line is suppressed for exactly
  // that case and no other.
  const renderStatusRows = (entries: ReadonlyArray<SourceStatus | StageStatus>) =>
    entries.map((entry) => {
      const counts = entry.status === "disabled"
        ? ""
        : ` \u2014 ${entry.ingested} new, ${entry.cached} cached, ${entry.discovered} found`
      const message = entry.message ? `: ${entry.message}` : ""
      return `<li><strong>${escapeHtml(entry.name)}</strong>: ${escapeHtml(entry.status)}${
        escapeHtml(counts + message)
      }</li>`
    }).join("")

  const paintStatus = (status: PipelineStatus) => {
    const root = document.getElementById("pipeline-status")
    const summary = document.getElementById("status-summary")
    const details = document.getElementById("status-details")
    const dot = document.getElementById("account-dot")
    if (!root || !summary || !details) return
    const sources = status.lastRun?.sources ?? []
    const stages = status.lastRun?.stages ?? []
    const observed: ReadonlyArray<SourceStatus | StageStatus> = [...sources, ...stages]
    const failing = observed.filter((entry) => entry.status === "failing")
    const degraded = observed.filter((entry) => entry.status === "degraded")
    const disabled = sources.filter((source) => source.status === "disabled")
    const tone = failing.length > 0 || status.lastRun === null
      ? "bad"
      : degraded.length > 0 || disabled.length > 0 || status.totals.stale > 0
      ? "warn"
      : "good"
    root.className = `status ${tone}`
    // The dot is the only always-visible signal now that status lives in a
    // modal, so it carries the tone on the button itself.
    if (dot) dot.className = `status-dot ${tone}`
    summary.textContent = status.pipeline.running
      ? "Updating data\u2026"
      : status.lastRun === null
      ? "No pipeline run yet"
      : failing.length > 0
      ? `${failing.length} source${failing.length === 1 ? "" : "s"} failing`
      : degraded.length > 0
      ? "Data flow degraded"
      : disabled.length > 0
      ? `${disabled.length} source${disabled.length === 1 ? "" : "s"} disabled`
      : status.totals.stale > 0
      ? `${status.totals.stale} day${status.totals.stale === 1 ? "" : "s"} pending`
      : "Data flowing"
    const finished = status.pipeline.lastFinishedAt
      ? `<p>Last pass: ${escapeHtml(new Date(status.pipeline.lastFinishedAt).toLocaleString())}</p>`
      : `<p>No completed pass.</p>`
    const totals = `<p>${status.totals.days} days · ${status.totals.transcripts} transcripts · ` +
      `${status.totals.current} current, ${status.totals.stale} pending</p>`
    details.innerHTML = totals + finished +
      `<h3>Sources</h3><ul>${renderStatusRows(sources) || "<li>No sources configured.</li>"}</ul>` +
      `<h3>Processing</h3><ul>${renderStatusRows(stages) || "<li>No processing stages.</li>"}</ul>`
  }

  const refreshStatus = Effect.matchCause(client.GetStatus({}), {
    onSuccess: paintStatus,
    onFailure: (cause) => {
      const root = document.getElementById("pipeline-status")
      const summary = document.getElementById("status-summary")
      const details = document.getElementById("status-details")
      if (!root || !summary || !details) return
      root.className = "status bad"
      summary.textContent = "Status unavailable"
      details.textContent = failureMessage(Cause.squash(cause))
    }
  })

  // --- virtual days table -----------------------------------------------
  // `rows` grows in ListDays pages appended near the bottom, so the table
  // scrolls endlessly. Appends only (never prepends), so absolute offsets
  // of rendered rows stay valid as the list grows.
  let rows: Array<DayRow> = []
  let exhausted = false
  let generation = 0
  let pageFiber: Fiber.Fiber<any, any> | null = null
  let table: HTMLElement | null = null
  let spacer: HTMLElement | null = null
  let scrollQueued = false

  const cancelPage = () => {
    if (pageFiber !== null) {
      Effect.runFork(Fiber.interrupt(pageFiber))
      pageFiber = null
    }
    generation += 1
  }

  // --- places ---------------------------------------------------------
  // User-owned place list plus naming candidates, over the typed RPC.
  // Edits keep a working copy in `placeState`; every mutation saves the
  // whole list (the server replaces it outright) and repaints from local
  // state -- no re-fetch, so saves stay instant even though candidates are
  // expensive to compute. The next visit re-fetches and reconverges
  // coverage.
  //
  // `Place` and `PlaceCandidate` are the server's own schemas: the shapes
  // are not restated here, so a field change is a build error.
  let placeState: Array<Place> = []
  let candidateState: Array<PlaceCandidate> = []

  const placeIdFor = (name: string) =>
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "place"}-${Math.random().toString(36).slice(2, 8)}`

  /**
   * Save the whole place list. Refusals (not the owner, or no owner
   * configured) arrive as a typed `ApiError`, so the reason reaches the
   * user instead of a bare status code.
   */
  const savePlaces = (places: ReadonlyArray<Place>) =>
    Effect.matchCause(client.SavePlaces({ places }), {
      onSuccess: () => null,
      onFailure: (cause) => failureMessage(Cause.squash(cause))
    })

  const numField = (value: string): number | null => {
    const parsed = Number(value)
    return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null
  }

  /**
   * Current input values as a place list, or an error to show.
   *
   * Selects `[data-id]`, not every `.prow`: `mapBlock` reuses that class for
   * its address-search line, so a bare `.prow` sweep also picks up those
   * field-less rows and reports every save as "every place needs a name".
   */
  const collectPlaceInputs = (): { places: Array<Place> } | { error: string } => {
    const places: Array<Place> = []
    for (const row of Array.from(document.querySelectorAll("#place-list .prow[data-id]"))) {
      const id = row.getAttribute("data-id") ?? ""
      const value = (field: string) =>
        (row.querySelector(`input[data-field="${field}"]`) as HTMLInputElement | null)?.value ?? ""
      const lat = numField(value("lat"))
      const lon = numField(value("lon"))
      const radiusMeters = numField(value("radiusMeters"))
      const name = value("name").trim()
      if (!name) return { error: "every place needs a name" }
      if (lat === null || lon === null || radiusMeters === null) {
        return { error: `“${name}” needs numeric latitude, longitude, and radius` }
      }
      places.push(new Place({ id, name, lat, lon, radiusMeters }))
    }
    return { places }
  }

  /**
   * A tile-grid map plus address search for one pin. Lat/lon live in
   * `${prefix}-lat` / `${prefix}-lon` inputs; the map centers on them and a
   * tap writes a nudged pin back.
   *
   * The pin is a CSS marker at the viewport center rather than something
   * baked into an image, so moving it is a repaint of one element instead
   * of a network round trip.
   *
   * Tiles are generated for the widest layout the map can reach (the body's
   * max width) and centred by CSS, so one grid covers every viewport and a
   * resize needs no refetch. Overhang is clipped by the map box.
   */
  const mapTilesHtml = (lat: number, lon: number) =>
    mapTiles(lat, lon, MAP_ZOOM, MAP_COVER).map((tile) =>
      `<img class="ptile" src="${escapeHtml(tile.url)}" width="${TILE_SIZE}" height="${TILE_SIZE}" ` +
      `loading="lazy" alt="" draggable="false" ` +
      `style="left:${tile.left}px;top:${tile.top}px">`
    ).join("")

  const mapBlock = (prefix: string, lat: number, lon: number): string =>
    `<div class="pmap" data-prefix="${prefix}" role="button" tabindex="0" ` +
    `aria-label="Map — tap to move the pin">` +
    `<div class="ptiles">${mapTilesHtml(lat, lon)}</div>` +
    `<div class="ppin" aria-hidden="true"></div>` +
    `<a class="pattrib" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>` +
    `</div>` +
    `<div class="paddr">` +
    `<input id="${prefix}-addr" placeholder="Search address" aria-label="Search address">` +
    `<button type="button" data-addr="${prefix}">Search</button>` +
    `</div><div id="${prefix}-results"></div>`

  const mapCenter = (prefix: string): { lat: number; lon: number } | null => {
    const lat = numField((document.getElementById(`${prefix}-lat`) as HTMLInputElement | null)?.value ?? "")
    const lon = numField((document.getElementById(`${prefix}-lon`) as HTMLInputElement | null)?.value ?? "")
    return lat === null || lon === null ? null : { lat, lon }
  }

  const refreshMap = (prefix: string) => {
    const center = mapCenter(prefix)
    const tiles = document.querySelector(`.pmap[data-prefix="${prefix}"] .ptiles`)
    if (center && tiles) tiles.innerHTML = mapTilesHtml(center.lat, center.lon)
  }

  const wireMaps = () => {
    for (const el of Array.from(document.querySelectorAll(".pmap"))) {
      const map = el as HTMLElement
      const prefix = map.getAttribute("data-prefix") ?? ""
      const movePin = (clientX: number, clientY: number) => {
        const center = mapCenter(prefix)
        if (!center) return
        const rect = map.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return
        // The tile layer is not scaled, so viewport pixels are map pixels.
        const dx = clientX - rect.left - rect.width / 2
        const dy = clientY - rect.top - rect.height / 2
        const next = nudgeLatLon(center.lat, center.lon, MAP_ZOOM, dx, dy)
        ;(document.getElementById(`${prefix}-lat`) as HTMLInputElement | null)!.value =
          String(Math.round(next.lat * 1e6) / 1e6)
        ;(document.getElementById(`${prefix}-lon`) as HTMLInputElement | null)!.value =
          String(Math.round(next.lon * 1e6) / 1e6)
        refreshMap(prefix)
      }
      map.addEventListener("click", (event) => movePin(event.clientX, event.clientY))
      // Keyboard nudge, so the pin is reachable without a pointer.
      map.addEventListener("keydown", (event) => {
        const step = event.shiftKey ? 40 : 8
        const rect = map.getBoundingClientRect()
        const midX = rect.left + rect.width / 2
        const midY = rect.top + rect.height / 2
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step]
        }
        const move = moves[event.key]
        if (!move) return
        event.preventDefault()
        movePin(midX + move[0], midY + move[1])
      })
    }
    for (const el of Array.from(document.querySelectorAll("button[data-addr]"))) {
      const button = el as HTMLButtonElement
      button.addEventListener("click", () => {
        const prefix = button.getAttribute("data-addr") ?? ""
        const box = document.getElementById(`${prefix}-results`)
        const q = (document.getElementById(`${prefix}-addr`) as HTMLInputElement | null)?.value.trim() ?? ""
        if (!q || !box) return
        box.innerHTML = `<p class="empty">Searching…</p>`
        Effect.runFork(Effect.matchCause(client.SearchAddress({ query: q }), {
          onSuccess: (results) => {
            if (results.length === 0) {
              box.innerHTML = `<p class="empty">No matches.</p>`
              return
            }
            box.innerHTML = results.map((result, index) =>
              `<p><button type="button" data-pick="${prefix}:${index}">${escapeHtml(result.name)}</button></p>`
            ).join("")
            for (const pickEl of Array.from(box.querySelectorAll("button[data-pick]"))) {
              const pick = pickEl as HTMLButtonElement
              pick.addEventListener("click", () => {
                const chosen = results[Number((pick.getAttribute("data-pick") ?? ":").split(":")[1] ?? "-1")]
                if (!chosen) return
                ;(document.getElementById(`${prefix}-lat`) as HTMLInputElement | null)!.value = String(chosen.lat)
                ;(document.getElementById(`${prefix}-lon`) as HTMLInputElement | null)!.value = String(chosen.lon)
                box.innerHTML = ""
                refreshMap(prefix)
              })
            }
          },
          onFailure: (cause) => {
            box.innerHTML = `<p class="empty">${escapeHtml(failureMessage(Cause.squash(cause)))}</p>`
          }
        }))
      })
    }
  }

  const paintPlaces = (status: string) => {
    const placeRows = placeState.map((place, index) => {
      const prefix = `pl-${index}`
      return `<div class="pplace">` +
      `<div class="prow" data-id="${escapeHtml(place.id)}">` +
      `<label class="pfield pfield-name"><span>Name</span>` +
      `<input data-field="name" value="${escapeHtml(place.name)}" placeholder="Name"></label>` +
      `<label class="pfield"><span>Latitude</span>` +
      `<input inputmode="decimal" id="${prefix}-lat" data-field="lat" value="${place.lat}"></label>` +
      `<label class="pfield"><span>Longitude</span>` +
      `<input inputmode="decimal" id="${prefix}-lon" data-field="lon" value="${place.lon}"></label>` +
      `<label class="pfield pfield-narrow"><span>Radius m</span>` +
      `<input inputmode="numeric" data-field="radiusMeters" value="${place.radiusMeters}"></label>` +
      `<button type="button" class="danger" data-delete="${escapeHtml(place.id)}">Delete</button>` +
      `</div>` + mapBlock(prefix, place.lat, place.lon) + `</div>`
    }).join("")
    const candRows = candidateState.length === 0
      ? `<p class="empty">No unnamed stays — everything is covered.</p>`
      : candidateState.map((candidate, index) => {
        const prefix = `cand-${index}`
        const days = candidate.days.length > 3
          ? `${candidate.days.slice(0, 3).map((day) => escapeHtml(day)).join(", ")} +${candidate.days.length - 3} more`
          : candidate.days.map((day) => escapeHtml(day)).join(", ")
        return `<div class="pcand">` +
        `<div class="pcand-head"><strong>${escapeHtml(candidate.geocodedName ?? "Unnamed stay")}</strong>` +
        `<span class="pcand-meta">${candidate.dwellMinutes} min · ${days}</span></div>` +
        mapBlock(prefix, candidate.lat, candidate.lon) +
        `<div class="prow">` +
        `<label class="pfield pfield-name"><span>Name</span>` +
        `<input id="cand-name-${index}" value="${escapeHtml(candidate.geocodedName ?? "")}" placeholder="Name"></label>` +
        `<label class="pfield"><span>Latitude</span>` +
        `<input inputmode="decimal" id="${prefix}-lat" value="${candidate.lat}"></label>` +
        `<label class="pfield"><span>Longitude</span>` +
        `<input inputmode="decimal" id="${prefix}-lon" value="${candidate.lon}"></label>` +
        `<label class="pfield pfield-narrow"><span>Radius m</span>` +
        `<input inputmode="numeric" id="cand-radius-${index}" value="150"></label>` +
        `<button type="button" data-add="${index}">Name this place</button>` +
        `</div></div>`
      }).join("")
    mount.innerHTML =
      `<h2>Places</h2>` +
      `<p class="empty">A stay keeps the place name when it falls inside its radius. ` +
      `Name candidates below to grow the list; saving replaces the whole list.</p>` +
      `<div id="place-list">${placeRows || `<p class="empty">No places yet.</p>`}</div>` +
      `<div class="psave"><button type="button" id="places-save">Save all</button>` +
      `<span id="place-status" role="status">${escapeHtml(status)}</span></div>` +
      `<h2>Suggested</h2><div id="cand-list">${candRows}</div>`
    document.getElementById("places-save")!.addEventListener("click", () => {
      const collected = collectPlaceInputs()
      if ("error" in collected) {
        document.getElementById("place-status")!.textContent = collected.error
        return
      }
      Effect.runFork(Effect.map(savePlaces(collected.places), (error) => {
        if (error) {
          document.getElementById("place-status")!.textContent = error
          return
        }
        placeState = collected.places
        paintPlaces(`Saved ${collected.places.length} places.`)
      }))
    })
    for (const button of Array.from(document.querySelectorAll("button[data-delete]"))) {
      button.addEventListener("click", () => {
        const id = button.getAttribute("data-delete") ?? ""
        const name = placeState.find((place) => place.id === id)?.name ?? "this place"
        if (!confirm(`Delete “${name}”?`)) return
        const remaining = placeState.filter((place) => place.id !== id)
        Effect.runFork(Effect.map(savePlaces(remaining), (error) => {
          if (error) {
            document.getElementById("place-status")!.textContent = error
            return
          }
          placeState = remaining
          paintPlaces("Deleted.")
        }))
      })
    }
    wireMaps()
    for (const button of Array.from(document.querySelectorAll("button[data-add]"))) {
      button.addEventListener("click", () => {
        const index = Number(button.getAttribute("data-add") ?? "-1")
        const candidate = candidateState[index]
        if (!candidate) return
        const prefix = `cand-${index}`
        const name = (document.getElementById(`cand-name-${index}`) as HTMLInputElement | null)?.value.trim() ?? ""
        const radiusMeters = numField((document.getElementById(`cand-radius-${index}`) as HTMLInputElement | null)?.value ?? "")
        const center = mapCenter(prefix)
        if (!name || radiusMeters === null || !center) {
          document.getElementById("place-status")!.textContent = "a name, numeric radius, and pin location are required"
          return
        }
        const named = new Place({
          id: placeIdFor(name),
          name,
          lat: center.lat,
          lon: center.lon,
          radiusMeters
        })
        Effect.runFork(Effect.map(savePlaces([...placeState, named]), (error) => {
          if (error) {
            document.getElementById("place-status")!.textContent = error
            return
          }
          placeState = [...placeState, named]
          candidateState = candidateState.filter((_, candidateIndex) => candidateIndex !== index)
          paintPlaces(`Named “${name}”.`)
        }))
      })
    }
  }

  /** Both place reads in one round of concurrency: candidates are the slow
   * one, and the editor needs both before it can paint. */
  const refreshPlaces = (status: string) =>
    Effect.map(
      Effect.all([client.ListPlaces({}), client.ListPlaceCandidates({})], { concurrency: 2 }),
      ([places, candidates]) => {
        placeState = [...places]
        candidateState = [...candidates]
        paintPlaces(status)
      }
    )

  const showPlaces = Effect.suspend(() => {
    cancelPage()
    table = null
    spacer = null
    mount.innerHTML = `<h2>Places</h2><p class="empty">Loading…</p>`
    return Effect.catchCause(refreshPlaces(""), (cause) =>
      Effect.sync(() => {
        mount.innerHTML = `<h2>Places</h2>` +
          `<p class="empty">Could not load places: ${escapeHtml(failureMessage(Cause.squash(cause)))}</p>`
      }))
  })

  const rowHtml = (row: DayRow): string => {
    const audio = audioLabel(row.audioSeconds)
    return `<span class="vrow-title">` +
      `<span class="vrow-day">${escapeHtml(dayId(row.day))}</span>` +
      `<span class="vrow-rel">${escapeHtml(relativeDay(row.day, todayDay()))}</span>` +
      (row.stale ? `<span class="stale">rewriting</span>` : "") +
      (audio ? `<span class="vrow-audio" title="Recorded audio">${escapeHtml(audio)}</span>` : "") +
      `</span>` +
      (row.preview
        ? `<p class="preview">${escapeHtml(row.preview)}</p>`
        : `<p class="empty">Nothing recorded.</p>`)
  }

  /** The spacer height follows the loaded rows. */
  const refreshChrome = () => {
    if (spacer !== null) spacer.style.height = `${rows.length * ROW_H}px`
  }

  /** Append the next page, unless one is already in flight. Failures clear
   * the in-flight flag without touching rows, so the next paint retries. */
  const loadPage = () => {
    if (pageFiber !== null || exhausted) return
    const gen = generation
    const offset = rows.length
    const page = Effect.matchCauseEffect(client.ListDays({ limit: PAGE_SIZE, offset }), {
      onFailure: () => Effect.succeed(null),
      onSuccess: (days) => Effect.succeed(days)
    }).pipe(
      Effect.flatMap((days) =>
        Effect.sync(() => {
          pageFiber = null
          if (gen !== generation) return
          if (days === null) {
            if (rows.length === 0) showError(new Error("Could not load the journal."))
            return
          }
          rows.push(...days)
          if (days.length < PAGE_SIZE) exhausted = true
          if (rows.length === 0) {
            mount.innerHTML = `<p class="empty">No journal days yet.</p>`
            table = null
            spacer = null
            return
          }
          refreshChrome()
          paintWindow()
        })
      ),
      Effect.catchCause(() => Effect.sync(() => {
        pageFiber = null
      }))
    )
    pageFiber = Effect.runFork(page)
  }

  const paintWindow = () => {
    if (table === null || spacer === null || rows.length === 0) return
    const start = Math.max(0, Math.floor(table.scrollTop / ROW_H) - OVERSCAN)
    const end = Math.min(
      rows.length,
      Math.ceil((table.scrollTop + table.clientHeight) / ROW_H) + OVERSCAN
    )
    let html = ""
    for (let index = start; index < end; index++) {
      const row = rows[index]!
      html += `<div class="vrow" style="top:${index * ROW_H}px" data-day="${escapeHtml(row.day)}">` +
        `<button type="button" class="vrow-inner" data-open-day="${escapeHtml(row.day)}">${rowHtml(row)}</button></div>`
    }
    spacer.innerHTML = html
    // Near the loaded tail with more possibly behind: fetch the next page.
    if (!exhausted && end > rows.length - PAGE_SIZE) loadPage()
  }

  const onScroll = () => {
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      scrollQueued = false
      paintWindow()
    })
  }

  // --- live updates ---------------------------------------------------
  // The server broadcasts day strings over SSE when journals land; all
  // data still arrives through the RPC. A table event re-fetches just the
  // affected page; a detail event reloads the day (turning "writing…"
  // into content the moment it materializes).
  const refetchPage = (index: number) => {
    const gen = generation
    const offset = Math.floor(index / PAGE_SIZE) * PAGE_SIZE
    const refetch = Effect.matchCauseEffect(client.ListDays({ limit: PAGE_SIZE, offset }), {
      onFailure: () => Effect.succeed(null),
      onSuccess: (days) => Effect.succeed(days)
    }).pipe(
      Effect.flatMap((days) =>
        Effect.sync(() => {
          if (gen !== generation || days === null) return
          rows.splice(offset, days.length, ...days)
          if (days.length < PAGE_SIZE) exhausted = true
          refreshChrome()
          paintWindow()
        })
      ),
      Effect.catchCause(() => Effect.void)
    )
    Effect.runFork(refetch)
  }

  const handleDayEvent = (day: string) => {
    const hash = location.hash
    const viewing = routeDay(hash)
    if (viewing !== null) {
      if (viewing === day) Effect.runFork(loadRoute())
      return
    }
    // Untouched while a scroll or seek owns the wire; the next paint or
    // event covers the row.
    if (table === null || pageFiber !== null) return
    const index = rows.findIndex((row) => row.day === day)
    if (index !== -1) refetchPage(index)
  }

  let liveSeenError = false

  /**
   * One line in the live feed. `event` is a decoded `RuntimeEvent`, so the
   * fields are known to exist and known to be strings -- no duck-typing.
   */
  const showLiveEvent = (event: RuntimeEvent) => {
    const list = document.getElementById("live-event-list")
    if (list === null) return
    if (list.children.length === 1 && list.firstElementChild?.classList.contains("empty")) {
      list.innerHTML = ""
    }
    const item = document.createElement("li")
    if (event.status === "failing" || event.status === "degraded") item.className = "event-failing"
    const time = Number.isNaN(Date.parse(event.at))
      ? "now"
      : new Date(event.at).toLocaleTimeString()
    item.innerHTML = `<span class="event-time">${escapeHtml(time)}</span>${escapeHtml(event.message)}`
    list.append(item)
    while (list.children.length > 100) list.firstElementChild?.remove()
    list.scrollTop = list.scrollHeight
  }

  /**
   * Live pipeline progress over the RPC stream.
   *
   * Retried forever with a backoff: a dropped stream is normal (server
   * restart, sleep, flaky network), and each reconnect reloads the current
   * view because events may have been missed while away. `Stream.runForEach`
   * only returns when the stream ends, so the reload belongs on the retry
   * path, not in a separate open handler.
   */
  const subscribeLive = Effect.forkScoped(
    Stream.runForEach(client.StreamEvents({}), (event) =>
      Effect.sync(() => {
        showLiveEvent(event)
        if (event.day !== null) handleDayEvent(event.day)
      })).pipe(
        Effect.andThen(Effect.fail(new Error("event stream ended"))),
        Effect.tapCause(() => Effect.sync(() => { liveSeenError = true })),
        Effect.retry({
          // Exponential backoff, capped: `min` takes the shorter of the two
          // delays, so waits grow to 10s and stay there rather than
          // doubling forever.
          schedule: Schedule.min([Schedule.exponential(500, 2), Schedule.spaced(10_000)])
        }),
        Effect.andThen(Effect.sync(() => {
          if (liveSeenError) {
            liveSeenError = false
            Effect.runFork(loadRoute())
          }
        }))
      )
  )

  const showTable = () => {
    cancelPage()
    rows = []
    exhausted = false
    mount.innerHTML =
      `<div class="vtable" id="vtable" tabindex="0">` +
      `<div class="vspacer" id="vspacer"></div>` +
      `</div>` +
      `<noscript><p class="empty">The journal loads over a typed RPC and needs JavaScript.</p></noscript>`
    table = document.getElementById("vtable")!
    spacer = document.getElementById("vspacer")!
    // Delegated: rows are recycled on every scroll paint, so per-row
    // listeners would be re-attached constantly.
    spacer.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest("[data-open-day]")
      const day = target?.getAttribute("data-open-day")
      if (day) location.hash = dayRoute(day)
    })
    table.addEventListener("scroll", onScroll, { passive: true })
    loadPage()
  }

  /**
   * Show a day in the modal, over whatever is behind it.
   *
   * The list stays mounted, so closing returns to the same scroll position
   * without refetching. Closing rewrites the hash, which is what makes the
   * back button close the modal rather than leave the page.
   */
  const showDay = (day: string): Effect.Effect<void, ApiError | RpcClientError> =>
    Effect.gen(function*() {
      if (table === null) showTable()
      const dialog = openModal("day-modal")
      const title = document.getElementById("day-title")
      const body = document.getElementById("day-body")
      if (!dialog || !title || !body) return
      title.textContent = dayId(day)
      body.innerHTML = `<p class="empty">Loading…</p>`
      if (!dialog.dataset.wired) {
        dialog.dataset.wired = "1"
        dialog.addEventListener("close", () => {
          if (routeDay(location.hash) !== null) location.hash = "#/"
        })
      }
      const journal = yield* client.GetJournal({ day })
      // A late response for a day the user already navigated away from
      // must not overwrite what they are looking at now.
      if (routeDay(location.hash) !== day) return
      body.innerHTML = renderDay(journal)
      if (journal === null) {
        const route = location.hash
        yield* Effect.sleep("10 seconds").pipe(
          Effect.flatMap(() => route === location.hash ? showDay(day) : Effect.void),
          Effect.forkDetach
        )
      }
    })

  const loadRoute = (): Effect.Effect<void> =>
    Effect.gen(function*() {
      const hash = location.hash
      if (hash === "#/places") {
        closeModal("day-modal")
        yield* showPlaces
        return
      }
      const day = routeDay(hash)
      if (day === null) {
        closeModal("day-modal")
        if (table === null) showTable()
        return
      }
      yield* showDay(day)
    }).pipe(
      Effect.catchIf(isRpcFailure, (error) => Effect.sync(() => showError(error))),
      Effect.catchCause((cause) => Effect.sync(() => showError(cause)))
    )

  wireModals()
  document.getElementById("account-open")?.addEventListener("click", () => {
    openModal("account-modal")
    // Refresh on open: the 30s poll may have left it a little stale.
    Effect.runFork(refreshStatus)
  })

  // Registered before the first route load, which awaits an RPC: a row
  // tapped during that window sets the hash, and if nothing were listening
  // yet the modal would only appear on a later reload.
  window.addEventListener("hashchange", () => {
    Effect.runFork(loadRoute())
  })

  yield* loadRoute()
  yield* refreshStatus
  window.setInterval(() => Effect.runFork(refreshStatus), 30_000)
  yield* subscribeLive
  // Keep this scope — and the RPC client living in it — open for the life of
  // the page. Route loads fork into it; closing it would strand them.
  yield* Effect.never
})

Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(RpcLive)))).catch(showError)
