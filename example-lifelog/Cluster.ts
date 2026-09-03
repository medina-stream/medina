/**
 * The cluster: durable execution for expensive pipeline work.
 *
 * Tier 2 of the distribution story (see README “Distribution”): Effect
 * cluster with a SQL-backed mailbox, run single-process today via
 * `SingleRunner` and upgradable to multi-runner sharding without redesign —
 * the entities and workflows are the same, only the runner layers change.
 *
 * The SQLite mailbox is a peripheral (coordination state, not the record):
 * losing it loses in-flight work requests, which the next hourly pass
 * re-derives from the filesystem. It lives outside DATA_DIR for exactly
 * that reason.
 *
 * First durable workflow: journal materialization. The LLM calls are the
 * expensive, flaky steps — each notes batch and the final report are
 * Activities, so a crash or interrupt resumes past completed LLM calls
 * instead of re-paying for them.
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as SingleRunner from "effect/unstable/cluster/SingleRunner"
import * as ClusterWorkflowEngine from "effect/unstable/cluster/ClusterWorkflowEngine"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as ExeWirePg from "../lib/ExeWirePg.ts"

/**
 * Mailbox + runner state. Not the record; safe to delete when idle.
 *
 * Three backends, in precedence order:
 * 1. `CLUSTER_DATABASE_URL` — shared Postgres URL (direct connection).
 *    `CLUSTER_PG_SSL=false` disables TLS (local Postgres without certs);
 *    it defaults on for hosted backends.
 * 2. `CLUSTER_PG_WIRE_HOST` — an exe.dev wire integration host (e.g.
 *    `supabase-medina.int.exe.xyz`). No secret: the edge injects the
 *    upstream credential, so the VM never holds a database password.
 * 3. Local SQLite (`CLUSTER_DB`) — the single-machine default.
 *
 * Every runner pointed at the same backend 1 or 2 shares one mailbox —
 * the prerequisite for multi-runner sharding.
 */
const SqlLive = Layer.unwrap(Effect.gen(function*() {
  const url = yield* Config.option(Config.string("CLUSTER_DATABASE_URL"))
  if (url._tag === "Some" && url.value.trim() !== "") {
    const sslOff = (process.env.CLUSTER_PG_SSL ?? "").toLowerCase()
    const ssl = sslOff === "false" || sslOff === "disable" || sslOff === "0" ? undefined : true
    return PgClient.layer({ url: Redacted.make(url.value.trim()), ...(ssl === undefined ? {} : { ssl }) })
  }
  const wireHost = yield* Config.option(Config.string("CLUSTER_PG_WIRE_HOST"))
  if (wireHost._tag === "Some" && wireHost.value.trim() !== "") {
    const wirePort = Number(process.env.CLUSTER_PG_WIRE_PORT ?? "5432")
    return ExeWirePg.layer({ host: wireHost.value.trim(), port: wirePort })
  }
  return SqliteClient.layer({ filename: process.env.CLUSTER_DB ?? "data/cluster.db" })
}))

/** Single-process cluster: Sharding + Runners + MessageStorage over the
 * configured SQL backend, no-op runner health/communication. Swap for
 * `BunClusterSocket.layer({ storage: "sql" })` (or HTTP runners) + the same
 * shared Postgres URL when a second machine joins. */
export const ClusterLive = SingleRunner.layer().pipe(
  Layer.provideMerge(SqlLive)
)

/** Durable workflow engine on top of the cluster. */
export const WorkflowEngineLive = ClusterWorkflowEngine.layer
