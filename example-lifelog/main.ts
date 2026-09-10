/**
 * Medina, the Effect edition: a Bun process that hourly ingests the latest N
 * Drive files, transcribes new audio with AssemblyAI, journals each day with
 * an LLM, and serves the journal at GET /.
 */
import { BunHttpClient, BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type { WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine"
import { ClusterLive, WorkflowEngineLive } from "../lib/runtime/Cluster.ts"
import { JournalWorkflowLayer, NotesWorkflowLayer } from "./Lifelog.ts"
import * as Redacted from "effect/Redacted"
import * as Option from "effect/Option"
import * as FileSystem from "effect/FileSystem"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import { JournalsGroup } from "../lib/lifelog/JournalApi.ts"
import { parseDayId } from "../lib/lifelog/DayLabels.ts"
import { StartTimeRulesService } from "../lib/lifelog/StartTimeRules.ts"
import { StartTimeHintsLive } from "./StartTimeHints.ts"
import { liveEvents, makeJournalsHandlers } from "../lib/lifelog/JournalRpc.ts"
import * as DayEvents from "../lib/lifelog/DayEvents.ts"
import { TelemetryLive } from "../lib/runtime/Telemetry.ts"
import { refreshDayPreviews } from "../lib/lifelog/Views.ts"
import { Tailscale, layer as tailscaleLayer } from "../lib/Tailscale.ts"
import { gpsCompactSource, gpsDay, gpsInboxWrite, locationSummary, parseGpsBody } from "../lib/lifelog/Gps.ts"
import * as AssemblyAI from "../lib/AssemblyAI.ts"
import * as Bucket from "../lib/Bucket.ts"
import * as R2TempCreds from "../lib/R2TempCreds.ts"
import * as TransloaditNormalize from "../lib/capture/TransloaditNormalize.ts"
import * as Drive from "../lib/Drive.ts"
import * as Git from "../lib/Git.ts"
import { runPipeline } from "../lib/Pipeline.ts"
import type { PipelineSource } from "../lib/Pipeline.ts"
import type { Source } from "../lib/Resource.ts"
import { MedinaAuth, MEDINA_SCOPE } from "../lib/lifelog/Auth.ts"
import { DATA_DIR, dataPath } from "../lib/lifelog/Resources.ts"
import { dayPage, pendingPage, spaHome } from "../lib/lifelog/Pages.tsx"
import { archiveSweepSource, audioSource, driveAllowlistSource, driveInventorySource, mediaNormalizeSource, mediaTranscribeSource, recordingObjectSource, attributionResource, dayIndexResource, transcriptSearchResource, httpIngest, journalCachedForDay, journalResource, notesResource, notesSource, pipelineStatus, todayDay } from "./Lifelog.ts"
import { movementCachedForDay, movementResource } from "../lib/lifelog/Movement.ts"
import { staysDay, staysSource } from "../lib/lifelog/Stays.ts"

const auth = new MedinaAuth({ directory: dataPath("auth") })

const bearerToken = (headers: Readonly<Record<string, string | undefined>>) => {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(headers.authorization ?? "")
  return match?.[1] ?? null
}

const isLoopbackAddress = (address: string | null) =>
  address === "::1" || address?.startsWith("127.") || address === "::ffff:127.0.0.1"

/** The person allowed to approve or deny an agent delegation. */
const approvalOwner = () => (process.env.AUTH_OWNER ?? process.env.INGEST_OWNER ?? "").trim()

/**
 * A bearer is an approved `medina` delegation. Direct owner access remains
 * useful for the UI and emergency recovery; an exe.dev front door reaches us
 * from loopback, which is already inside this VM's trust boundary.
 */
const fullAccess = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const token = bearerToken(request.headers)
  if (token) {
    const delegated = auth.authorize(token)
    if (delegated) return { actor: `delegation:${delegated.clientName}`, delegated: true }
  }
  const address = Option.getOrNull(request.remoteAddress)
  if (isLoopbackAddress(address)) return { actor: "trusted-loopback", delegated: false }
  const owner = approvalOwner()
  const tailscale = yield* Tailscale
  const login = yield* tailscale.identify(address, request.headers)
  if (owner && login === owner) return { actor: login, delegated: false }
  return null
})

/**
 * Who may write: the single owner named by `INGEST_OWNER`.
 *
 * Writing is refused unless an owner is configured -- an unset
 * `INGEST_OWNER` is an unconfigured deployment, not an open one, and it
 * must not read as a server bug.
 *
 * Identity comes from Tailscale (see `lib/Tailscale.ts`). Read paths stay
 * open: this gates writes only.
 */
