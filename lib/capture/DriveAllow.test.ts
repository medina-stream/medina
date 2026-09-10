import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { BunFileSystem } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { Drive, DriveItem } from "../Drive.ts"
import { layerMemory } from "../Bucket.ts"
import { TransloaditNormalize } from "./TransloaditNormalize.ts"
import * as Files from "../Files.ts"
import { DATA_DIR, dataPath } from "../lifelog/Resources.ts"
import {
  buildInventory,
  DRIVE_ALLOWLIST_KEY,
  DriveAllowlist,
  driveAllowlistSource,
  resolvePaths
} from "./DriveAllow.ts"

if (!DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run against a non-temp data dir: ${DATA_DIR}`)
}

const FOLDER = "application/vnd.google-apps.folder"
const item = (partial: Partial<DriveItem> & { id: string; name: string }) =>
  new DriveItem({
    mimeType: "text/plain",
    modifiedTime: "2026-01-01T00:00:00Z",
    ...partial
  })

describe("resolvePaths", () => {
  test("resolves nested folders, truncates at invisible parents, survives cycles", () => {
    const items = [
      item({ id: "root", name: "Stuff", mimeType: FOLDER }),
      item({ id: "sub", name: "2026", mimeType: FOLDER, parents: ["root"] }),
      item({ id: "f1", name: "a.txt", parents: ["sub"] }),
      item({ id: "f2", name: "b.txt", parents: ["unshared-folder"] }),
      item({ id: "loop1", name: "l1", mimeType: FOLDER, parents: ["loop2"] }),
      item({ id: "loop2", name: "l2", mimeType: FOLDER, parents: ["loop1"] }),
      item({ id: "f3", name: "c.txt", parents: ["loop1"] })
    ]
    const paths = resolvePaths(items)
    expect(paths.get("f1")).toBe("Stuff/2026")
    expect(paths.get("f2")).toBe("")
    // A cycle terminates and yields a truncated-but-usable path.
    expect(paths.get("f3")).toContain("l1")
  })
})

describe("buildInventory", () => {
  test("counts files and folders separately and sums sizes", () => {
    const inventory = buildInventory([
      item({ id: "d", name: "Docs", mimeType: FOLDER }),
      item({ id: "x", name: "x.pdf", parents: ["d"], size: "1000" }),
      item({ id: "y", name: "y.pdf", parents: ["d"], size: "500" })
    ])
    expect(inventory.fileCount).toBe(2)
    expect(inventory.folderCount).toBe(1)
    expect(inventory.totalBytes).toBe(1500)
    expect(inventory.entries.map((entry) => entry.path)).toEqual(["", "Docs", "Docs"])
  })
})

describe("driveAllowlistSource", () => {
  const driveOf = (items: ReadonlyArray<DriveItem>, downloads: Array<string>, imports: Array<string>) =>
    Layer.succeed(Drive)({
      list: () => Effect.succeed([]),
      listAll: Effect.succeed(items),
      importRequest: (id) => Effect.sync(() => {
        imports.push(id)
        return { url: `https://drive.test/${id}`, headers: ["Authorization: Bearer ephemeral"] }
      }),
      download: (id) =>
        Effect.sync(() => {
          downloads.push(id)
          return Stream.make(new TextEncoder().encode(`content of ${id}`))
        })
    })

  const transloaditOf = (remote: Array<string>, configured = true) => {
    const completed = new Set<string>()
    return Layer.succeed(TransloaditNormalize)({
      configured,
      normalize: () => Effect.succeed("completed"),
      ingestDrive: (_source, file, request) => completed.has(file.id)
        ? Effect.succeed("cached")
        : Effect.flatMap(request, () => Effect.sync(() => {
            remote.push(file.id)
            completed.add(file.id)
            return "completed" as const
          }))
    })
  }

  const layersOf = (
    items: ReadonlyArray<DriveItem>,
    downloads: Array<string>,
    imports: Array<string>,
    remote: Array<string>,
    configured = true
  ) => Layer.mergeAll(
    driveOf(items, downloads, imports),
    transloaditOf(remote, configured),
    layerMemory(),
    BunFileSystem.layer
  )

  test("an empty allowlist imports and downloads nothing", async () => {
    const downloads: Array<string> = []
    const imports: Array<string> = []
    const remote: Array<string> = []
    const report = await Effect.runPromise(
      driveAllowlistSource.ingest.pipe(
        Effect.provide(layersOf([item({ id: "f1", name: "a.txt" })], downloads, imports, remote))
      )
    )
    expect(report.discovered).toBe(0)
    expect(downloads).toEqual([])
    expect(imports).toEqual([])
    expect(remote).toEqual([])
  })

  test("an unconfigured remote path fails closed without reading Drive content", async () => {
    const downloads: Array<string> = []
    const imports: Array<string> = []
    const remote: Array<string> = []
    await Effect.runPromise(
      Files.writeJson(
        dataPath(DRIVE_ALLOWLIST_KEY),
        new DriveAllowlist({ files: [{ id: "blocked" }] })
      ).pipe(Effect.provide(BunFileSystem.layer))
    )
    const report = await Effect.runPromise(
      driveAllowlistSource.ingest.pipe(
        Effect.provide(layersOf(
          [item({ id: "blocked", name: "large.wav", mimeType: "audio/wav" })],
          downloads,
          imports,
          remote,
          false
        ))
      )
    )
    expect(report.failures.length).toBe(1)
    expect(report.failures[0]!.error).toContain("refusing to download it to this host")
    expect(downloads).toEqual([])
    expect(imports).toEqual([])
    expect(remote).toEqual([])
  })

  test("only allowlisted files are remotely imported; Drive download is never called", async () => {
    const downloads: Array<string> = []
    const imports: Array<string> = []
    const remote: Array<string> = []
    await Effect.runPromise(
      Files.writeJson(
        dataPath(DRIVE_ALLOWLIST_KEY),
        new DriveAllowlist({ files: [{ id: "f1", note: "test" }, { id: "gone" }] })
      ).pipe(Effect.provide(BunFileSystem.layer))
    )
    const items = [
      item({ id: "f1", name: "a.txt", md5Checksum: "abc" }),
      item({ id: "f2", name: "never-allowed.txt" })
    ]
    const live = layersOf(items, downloads, imports, remote)
    const report = await Effect.runPromise(
      driveAllowlistSource.ingest.pipe(
        Effect.provide(live)
      )
    )
    expect(downloads).toEqual([])
    expect(imports).toEqual(["f1"])
    expect(remote).toEqual(["f1"])
    expect(report.ingested).toBe(1)
    expect(report.failures.length).toBe(1)
    expect(report.failures[0]!.item).toBe("gone")

    // A second pass is settled by the remote-ingest receipt; no new import.
    const second = await Effect.runPromise(
      driveAllowlistSource.ingest.pipe(
        Effect.provide(live)
      )
    )
    expect(downloads).toEqual([])
    expect(imports).toEqual(["f1"])
    expect(remote).toEqual(["f1"])
    expect(second.cached).toBe(1)
  })
})
