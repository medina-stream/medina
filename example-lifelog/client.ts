/**
 * Home-page SPA: a virtualized days table over the typed RPC at POST /rpc.
 * The RPC group is shared with the server, so a shape change breaks this
 * build instead of the page at runtime.
 *
 * Table rows arrive in `ListDays` pages — day, staleness, and a
 * truncated preview per row — appended as the scroll nears the bottom, so
 * the table scrolls endlessly with a constant-time initial load. In-flight
 * pages are cancelled on jump or navigation. Only the day detail view
 * fetches a full journal via `GetJournal`. Row previews arrive truncated
 * to one line, keeping every cell a fixed height regardless of report
 * length.
 *
 * Journal text is LLM output derived from untrusted transcripts: every
 * dynamic string goes through `escapeHtml` before it touches the DOM.
 */
import "./browser-prelude.ts"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import { JournalsGroup } from "./JournalApi.ts"
import { MAP_H, MAP_W, MAP_ZOOM, nudgeLatLon, staticMapUrl } from "./Maps.ts"
import type { DayRow } from "./JournalApi.ts"
import type { ApiError } from "./JournalApi.ts"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import type { Journal } from "./Resources.ts"

const RpcLive = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerJson)
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
  // User-owned place list plus naming candidates, over the REST endpoints.
  // Edits keep a working copy in `placeState`; every mutation PUTs the whole
  // list (the server replaces it outright) and repaints from local state —
  // no re-fetch, so saves stay instant even though candidates are expensive
  // to compute. The next visit re-fetches and reconverges coverage.
  interface PlaceRow { id: string; name: string; lat: number; lon: number; radiusMeters: number }
  interface PlaceCandidateRow { lat: number; lon: number; geocodedName: string | null; dwellMinutes: number; days: Array<string> }

  let placeState: Array<PlaceRow> = []
  let candidateState: Array<PlaceCandidateRow> = []

  const placeIdFor = (name: string) =>
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "place"}-${Math.random().toString(36).slice(2, 8)}`

  const getJson = async (url: string): Promise<any> => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url}: ${response.status}`)
    return response.json()
  }

  const putPlaces = async (places: Array<PlaceRow>): Promise<void> => {
    const response = await fetch("/places", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(places)
    })
    if (!response.ok) throw new Error(`save failed (${response.status}): ${await response.text()}`)
  }

  const numField = (value: string): number | null => {
    const parsed = Number(value)
    return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null
  }

  /** Current input values as a place list, or an error to show. */
  const collectPlaceInputs = (): { places: Array<PlaceRow> } | { error: string } => {
    const places: Array<PlaceRow> = []
    for (const row of Array.from(document.querySelectorAll("#place-list .prow"))) {
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
      places.push({ id, name, lat, lon, radiusMeters })
    }
    return { places }
  }

  /** Thumbnail plus address search for one pin. Lat/lon live in
   * `${prefix}-lat` / `${prefix}-lon` inputs; the map centers on them and a
   * click writes a nudged pin back. */
  const mapBlock = (prefix: string, lat: number, lon: number): string =>
    `<img class="pmap" data-prefix="${prefix}" src="${escapeHtml(staticMapUrl(lat, lon))}" ` +
    `width="${MAP_W}" height="${MAP_H}" loading="lazy" alt="Map — click to move the pin" ` +
    `style="max-width:100%;cursor:crosshair">` +
    `<div class="prow">` +
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
    const img = document.querySelector(`img.pmap[data-prefix="${prefix}"]`) as HTMLImageElement | null
    if (center && img) img.src = staticMapUrl(center.lat, center.lon)
  }

  const wireMaps = () => {
    for (const el of Array.from(document.querySelectorAll("img.pmap"))) {
      const img = el as HTMLImageElement
      const prefix = img.getAttribute("data-prefix") ?? ""
      img.addEventListener("click", (event) => {
        const center = mapCenter(prefix)
        if (!center) return
        const rect = img.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return
        const dx = (event.clientX - rect.left) * (MAP_W / rect.width) - MAP_W / 2
        const dy = (event.clientY - rect.top) * (MAP_H / rect.height) - MAP_H / 2
        const next = nudgeLatLon(center.lat, center.lon, MAP_ZOOM, dx, dy)
        ;(document.getElementById(`${prefix}-lat`) as HTMLInputElement | null)!.value =
          String(Math.round(next.lat * 1e6) / 1e6)
        ;(document.getElementById(`${prefix}-lon`) as HTMLInputElement | null)!.value =
          String(Math.round(next.lon * 1e6) / 1e6)
        refreshMap(prefix)
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
        void (async () => {
          try {
            const data = await getJson(`/places/geocode?q=${encodeURIComponent(q)}`)
            const results: Array<any> = Array.isArray(data.results) ? data.results : []
            if (results.length === 0) {
              box.innerHTML = `<p class="empty">No matches.</p>`
              return
            }
            box.innerHTML = results.map((result, index) =>
              `<p><button type="button" data-pick="${prefix}:${index}">${escapeHtml(String(result.name ?? "match"))}</button></p>`
            ).join("")
            for (const pickEl of Array.from(box.querySelectorAll("button[data-pick]"))) {
              const pick = pickEl as HTMLButtonElement
              pick.addEventListener("click", () => {
                const chosen = results[Number((pick.getAttribute("data-pick") ?? ":").split(":")[1] ?? "-1")]
                const lat = Number(chosen?.lat)
                const lon = Number(chosen?.lon)
                if (!chosen || !Number.isFinite(lat) || !Number.isFinite(lon)) return
                ;(document.getElementById(`${prefix}-lat`) as HTMLInputElement | null)!.value = String(lat)
                ;(document.getElementById(`${prefix}-lon`) as HTMLInputElement | null)!.value = String(lon)
                box.innerHTML = ""
                refreshMap(prefix)
              })
            }
          } catch (error) {
            box.innerHTML = `<p class="empty">${escapeHtml(failureMessage(error))}</p>`
          }
        })()
      })
    }
  }

  const paintPlaces = (status: string) => {
    const placeRows = placeState.map((place, index) => {
      const prefix = `pl-${index}`
      return `<div class="pplace">` +
      `<div class="prow" data-id="${escapeHtml(place.id)}">` +
      `<input data-field="name" value="${escapeHtml(place.name)}" placeholder="Name" aria-label="Name">` +
      `<input class="num" id="${prefix}-lat" data-field="lat" value="${place.lat}" placeholder="Lat" aria-label="Latitude">` +
      `<input class="num" id="${prefix}-lon" data-field="lon" value="${place.lon}" placeholder="Lon" aria-label="Longitude">` +
      `<input class="num" data-field="radiusMeters" value="${place.radiusMeters}" placeholder="Radius m" aria-label="Radius in meters">` +
      `<button type="button" data-delete="${escapeHtml(place.id)}">Delete</button>` +
      `</div>` + mapBlock(prefix, place.lat, place.lon) + `</div>`
    }).join("")
    const candRows = candidateState.length === 0
      ? `<p class="empty">No unnamed stays — everything is covered.</p>`
      : candidateState.map((candidate, index) => {
        const prefix = `cand-${index}`
        return `<div class="pcand">` +
        `<div><strong>${escapeHtml(candidate.geocodedName ?? "Unnamed stay")}</strong> — ` +
        `${candidate.dwellMinutes} min, ${candidate.days.map((day) => escapeHtml(day)).join(", ")}</div>` +
        mapBlock(prefix, candidate.lat, candidate.lon) +
        `<div class="prow">` +
        `<input id="cand-name-${index}" value="${escapeHtml(candidate.geocodedName ?? "")}" placeholder="Name" aria-label="Name">` +
        `<input class="num" id="${prefix}-lat" value="${candidate.lat}" placeholder="Lat" aria-label="Latitude">` +
        `<input class="num" id="${prefix}-lon" value="${candidate.lon}" placeholder="Lon" aria-label="Longitude">` +
        `<input class="num" id="cand-radius-${index}" value="150" placeholder="Radius m" aria-label="Radius in meters">` +
        `<button type="button" data-add="${index}">Name this place</button>` +
        `</div></div>`
      }).join("")
    mount.innerHTML =
      `<p><a href="#/">All days</a></p><h2>Places</h2>` +
      `<p class="empty">A stay keeps the place name when it falls inside its radius. ` +
      `Name candidates below to grow the list; saving replaces the whole list.</p>` +
      `<div id="place-list">${placeRows || `<p class="empty">No places yet.</p>`}</div>` +
      `<p><button type="button" id="places-save">Save all</button> <span id="place-status">${escapeHtml(status)}</span></p>` +
      `<h2>Suggested</h2><div id="cand-list">${candRows}</div>`
    document.getElementById("places-save")!.addEventListener("click", () => {
      void (async () => {
        const collected = collectPlaceInputs()
        if ("error" in collected) {
          document.getElementById("place-status")!.textContent = collected.error
          return
        }
        try {
          await putPlaces(collected.places)
          placeState = collected.places
          paintPlaces(`Saved ${collected.places.length} places.`)
        } catch (error) {
          document.getElementById("place-status")!.textContent = failureMessage(error)
        }
      })()
    })
    for (const button of Array.from(document.querySelectorAll("button[data-delete]"))) {
      button.addEventListener("click", () => {
        const id = button.getAttribute("data-delete") ?? ""
        const name = placeState.find((place) => place.id === id)?.name ?? "this place"
        if (!confirm(`Delete “${name}”?`)) return
        void (async () => {
          try {
            await putPlaces(placeState.filter((place) => place.id !== id))
            placeState = placeState.filter((place) => place.id !== id)
            paintPlaces("Deleted.")
          } catch (error) {
            document.getElementById("place-status")!.textContent = failureMessage(error)
          }
        })()
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
        void (async () => {
          try {
            const named: PlaceRow = {
              id: placeIdFor(name), name,
              lat: center.lat, lon: center.lon, radiusMeters
            }
            await putPlaces([...placeState, named])
            placeState = [...placeState, named]
            candidateState = candidateState.filter((_, candidateIndex) => candidateIndex !== index)
            paintPlaces(`Named “${name}”.`)
          } catch (error) {
            document.getElementById("place-status")!.textContent = failureMessage(error)
          }
        })()
      })
    }
  }

  const refreshPlaces = async (status: string): Promise<void> => {
    const [placesData, candData] = await Promise.all([getJson("/places"), getJson("/places/candidates")])
    if (!Array.isArray(placesData.places) || !Array.isArray(candData.candidates)) {
      throw new Error("bad response from /places")
    }
    placeState = placesData.places
    candidateState = candData.candidates
    paintPlaces(status)
  }

  const showPlaces = async (): Promise<void> => {
    cancelPage()
    table = null
    spacer = null
    mount.innerHTML = `<p><a href="#/">All days</a></p><h2>Places</h2><p class="empty">Loading…</p>`
    try {
      await refreshPlaces("")
    } catch (error) {
      mount.innerHTML =
        `<p><a href="#/">All days</a></p><h2>Places</h2>` +
        `<p class="empty">Could not load places: ${escapeHtml(failureMessage(error))}</p>`
    }
  }

  const rowHtml = (row: DayRow): string => {
    const heading =
      `<h2><a href="#/day/${escapeHtml(row.day)}">${escapeHtml(row.day)}</a>` +
      (row.stale ? `<span class="stale">rewriting</span>` : "") + `</h2>`
    return heading +
      (row.preview
        ? `<p class="preview">${escapeHtml(row.preview)}</p>`
        : `<p class="empty">Nothing recorded.</p>`)
  }

  /** Header count + spacer height follow the loaded rows. */
  const refreshChrome = () => {
    const count = document.getElementById("daycount")
    if (count !== null) {
      count.textContent = exhausted ? `${rows.length} days` : `${rows.length}+ days`
    }
    if (spacer !== null) spacer.style.height = `${rows.length * ROW_H}px`
    const input = document.getElementById("jump") as HTMLInputElement | null
    if (input !== null && rows.length > 0) {
      input.max = rows[0]!.day
      if (exhausted) input.min = rows[rows.length - 1]!.day
    }
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
        `<div class="vrow-inner">${rowHtml(row)}</div></div>`
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

  const scrollToIndex = (index: number) => {
    if (table === null) return
    table.scrollTop = index * ROW_H
    paintWindow()
  }

  const jumpToDay = (value: string) => {
    if (table === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return
    // Rows are newest first: the target is the first row at or before it.
    // Loaded rows answer immediately; otherwise pages load (and paint)
    // until the target appears or the list ends. A new jump or navigation
    // cancels the seek via the generation guard.
    const gen = generation
    const step = (): void => {
      if (gen !== generation || table === null) return
      const index = rows.findIndex((row) => row.day <= value)
      if (index !== -1) {
        scrollToIndex(index)
        return
      }
      if (exhausted) {
        scrollToIndex(Math.max(0, rows.length - 1))
        return
      }
      if (pageFiber !== null) {
        requestAnimationFrame(step)
        return
      }
      const offset = rows.length
      const seek = Effect.matchCauseEffect(client.ListDays({ limit: PAGE_SIZE, offset }), {
        onFailure: () => Effect.succeed(null),
        onSuccess: (days) => Effect.succeed(days)
      }).pipe(
        Effect.flatMap((days) =>
          Effect.sync(() => {
            pageFiber = null
            if (gen !== generation) return
            if (days === null) return
            rows.push(...days)
            if (days.length < PAGE_SIZE) exhausted = true
            refreshChrome()
            paintWindow()
            step()
          })
        ),
        Effect.catchCause(() => Effect.sync(() => {
          pageFiber = null
        }))
      )
      pageFiber = Effect.runFork(seek)
    }
    step()
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
    const viewing = hash.startsWith("#/day/") ? hash.slice("#/day/".length) : null
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

  const subscribeLive = () => {
    const source = new EventSource("/events")
    source.onmessage = (event) => {
      try {
        const data: unknown = JSON.parse(event.data)
        if (typeof data === "object" && data !== null && "day" in data && typeof data.day === "string") {
          handleDayEvent(data.day)
        }
      } catch {
        // Malformed event: ignore, the next one resyncs.
      }
    }
    source.onerror = () => {
      liveSeenError = true
    }
    source.onopen = () => {
      // Reconnected after a drop: reload the current view outright, since
      // events may have been missed while away.
      if (liveSeenError) {
        liveSeenError = false
        Effect.runFork(loadRoute())
      }
    }
  }

  const showTable = () => {
    cancelPage()
    rows = []
    exhausted = false
    mount.innerHTML =
      `<div class="vtable-tools">` +
      `<span id="daycount">… days</span>` +
      `<label>Go to day <input id="jump" type="date"></label>` +
      `<button id="jump-go" type="button">Go</button>` +
      `<a href="#/places">Places</a>` +
      `</div>` +
      `<div class="vtable" id="vtable" tabindex="0">` +
      `<div class="vspacer" id="vspacer"></div>` +
      `</div>` +
      `<noscript><p class="empty">The journal loads over a typed RPC and needs JavaScript.</p></noscript>`
    table = document.getElementById("vtable")!
    spacer = document.getElementById("vspacer")!
    const input = document.getElementById("jump") as HTMLInputElement | null
    document.getElementById("jump-go")!.addEventListener("click", () => {
      if (input !== null) jumpToDay(input.value)
    })
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && input !== null) jumpToDay(input.value)
    })
    table.addEventListener("scroll", onScroll, { passive: true })
    loadPage()
  }

  const loadRoute = (): Effect.Effect<void> =>
    Effect.gen(function*() {
      const hash = location.hash
      if (hash === "#/places") {
        yield* Effect.promise(() => showPlaces())
        return
      }
      const day = hash.startsWith("#/day/") ? hash.slice("#/day/".length) : null
      if (day === null) {
        showTable()
        return
      }
      cancelPage()
      table = null
      spacer = null
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
  subscribeLive()
  // Keep this scope — and the RPC client living in it — open for the life of
  // the page. Route loads fork into it; closing it would strand them.
  yield* Effect.never
})

Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(RpcLive)))).catch(showError)