const writeAccess = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const delegatedToken = bearerToken(request.headers)
  if (delegatedToken) {
    const delegated = auth.authorize(delegatedToken)
    if (delegated) return { login: `delegation:${delegated.clientName}`, allowed: true, reason: "", status: 200 as const }
  }
  const owner = (Option.getOrNull(yield* Config.option(Config.string("INGEST_OWNER"))) ?? "").trim()
  if (!owner) {
    return {
      login: null,
      allowed: false,
      reason: "writes are disabled: set INGEST_OWNER to the Tailscale login allowed to write",
      status: 503 as const
    }
  }
  const address = Option.getOrNull(request.remoteAddress)
  const tailscale = yield* Tailscale
  const login = yield* tailscale.identify(address, request.headers)
  if (!login || login !== owner) {
    yield* Effect.log(`write rejected: ${address ?? "unknown"} -> ${login ?? "unidentified"}`)
    return { login: null, allowed: false, reason: "forbidden: not you", status: 403 as const }
  }
  return { login, allowed: true, reason: "", status: 200 as const }
})

/**
 * The same decision for RPC handlers, which are handed request headers
 * rather than an `HttpServerRequest`.
 *
 * The remote address is read from the request when one is in scope and
 * omitted otherwise; `Tailscale.identify` already refuses an unknown
 * address, so an absent one fails closed rather than trusting the header.
 */
const canWrite = (headers: Record<string, string | undefined>) =>
  Effect.gen(function*() {
    const delegatedToken = bearerToken(headers)
    if (delegatedToken && auth.authorize(delegatedToken)) return { allowed: true, reason: "" }
    const owner = (Option.getOrNull(yield* Config.option(Config.string("INGEST_OWNER"))) ?? "").trim()
    if (!owner) {
      yield* Effect.log("write refused: INGEST_OWNER is not configured, so no one may write")
      return {
        allowed: false,
        reason: "writes are disabled: set INGEST_OWNER to the Tailscale login allowed to write"
      }
    }
    const address = yield* Effect.map(
      Effect.serviceOption(HttpServerRequest.HttpServerRequest),
      Option.match({
        onNone: () => null,
        onSome: (request) => Option.getOrNull(request.remoteAddress)
      })
    )
    const tailscale = yield* Tailscale
    const login = yield* tailscale.identify(address, headers)
    if (!login || login !== owner) {
      yield* Effect.log(`write rejected: ${address ?? "unknown"} -> ${login ?? "unidentified"}`)
      return { allowed: false, reason: "forbidden: not you" }
    }
    return { allowed: true, reason: "" }
  })

const approvalAccess = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const owner = approvalOwner()
  if (!owner) return null
  const tailscale = yield* Tailscale
  const login = yield* tailscale.identify(Option.getOrNull(request.remoteAddress), request.headers)
  return login === owner ? login : null
})

const ownerOnly = (what: string) =>
  Effect.gen(function*() {
    const access = yield* writeAccess
    if (!access.allowed) {
      if (access.status === 503) {
        yield* Effect.log(`${what} refused: INGEST_OWNER is not configured, so no one may write`)
      }
      return {
        login: null,
        response: HttpServerResponse.text(access.reason, { status: access.status })
      }
    }
    return { login: access.login, response: null }
  })


const jsonBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.flatMap(request.arrayBuffer, (body) => Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(body)) as unknown,
    catch: () => new Error("expected a JSON body")
  }))

const requestOrigin = (request: HttpServerRequest.HttpServerRequest) => {
  const host = request.headers.host
  // The service is private by default, and Tailscale Serve supplies HTTPS.
  // Falling back keeps local curl examples legible without trusting forwarded
  // host headers for any authorization decision.
  return host ? `https://${host}` : `http://127.0.0.1:${process.env.PORT ?? "8000"}`
}

const unauthenticated = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerResponse.jsonUnsafe({ error: "unauthorized", auth: `${requestOrigin(request)}/auth.md` }, {
    status: 401,
    headers: {
      "www-authenticate": `Bearer realm="medina", resource_metadata="${requestOrigin(request)}/.well-known/oauth-protected-resource"`,
      "cache-control": "no-store"
    }
  })

const publicAuthPath = (url: string) => {
  const path = url.split("?", 1)[0] ?? ""
  return path === "/auth.md" || path === "/cli/skill.md" || path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-authorization-server" || path === "/auth/requests" ||
    path.startsWith("/auth/approve/") || path === "/auth/delegations" || path === "/oauth2/token" || path === "/oauth2/revoke"
}

