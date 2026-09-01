/**
 * Read-only access to a local git checkout: list files at HEAD with their blob
 * shas, read blob content, and recover a file's last-commit time.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export interface GitFile {
  readonly path: string
  readonly blobSha: string
}

export class Git extends Context.Service<Git, {
  readonly listFiles: (repo: string) => Effect.Effect<ReadonlyArray<GitFile>, Error>
  readonly readBlob: (repo: string, blobSha: string) => Effect.Effect<string, Error>
  readonly lastCommitTime: (repo: string, path: string) => Effect.Effect<string | null, Error>
}>()("medina/Git") {}

export const layer: Layer.Layer<Git, never, ChildProcessSpawner> = Layer.effect(Git)(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const asError = (cause: unknown) => new Error("git failed", { cause })

    const run = (repo: string, args: ReadonlyArray<string>) =>
      Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawner.spawn(ChildProcess.make("git", ["-C", repo, ...args]))
        const [output, errors, exitCode] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode
        ], { concurrency: 3 })
        if (exitCode !== 0) {
          return yield* Effect.fail(new Error(`git ${args[0]} exited ${exitCode}: ${errors.slice(0, 500)}`))
        }
        return output
      })).pipe(Effect.mapError(asError))

    return {
      listFiles: (repo) =>
        run(repo, ["ls-tree", "-r", "-z", "--format=%(objectname)\t%(path)", "HEAD"]).pipe(
          Effect.map((output) =>
            output.split("\0").filter(Boolean).flatMap((line) => {
              const tab = line.indexOf("\t")
              if (tab === -1) return []
              return [{ blobSha: line.slice(0, tab), path: line.slice(tab + 1) }]
            })
          )
        ),

      readBlob: (repo, blobSha) => run(repo, ["cat-file", "blob", blobSha]),

      lastCommitTime: (repo, path) =>
        run(repo, ["log", "-1", "--format=%aI", "--", path]).pipe(
          Effect.map((output) => output.trim() || null)
        )
    }
  })
)
