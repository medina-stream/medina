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
import * as Layer from "effect/Layer"
import * as SingleRunner from "effect/unstable/cluster/SingleRunner"
import * as ClusterWorkflowEngine from "effect/unstable/cluster/ClusterWorkflowEngine"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"

/** Mailbox + runner state. Not the record; safe to delete when idle. */
const SqlLive = SqliteClient.layer({ filename: process.env.CLUSTER_DB ?? "data/cluster.db" })

/** Single-process cluster: Sharding + Runners + MessageStorage over SQLite,
 * no-op runner health/communication. Swap for `BunClusterRunnerSocket` (or
 * HTTP runners) when a second machine joins. */
export const ClusterLive = SingleRunner.layer().pipe(
  Layer.provideMerge(SqlLive)
)

/** Durable workflow engine on top of the cluster. */
export const WorkflowEngineLive = ClusterWorkflowEngine.layer