/** Apply the same full-access check to REST and the typed RPC endpoint. */
const AuthGate = HttpRouter.middleware((next) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (publicAuthPath(request.url)) return yield* next
    if (yield* fullAccess) return yield* next
    return unauthenticated(request)
  }),
  { global: true }
)
const Routes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    // Minimal auth.md-compatible delegation discovery. `medina` is deliberately
    // the sole scope for now: it represents the complete current API surface.
    yield* router.add("GET", "/auth.md", Effect.succeed(HttpServerResponse.text(`# Medina agent authorization

Medina supports one delegated scope: \`${MEDINA_SCOPE}\` (full access).

1. \`POST /auth/requests\` with \`{ "client_name": "Muse" }\`.
2. Show the returned \`approval_url\` to the owner. It must be opened through Tailscale.
3. Poll \`POST /oauth2/token\` with \`{ "grant_type": "urn:medina:delegation", "request_id": "…" }\`.
4. Send the resulting bearer token in \`Authorization: Bearer …\`.

Tokens last one hour, are stored only as hashes, and can be revoked at \`POST /oauth2/revoke\`.
`, { contentType: "text/markdown", headers: { "cache-control": "no-store" } })))
    yield* router.add("GET", "/cli/skill.md", Effect.succeed(HttpServerResponse.text(`# Medina CLI skill

Use this skill when you need to query or update its owner's Medina context.

## Authorization

First create a delegation request; do not ask for a long-lived secret:

\`\`\`sh
curl -sS -X POST "$MEDINA_URL/auth/requests" \\
  -H 'content-type: application/json' \\
  --data '{"client_name":"Muse"}'
\`\`\`

Show the returned \`approval_url\` to the owner. Poll until approval:

\`\`\`sh
curl -sS -X POST "$MEDINA_URL/oauth2/token" \\
  -H 'content-type: application/json' \\
  --data '{"grant_type":"urn:medina:delegation","request_id":"REQUEST_ID"}'
\`\`\`

Store \`access_token\` only in your secret environment as \`MEDINA_TOKEN\`.
It grants the one current \`medina\` scope (full access), expires after one
hour, and may be revoked by the owner. Never put it in a prompt, log, commit,
or tool output.

## Install and use the typed-RPC CLI

In a Medina checkout with Bun dependencies installed:

\`\`\`sh
bun install
export MEDINA_URL=https://medina-dev.warthog-yo.ts.net
export MEDINA_TOKEN=md_…
bun run cli:lifelog status
bun run cli:lifelog days 30
bun run cli:lifelog journal 2026-09-09
bun run cli:lifelog search 'meeting follow-up'
\`\`\`

The CLI is a thin wrapper around the typed \`/rpc\` interface and prints JSON
to stdout. Its available commands are \`status\`, \`days [limit]\`,
\`journal YYYY-MM-DD\`, \`transcripts YYYY-MM-DD\`, \`search QUERY\`, and
\`places\`.

Keep all traffic on the tailnet URL. For protocol details, fetch \`/auth.md\`.
`, { contentType: "text/markdown", headers: { "cache-control": "no-store" } })))
    yield* router.add("GET", "/.well-known/oauth-protected-resource", Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const origin = requestOrigin(request)
      return HttpServerResponse.jsonUnsafe({ resource: origin, authorization_servers: [origin], scopes_supported: [MEDINA_SCOPE], bearer_methods_supported: ["header"] }, { headers: { "cache-control": "no-store" } })
    }))
    yield* router.add("GET", "/.well-known/oauth-authorization-server", Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const origin = requestOrigin(request)
      return HttpServerResponse.jsonUnsafe({ issuer: origin, token_endpoint: `${origin}/oauth2/token`, revocation_endpoint: `${origin}/oauth2/revoke`, grant_types_supported: ["urn:medina:delegation"], scopes_supported: [MEDINA_SCOPE] }, { headers: { "cache-control": "no-store" } })
    }))
    yield* router.add("POST", "/auth/requests", Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = yield* jsonBody(request).pipe(Effect.match({ onFailure: () => null, onSuccess: (value) => value }))
      const clientName = typeof body === "object" && body !== null && "client_name" in body && typeof body.client_name === "string" ? body.client_name : ""
      try {
        const pending = auth.createRequest(clientName)
        return HttpServerResponse.jsonUnsafe({ request_id: pending.id, scope: MEDINA_SCOPE, expires_at: pending.expiresAt, approval_url: `${requestOrigin(request)}/auth/approve/${pending.id}` }, { status: 201, headers: { "cache-control": "no-store" } })
      } catch (error) {
        return HttpServerResponse.jsonUnsafe({ error: error instanceof Error ? error.message : "invalid request" }, { status: 400 })
      }
    }))
    yield* router.add("GET", "/auth/approve/:id", Effect.gen(function*() {
      const login = yield* approvalAccess
      if (!login) return HttpServerResponse.text("Approval requires the configured owner over Tailscale.", { status: 403 })
      const id = (yield* HttpRouter.params).id ?? ""
      const pending = auth.getRequest(id)
      if (!pending || pending.status !== "pending" || Date.parse(pending.expiresAt) <= Date.now()) return HttpServerResponse.text("This delegation request is missing or expired.", { status: 404 })
      const escapedName = pending.clientName.replace(/[&<>'\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[c]!)
      return HttpServerResponse.text(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve Medina access</title><main><h1>Approve Medina access?</h1><p><strong>${escapedName}</strong> is requesting <code>medina</code> — full access to Medina.</p><p>Approving creates a one-hour bearer token. You can revoke it later.</p><form method="post"><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></form><p>Owner: ${login}</p></main>`, { contentType: "text/html", headers: { "cache-control": "no-store" } })
    }))
    yield* router.add("POST", "/auth/approve/:id", Effect.gen(function*() {
      const login = yield* approvalAccess
      if (!login) return HttpServerResponse.text("Approval requires the configured owner over Tailscale.", { status: 403 })
      const request = yield* HttpServerRequest.HttpServerRequest
      const form = new URLSearchParams(new TextDecoder().decode(yield* Effect.orDie(request.arrayBuffer)))
      const id = (yield* HttpRouter.params).id ?? ""
      const result = form.get("decision") === "approve" ? auth.approve(id, login) : auth.deny(id, login)
      if (!result) return HttpServerResponse.text("This delegation request is missing, expired, or already decided.", { status: 404 })
      yield* Effect.log(`delegation ${result.status}: ${result.clientName} by ${login}`)
      return HttpServerResponse.text(`<!doctype html><title>Medina delegation</title><p>${result.status === "approved" ? "Access approved. Muse may now obtain its token." : "Access denied."}</p>`, { contentType: "text/html", headers: { "cache-control": "no-store" } })
    }))
    yield* router.add("GET", "/auth/delegations", Effect.gen(function*() {
      const login = yield* approvalAccess
      if (!login) return HttpServerResponse.text("Viewing delegations requires the configured owner over Tailscale.", { status: 403 })
      const rows = auth.listTokens().map((token) => `<tr><td>${token.clientName.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</td><td><code>${token.id}</code></td><td>${token.expiresAt}</td><td>${token.revokedAt ?? "active"}</td><td><form method="post"><input type="hidden" name="id" value="${token.id}"><button>Revoke</button></form></td></tr>`).join("") || "<tr><td colspan=5>No delegated tokens.</td></tr>"
      return HttpServerResponse.text(`<!doctype html><title>Medina delegations</title><h1>Medina delegations</h1><p>Owner: ${login}</p><table><thead><tr><th>Agent</th><th>ID</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`, { contentType: "text/html", headers: { "cache-control": "no-store" } })
    }))
    yield* router.add("POST", "/auth/delegations", Effect.gen(function*() {
      const login = yield* approvalAccess
      if (!login) return HttpServerResponse.text("Revoking delegations requires the configured owner over Tailscale.", { status: 403 })
      const request = yield* HttpServerRequest.HttpServerRequest
      const form = new URLSearchParams(new TextDecoder().decode(yield* Effect.orDie(request.arrayBuffer)))
      const revoked = auth.revokeId(form.get("id") ?? "")
      if (revoked) yield* Effect.log(`delegation revoked by ${login}`)
      return HttpServerResponse.redirect("/auth/delegations", { status: 303 })
    }))
    yield* router.add("POST", "/oauth2/token", Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = yield* jsonBody(request).pipe(Effect.match({ onFailure: () => null, onSuccess: (value) => value }))
      const requestId = typeof body === "object" && body !== null && "request_id" in body && typeof body.request_id === "string" ? body.request_id : ""
      const grant = typeof body === "object" && body !== null && "grant_type" in body && typeof body.grant_type === "string" ? body.grant_type : ""
      if (grant !== "urn:medina:delegation" || !requestId) return HttpServerResponse.jsonUnsafe({ error: "invalid_request" }, { status: 400 })
      const redeemed = auth.redeem(requestId)
      if (typeof redeemed === "object") return HttpServerResponse.jsonUnsafe({ access_token: redeemed.token, token_type: "Bearer", expires_in: Math.round((Date.parse(redeemed.expiresAt) - Date.now()) / 1000), scope: MEDINA_SCOPE }, { headers: { "cache-control": "no-store" } })
      return HttpServerResponse.jsonUnsafe({ error: redeemed === "pending" ? "authorization_pending" : "invalid_grant" }, { status: redeemed === "pending" ? 428 : 400, headers: { "cache-control": "no-store" } })
    }))
    yield* router.add("POST", "/oauth2/revoke", Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = yield* jsonBody(request).pipe(Effect.match({ onFailure: () => null, onSuccess: (value) => value }))
      const token = typeof body === "object" && body !== null && "token" in body && typeof body.token === "string" ? body.token : bearerToken(request.headers)
      if (!token) return HttpServerResponse.jsonUnsafe({ error: "invalid_request" }, { status: 400 })
      auth.revoke(token)
      return HttpServerResponse.empty({ status: 204, headers: { "cache-control": "no-store" } })
    }))

    // The home page is an SPA: a static shell plus the client bundle. All
    // journal data arrives over the typed RPC at POST /rpc.
    yield* router.add(
      "GET",
      "/",
      Effect.succeed(HttpServerResponse.html(spaHome()))
    )
    yield* router.add(
      "GET",
      "/app.js",
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = process.env.CLIENT_BUNDLE ?? "example-lifelog/public/app.js"
        if (!(yield* fs.exists(path))) {
          return HttpServerResponse.text("client bundle missing: run bun run build:client", { status: 503 })
        }
        return HttpServerResponse.text(yield* fs.readFileString(path), {
          contentType: "text/javascript",
          headers: { "cache-control": "private, max-age=60" }
        })
      }).pipe(Effect.orDie)
    )
    /**
     * Inter, self-hosted from the installed package.
     *
     * Served rather than pulled from a CDN so the UI has one typeface with
     * no third-party request: this runs behind a tailnet or an authenticating
     * proxy, where a CDN fetch is both a privacy leak and a thing that can
     * fail. Immutable for a year -- the file name is version-pinned by the
     * dependency, so it can never mean something different.
     */
    yield* router.add(
      "GET",
      "/inter.woff2",
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"
        if (!(yield* fs.exists(path))) {
          return HttpServerResponse.text("font missing: run bun install", { status: 503 })
        }
        return HttpServerResponse.uint8Array(yield* fs.readFile(path), {
          contentType: "font/woff2",
          headers: { "cache-control": "public, max-age=31536000, immutable" }
        })
      }).pipe(Effect.orDie)
    )
    // Live progress as SSE, for curl and anything that is not the SPA. The
    // browser uses the `StreamEvents` RPC instead; both read `liveEvents`,
    // so the two feeds cannot diverge.
    yield* router.add(
      "GET",
      "/events",
      Effect.succeed(
        HttpServerResponse.stream(
          Stream.map(
            liveEvents,
            (event) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
          ),
          {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-store" }
          }
        )
      )
    )
    yield* router.add(
      "GET",
      "/journal/:day",
      Effect.gen(function*() {
        const day = parseDayId((yield* HttpRouter.params).day ?? "")
        if (day === null) {
          return HttpServerResponse.text("not a day: use 020260907 or 2026-09-07", { status: 400 })
        }
        // Same resource, two representations: browsers get the page, tools
        // get the record.
        const request = yield* HttpServerRequest.HttpServerRequest
        const wantsHtml = (request.headers["accept"] ?? "").includes("text/html")
        // Read-only: never materialize here. A stale or missing journal is a
        // 202 placeholder; the hourly pipeline pass converges it.
        const cached = yield* journalCachedForDay(day).pipe(Effect.orDie)
        if (Option.isNone(cached)) {
          return wantsHtml
            ? HttpServerResponse.text(pendingPage(day), {
              status: 202,
              contentType: "text/html",
              headers: { "cache-control": "private, max-age=60" }
            })
            : HttpServerResponse.jsonUnsafe({ status: "pending", day }, {
              status: 202,
              headers: { "cache-control": "private, max-age=60" }
            })
        }
        const journal = cached.value
        // Past days are settled (new audio for them is rare); the current and
        // future days want re-checking as inputs land.
        const today = yield* todayDay
        const cacheControl = journal.day < today
          ? "private, max-age=86400"
          : "private, max-age=60"
        return wantsHtml
          ? HttpServerResponse.text(dayPage(journal), {
            contentType: "text/html",
            headers: { "cache-control": cacheControl }
          })
          : HttpServerResponse.jsonUnsafe(journal, { headers: { "cache-control": cacheControl } })
      })
    )
    yield* router.add(
      "GET",
      "/movement/:day",
      Effect.gen(function*() {
        const day = parseDayId((yield* HttpRouter.params).day ?? "")
        if (day === null) {
          return HttpServerResponse.text("not a day: use 020260907 or 2026-09-07", { status: 400 })
        }
        // Read-only: never materialize here. A stale or missing movement is
        // a 202 placeholder; the hourly pipeline pass converges it.
        const cached = yield* movementCachedForDay(day).pipe(Effect.orDie)
        if (Option.isNone(cached)) {
          return HttpServerResponse.jsonUnsafe({ status: "pending", day }, {
            status: 202,
            headers: { "cache-control": "private, max-age=60" }
          })
        }
        const movement = cached.value
        const today = yield* todayDay
        const cacheControl = day < today
          ? "private, max-age=86400"
          : "private, max-age=60"
        return HttpServerResponse.jsonUnsafe(movement, { headers: { "cache-control": cacheControl } })
      })
    )
    // Operator surface, kept as plain HTTP for curl and monitoring. Encoded
    // through the same `PipelineStatus` schema the RPC serves, so the two
    // views of pipeline health cannot describe different shapes.
    yield* router.add(
      "GET",
      "/status",
      pipelineStatus.pipe(
        Effect.map((status) => HttpServerResponse.jsonUnsafe(status)),
        Effect.orDie
      )
    )
    // "My location" for assistants and UIs: last fix plus a movement summary.
    yield* router.add(
      "GET",
      "/location",
      Effect.gen(function*() {
        const location = yield* Effect.orDie(locationSummary)
        return HttpServerResponse.jsonUnsafe({ location }, { headers: { "cache-control": "no-store" } })
      })
    )
    yield* router.add(
      "GET",
      "/gps/:day",
      Effect.gen(function*() {
        const day = parseDayId((yield* HttpRouter.params).day ?? "")
        if (day === null) {
          return HttpServerResponse.text("not a day: use 020260907 or 2026-09-07", { status: 400 })
        }
        const points = yield* Effect.orDie(gpsDay(day))
        const today = yield* todayDay
        const cacheControl = day < today ? "private, max-age=3600" : "private, max-age=60"
        return HttpServerResponse.jsonUnsafe({ day, count: points.length, points }, {
          headers: { "cache-control": cacheControl }
        })
      })
    )
    yield* router.add(
      "GET",
      "/stays/:day",
      Effect.gen(function*() {
        const day = parseDayId((yield* HttpRouter.params).day ?? "")
        if (day === null) {
          return HttpServerResponse.text("not a day: use 020260907 or 2026-09-07", { status: 400 })
        }
        const stays = yield* Effect.orDie(staysDay(day))
        const today = yield* todayDay
        const cacheControl = day < today ? "private, max-age=3600" : "private, max-age=60"
        return HttpServerResponse.jsonUnsafe({ day, count: stays.length, stays }, {
          headers: { "cache-control": cacheControl }
        })
      })
    )
    // The place editor's reads and its one write now live on the typed RPC
    // (`ListPlaces`, `ListPlaceCandidates`, `SearchAddress`, `SavePlaces`).
    // They were only ever the UI's plumbing, and keeping a second,
    // hand-decoded copy of the write path is how the two drift apart.
    // Push ingest: apps (e.g. a GPS logger) POST batches here from the
    // tailnet. Identity comes from Tailscale: the WireGuard peer behind the
    // source address must map to the owner's login. No tokens — the tailnet
    // is the credential. `?source=` labels the provenance (default "http").
    // The body is stored as an uninterpreted capture; deriving anything
    // from it is a future resource's job.
    yield* router.add(
      "POST",
      "/in",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const params = yield* HttpServerRequest.ParsedSearchParams
        const { login, response } = yield* ownerOnly("ingest")
        if (response) return response
        const source = typeof params.source === "string" && params.source ? params.source : "http"
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) {
          return HttpServerResponse.text("source must be [a-z0-9-], e.g. gps-gpslogger", { status: 400 })
        }
        const body = new Uint8Array(yield* Effect.orDie(request.arrayBuffer))
        if (body.length === 0) return HttpServerResponse.text("empty body", { status: 400 })
        const contentType = request.headers["content-type"] ?? "application/octet-stream"
        // GPS is recognized by content, not by source label — the phone just
        // posts to /in, like Drive files are recognized as audio by mimeType.
        // The points are the signal, the envelope is scaffolding; unparseable
        // bodies still land as blob captures so nothing is silently dropped.
        {
          const points = parseGpsBody(source === "http" ? "gps-gpslogger" : source, new TextDecoder().decode(body))
          if (points) {
            const count = yield* Effect.orDie(gpsInboxWrite(points))
            yield* Effect.log(`gps ingest ${source} (${login}): ${count} points`)
            return HttpServerResponse.jsonUnsafe({ ok: true, points: count })
          }
        }
        const result = yield* Effect.orDie(httpIngest(source, body, contentType))
        yield* Effect.log(
          `http ingest ${source} (${login}): ${result.bytes} bytes -> ${result.captureId.slice(0, 12)}${
            result.duplicate ? " (duplicate)" : ""
          }`
        )
        return HttpServerResponse.jsonUnsafe({ ok: true, captureId: result.captureId, duplicate: result.duplicate })
      })
    )
  })
)

type LifelogEnv = Drive.Drive | Bucket.Bucket | R2TempCreds.R2TempCreds | TransloaditNormalize.TransloaditNormalize | AssemblyAI.AssemblyAI | Git.Git | FileSystem.FileSystem | LanguageModel.LanguageModel | WorkflowEngine | StartTimeRulesService

const Ingest = Layer.effectDiscard(
  Effect.gen(function*() {
    const enabled = new Set(
      (process.env.MEDINA_SOURCES ?? "audio,notes,bucket,inventory,allow")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    )
    const folderId = process.env.GDRIVE_FOLDER_ID?.trim()
    const tokenUrl = process.env.GOOGLE_TOKEN_URL?.trim()
    const latest = yield* Config.int("SOURCE_LATEST").pipe(Config.withDefault(25))
    const notesDir = process.env.NOTES_REPO_DIR?.trim()
    const notesUrl = process.env.NOTES_REPO_URL?.trim()
    const notesRef = process.env.NOTES_REPO_REF?.trim() || "HEAD"
    const git = yield* Git.Git
    const bucket = yield* Bucket.Bucket
    const bucketPrefix = process.env.BUCKET_PREFIX ?? ""
    const bucketLimit = Number(process.env.BUCKET_LIMIT ?? "25")

    const managedNotes: Source<LifelogEnv> | undefined = notesUrl
      ? {
          name: "notes",
          ingest: Effect.flatMap(
            git.ensureCheckout(notesUrl, notesRef, DATA_DIR),
            (checkout) => notesSource(checkout).ingest
          )
        }
      : notesDir
        ? notesSource(notesDir)
        : undefined

    const sources: ReadonlyArray<PipelineSource<LifelogEnv>> = [
      {
        name: "audio-drive",
        source: enabled.has("audio") && folderId && tokenUrl ? audioSource(folderId, latest) : undefined,
        disabledReason: enabled.has("audio") ? "GDRIVE_FOLDER_ID and GOOGLE_TOKEN_URL are required" : "disabled by MEDINA_SOURCES"
      },
      {
        // Metadata-only crawl of everything the Drive credential can see.
        // Inspection is not ingestion: this source reads no file content.
        name: "drive-inventory",
        source: enabled.has("inventory") && tokenUrl ? driveInventorySource : undefined,
        disabledReason: enabled.has("inventory") ? "GOOGLE_TOKEN_URL is required" : "disabled by MEDINA_SOURCES"
      },
      {
        // Ingestion of individually allowlisted Drive files (allow/drive.json
        // in the data dir). An empty allowlist ingests nothing.
        name: "drive-allow",
        source: enabled.has("allow") && tokenUrl ? driveAllowlistSource : undefined,
        disabledReason: enabled.has("allow") ? "GOOGLE_TOKEN_URL is required" : "disabled by MEDINA_SOURCES"
      },
      {
        name: "notes-git",
        source: enabled.has("notes") ? managedNotes : undefined,
        disabledReason: enabled.has("notes") ? "NOTES_REPO_URL or NOTES_REPO_DIR is required" : "disabled by MEDINA_SOURCES"
      },
      {
        name: "bucket-audio",
        source: enabled.has("bucket") && bucket.configured
          ? recordingObjectSource(
              "bucket-audio",
              bucket.list(bucketPrefix, Number.isFinite(bucketLimit) ? bucketLimit : 25).pipe(
                Effect.map((objects) =>
                  objects
                    // The archive sweep writes back to this same bucket under
                    // `capture/` (and receipts under `archive/`); never
                    // re-discover our own archive as new recordings.
                    .filter((object) => !object.key.startsWith("capture/") && !object.key.startsWith("archive/") && !object.key.startsWith("media/") && !object.key.startsWith("normalize/"))
                    .map((object) => ({
                      id: object.key,
                      name: object.key.split("/").pop() || object.key,
                      mimeType: "audio/application",
                      modifiedTime: object.lastModified ?? new Date(0).toISOString(),
                      ...(object.etag === null ? {} : { checksum: object.etag })
                    }))
                )
              ),
              (file) => bucket.download(file.id)
            )
          : undefined,
        disabledReason: enabled.has("bucket")
          ? "BUCKET_NAME and BUCKET_ENDPOINT are required"
          : "disabled by MEDINA_SOURCES"
      }
    ]
    yield* Effect.andThen(
      runPipeline<LifelogEnv>(
        sources,
        // Stage order: the archive sweep runs first -- every capture the
        // pass just ingested reaches the bucket before any derivation work.
        // Then normalize (probe + transcode to canonical chunks; after this
        // original blobs are never read again) and transcribe (chunks ->
        // one merged transcript per capture), then GPS derivations.
        [archiveSweepSource, mediaNormalizeSource, mediaTranscribeSource, gpsCompactSource, staysSource],
        // Order matters: movement enriches journals, after attribution/index.
        // Order matters: notes are extraction from audio (stable across movement
        // changes), movement enriches journals, and the journal reads both.
        [attributionResource, dayIndexResource, transcriptSearchResource, movementResource, notesResource, journalResource],
        dataPath
      ).pipe(
        Effect.catchCause((cause) => Effect.logError("pipeline run failed", cause))
      ),
      // The pass may have materialized new journals: reconverge the served
      // previews behind, so readers see them without paying derivation.
      Effect.forkDetach(refreshDayPreviews)
    ).pipe(
      Effect.repeat(Schedule.spaced("1 hour")),
      Effect.forkScoped
    )
  })
)

/**
 * Fill the previews memo after boot so the first visitor never pays the
 * cold read over the mount. A request racing the warmup computes
 * synchronously exactly once, as before.
 */
const Warmup = Layer.effectDiscard(Effect.forkDetach(refreshDayPreviews))

/**
 * Keep the served previews converging on journal writes: every published
 * day triggers a memo refresh. Single-flight inside refreshDayPreviews
 * collapses a materialization burst into one recompute.
 */
const DaySync = Layer.effectDiscard(
  Stream.runForEach(Stream.fromPubSub(DayEvents.dayHub), () => refreshDayPreviews).pipe(
    Effect.forkDetach
  )
)

/** The journal language model: OpenAI Responses API via the exe.dev relay. */
const LlmLive = Layer.unwrap(
  Effect.gen(function*() {
    const apiUrl = (yield* Config.string("JOURNAL_LLM_API_URL").pipe(
      Config.withDefault("https://api.openai.com/v1")
    )).replace(/\/$/, "")
    const model = yield* Config.string("JOURNAL_LLM_MODEL").pipe(Config.withDefault("gpt-5.5"))
    const apiKey = yield* Config.string("JOURNAL_LLM_API_KEY").pipe(Config.withDefault(""))
    return OpenAiLanguageModel.layer({ model, config: { reasoning: { effort: "low" } } }).pipe(
      Layer.provide(OpenAiClient.layer({ apiUrl, ...(apiKey ? { apiKey: Redacted.make(apiKey) } : {}) }))
    )
  })
)

// The journal workflow's LLM activities need the language model at
// registration time. Layer memoization means LlmLive builds once even
// though it also appears in Services.
const WorkflowsLive = Layer.mergeAll(
  JournalWorkflowLayer,
  NotesWorkflowLayer
).pipe(Layer.provide(LlmLive))

const Services = Layer.mergeAll(
  Drive.layer,
  Bucket.layer,
  R2TempCreds.layer,
  TransloaditNormalize.layer.pipe(Layer.provide(R2TempCreds.layer)),
  AssemblyAI.layer,
  Git.layer,
  tailscaleLayer,
  // This archive's start-time rules, layered over Medina's defaults. Edit
  // `StartTimeHints.ts` to teach it about a new recorder or a bad clock;
  // the rules hash into the attribution basis, so saving re-derives.
  StartTimeHintsLive,
  LlmLive,
  WorkflowsLive,
  TelemetryLive
).pipe(
  // Engine on top of the single-process cluster; everything above can
  // execute workflows, the pipeline and routes included.
  Layer.provideMerge(WorkflowEngineLive),
  Layer.provideMerge(ClusterLive),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer)
)

/** Typed journals RPC at POST /rpc, over plain HTTP on the same router. */
const RpcLive = RpcServer.layerHttp({ group: JournalsGroup, path: "/rpc", protocol: "http" }).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(makeJournalsHandlers({ canWrite }))
)

const Main = Layer.mergeAll(
  HttpRouter.serve(Layer.mergeAll(Routes, RpcLive, AuthGate)),
  Ingest,
  Warmup,
  DaySync
).pipe(
  Layer.provide(Services),
  // Routes and handlers both read attribution, which needs the rules.
  Layer.provide(StartTimeHintsLive),
  // Cold caches over the network mount can push the first / render past
  // Bun's default 10s request timeout; give handlers more room.
  // Bind loopback by default. Reads (journals, GPS, transcripts) are
  // unauthenticated by design -- something in front is expected to
  // authenticate: `tailscale serve` and the exe.dev proxy both terminate
  // outside and forward to 127.0.0.1. Defaulting to 0.0.0.0 would instead
  // publish a personal lifelog to whatever network the host is on. Set
  // `HOST=0.0.0.0` deliberately, and only behind such a front door.
  Layer.provide(BunHttpServer.layer({
    hostname: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 8000),
    idleTimeout: 120
  }))
)

BunRuntime.runMain(Layer.launch(Main))
