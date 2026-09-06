/**
 * Read-only access to a local git checkout: list files at HEAD with their blob
 * shas, read blob content, and recover a file's last-commit time.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { createHash } from "node:crypto"
import { join } from "node:path"

export interface GitFile {
  readonly path: string
  readonly blobSha: string
}

export class Git extends Context.Service<Git, {
  readonly ensureCheckout: (url: string, ref: string, root: string) => Effect.Effect<string, Error>
  readonly listFiles: (repo: string) => Effect.Effect<ReadonlyArray<GitFile>, Error>
  readonly readBlob: (repo: string, blobSha: string) => Effect.Effect<string, Error>
  readonly lastCommitTime: (repo: string, path: string) => Effect.Effect<string | null, Error>
}>()("medina/Git") {}

export const layer: Layer.Layer<Git, never, ChildProcessSpawner | FileSystem.FileSystem> = Layer.effect(Git)(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const asError = (cause: unknown) => new Error("git failed", { cause })

    const runCommand = (command: string, args: ReadonlyArray<string>) =>
      Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args))
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

    const run = (repo: string, args: ReadonlyArray<string>) =>
      runCommand("git", ["-C", repo, ...args])

    return {
      ensureCheckout: (url, ref, root) => Effect.gen(function*() {
        const id = createHash("sha256").update(url).digest("hex").slice(0, 16)
        const checkout = join(root, "sources", "git", id)
        if (!(yield* fs.exists(join(checkout, ".git")))) {
          const parent = join(root, "sources", "git")
          const staging = `${checkout}.tmp-${process.pid}`
          yield* fs.makeDirectory(parent, { recursive: true })
          yield* fs.remove(checkout, { recursive: true, force: true }).pipe(Effect.ignore)
          yield* fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)
          yield* runCommand("git", ["clone", "--filter=blob:none", "--no-checkout", url, staging]).pipe(
            Effect.onError(() => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore))
          )
          yield* fs.rename(staging, checkout)
        }
        yield* run(checkout, ["fetch", "--prune", "origin", ref])
        yield* run(checkout, ["checkout", "--detach", "FETCH_HEAD"])
        return checkout
      }).pipe(Effect.mapError(asError)),

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
