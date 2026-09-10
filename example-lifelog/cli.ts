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

const baseUrl = (process.env.MEDINA_URL ?? process.env.LIFELOG_URL ?? "").replace(/\/$/, "")
const token = process.env.MEDINA_TOKEN ?? ""
const [command, ...args] = process.argv.slice(2)

const usage = () => {
  console.error(`Usage: MEDINA_URL=https://host MEDINA_TOKEN=md_… bun run cli:lifelog <command>

Commands:
  status
  days [limit]
  journal YYYY-MM-DD
  transcripts YYYY-MM-DD
  search QUERY
  places`)
  process.exit(64)
}

if (!baseUrl || !token || !command) usage()

const HttpLive = Layer.effect(HttpClient.HttpClient)(
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.mapRequest(client, (request) => HttpClientRequest.setHeader(request, "authorization", `Bearer ${token}`))
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
    case "days": return yield* client.ListDays({ limit: args[0] ? Number(args[0]) : 30, offset: 0 })
    case "journal": if (args.length === 1) return yield* client.GetJournal({ day: args[0]! }); break
    case "transcripts": if (args.length === 1) return yield* client.GetDayTranscripts({ day: args[0]! }); break
    case "search": if (args.length > 0) return yield* client.SearchTranscripts({ query: args.join(" "), limit: 30 }); break
    case "places": return yield* client.ListPlaces({})
  }
  yield* Effect.sync(usage)
  return null
})

Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(RpcLive)))).then(
  (result) => console.log(JSON.stringify(result, null, 2)),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
)
