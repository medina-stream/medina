#!/usr/bin/env bun
/**
 * Thin command-line wrapper around Medina's typed journals RPC.
 *
 * MEDINA_URL=https://medina-dev.example.ts.net MEDINA_TOKEN=md_…
 *   bun run cli:lifelog status
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import { JournalsGroup } from "../lib/lifelog/JournalApi.ts"

const rawArgs = process.argv.slice(2)
const urlIndex = rawArgs.indexOf("--url")
const explicitUrl = urlIndex === -1 ? "" : rawArgs[urlIndex + 1] ?? ""
const args = urlIndex === -1 ? rawArgs : rawArgs.filter((_, index) => index !== urlIndex && index !== urlIndex + 1)
const baseUrl = (explicitUrl || process.env.MEDINA_URL || process.env.LIFELOG_URL || "").replace(/\/$/, "")
const token = process.env.MEDINA_TOKEN ?? ""
const [command, ...commandArgs] = args

const usage = () => {
  console.error(`Usage: bun medina-cli.js --url https://host <command>

Connect over the approved tailnet. If Medina asks for a token, set MEDINA_TOKEN
and read https://host/cli/skill.md for plain-English setup help.

Commands:
  status
  days [limit]
  journal YYYY-MM-DD
  transcripts YYYY-MM-DD
  search QUERY
  places`)
  process.exit(64)
}

if (!baseUrl || !command) usage()

// Tailscale-authenticated owner requests need no application token. A
// delegated caller can optionally set MEDINA_TOKEN instead.
const HttpLive = Layer.effect(HttpClient.HttpClient)(
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.mapRequest(client, (request) => token ? HttpClientRequest.setHeader(request, "authorization", `Bearer ${token}`) : request)
  )
).pipe(Layer.provide(FetchHttpClient.layer))

const RpcLive = RpcClient.layerProtocolHttp({ url: `${baseUrl}/rpc` }).pipe(
  Layer.provide(HttpLive),
  Layer.provide(RpcSerialization.layerNdjson)
)

const program = Effect.gen(function*() {
  const client = yield* RpcClient.make(JournalsGroup)
  switch (command) {
    case "status": return yield* client.GetStatus({})
    case "days": return yield* client.ListDays({ limit: commandArgs[0] ? Number(commandArgs[0]) : 30, offset: 0 })
    case "journal": if (commandArgs.length === 1) return yield* client.GetJournal({ day: commandArgs[0]! }); break
    case "transcripts": if (commandArgs.length === 1) return yield* client.GetDayTranscripts({ day: commandArgs[0]! }); break
    case "search": if (commandArgs.length > 0) return yield* client.SearchTranscripts({ query: commandArgs.join(" "), limit: 30 }); break
    case "places": return yield* client.ListPlaces({})
  }
  yield* Effect.sync(usage)
  return null
})

Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(RpcLive)))).then(
  (result) => console.log(JSON.stringify(result, null, 2)),
  (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (/401|unauthorized/i.test(message)) {
      console.error(`Medina did not recognize this caller. Connect this runtime to the approved tailnet, then retry.\nHelp: ${baseUrl}/cli/skill.md`)
    } else {
      console.error(`Medina CLI error: ${message}\nHelp: ${baseUrl}/cli/skill.md`)
    }
    process.exit(1)
  }
)
