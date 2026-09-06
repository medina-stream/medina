/** Scoped Effect wrapper around the DuckDB CLI's JSON query mode. */
import { spawn } from "node:child_process"
import { promises as fsp } from "node:fs"
import { tmpdir } from "node:os"
import * as Effect from "effect/Effect"

/** Run a statement and return its JSON output without crossing the child's
 * bounded stdout buffer. */
export const queryJson = (sql: string) =>
  Effect.callback<string, Error>((resume) => {
    const out = `${tmpdir()}/medina-duckdb-out-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    const child = spawn("duckdb", ["-json"], { timeout: 120_000 })
    let settled = false
    const done = (result: Effect.Effect<string, Error>) => {
      if (settled) return
      settled = true
      void fsp.rm(out, { force: true })
      resume(result)
    }
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000)
    })
    child.on("error", (error) => done(Effect.fail(new Error(`duckdb failed: ${error.message}`))))
    child.on("close", (code, signal) => {
      if (code !== 0) return done(Effect.fail(new Error(`duckdb exited ${signal ?? code}: ${stderr}`)))
      fsp.readFile(out, "utf8").then(
        (text) => done(Effect.succeed(text)),
        (error) => done(Effect.fail(new Error(`duckdb output unreadable: ${String(error)}`)))
      )
    })
    child.stdin.on("error", () => {})
    child.stdin.end(`.output ${out}\n${sql};\n.output none\n`)
  })

export const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
