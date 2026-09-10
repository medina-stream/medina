/**
 * Drive inspection and allowlisted ingestion: two separate capabilities,
 * deliberately not one.
 *
 * The inventory is a metadata crawl of everything the Drive credential can
 * see -- names, types, sizes, paths, checksums -- written to
 * `inventory/drive/latest.json`. It reads no file content: granting Medina
 * a wide view of a Drive must not mean ingesting it. The point is to be
 * able to look at the whole estate and decide, file by file, what belongs
 * in the lake.
 *
 * The allowlist is that decision, recorded: `allow/drive.json` in the data
 * dir, one entry per file id. Future allowlisted files are handed to a
 * signed Transloadit Assembly, which imports from Drive and stores straight
 * to R2. Medina never downloads those bytes. An absent or empty allowlist
 * ingests nothing -- the default is inspection without ingestion. Remove an
 * entry and the already-captured remote evidence remains (the allowlist gates
 * acquisition, not retention).
 *
 * Media files are remotely chunked for transcription. Other files are still
 * archived directly to R2 as uninterpreted original evidence, with only their
 * provenance and receipts stored locally.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Bucket } from "../Bucket.ts"
import { Drive, type DriveItem } from "../Drive.ts"
import * as Files from "../Files.ts"
import type { Source } from "../Resource.ts"
import { makeItemSource } from "../Source.ts"
import { TransloaditNormalize } from "./TransloaditNormalize.ts"
import { dataPath } from "../lifelog/Resources.ts"

export const DRIVE_INVENTORY_KEY = "inventory/drive/latest.json"
export const DRIVE_ALLOWLIST_KEY = "allow/drive.json"

/** One inventoried Drive item: identity, kind, size, and resolved path. */
export class InventoryEntry extends Schema.Class<InventoryEntry>("InventoryEntry")({
  id: Schema.String,
  name: Schema.String,
  /** Slash-joined folder path from the shallowest visible root, e.g.
   * `Recordings/2026`. Files whose parents are not visible sit at `""`. */
  path: Schema.String,
  mimeType: Schema.String,
  modifiedTime: Schema.String,
  size: Schema.NullOr(Schema.Number),
  md5Checksum: Schema.NullOr(Schema.String)
}) {}

export class DriveInventory extends Schema.Class<DriveInventory>("DriveInventory")({
  crawledAt: Schema.String,
  fileCount: Schema.Number,
  folderCount: Schema.Number,
  totalBytes: Schema.Number,
  entries: Schema.Array(InventoryEntry)
}) {}

export class AllowlistEntry extends Schema.Class<AllowlistEntry>("AllowlistEntry")({
  id: Schema.String,
  /** Why this file is in the lake -- for the future reader of the list. */
  note: Schema.optional(Schema.String),
  addedAt: Schema.optional(Schema.String)
}) {}

export class DriveAllowlist extends Schema.Class<DriveAllowlist>("DriveAllowlist")({
  files: Schema.Array(AllowlistEntry)
}) {}

const FOLDER = "application/vnd.google-apps.folder"

/** Resolve each item's folder path from the parents graph. Folders outside
 * the visible set truncate the path rather than failing: a file shared
 * without its ancestry is still listed, at the shallowest path we can see. */
export const resolvePaths = (items: ReadonlyArray<DriveItem>): ReadonlyMap<string, string> => {
  const folders = new Map(items.filter((item) => item.mimeType === FOLDER).map((item) => [item.id, item]))
  const memo = new Map<string, string>()
  const folderPath = (id: string, seen: ReadonlySet<string>): string => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    const folder = folders.get(id)
    // Unknown parent (not shared to us) or a cycle: treat as a root.
    if (folder === undefined || seen.has(id)) return ""
    const parent = folder.parents?.[0]
    const above = parent === undefined ? "" : folderPath(parent, new Set([...seen, id]))
    const path = above === "" ? folder.name : `${above}/${folder.name}`
    memo.set(id, path)
    return path
  }
  const paths = new Map<string, string>()
  for (const item of items) {
    const parent = item.parents?.[0]
    paths.set(item.id, parent === undefined ? "" : folderPath(parent, new Set()))
  }
  return paths
}

export const buildInventory = (items: ReadonlyArray<DriveItem>): DriveInventory => {
  const paths = resolvePaths(items)
  const entries = items
    .map((item) =>
      new InventoryEntry({
        id: item.id,
        name: item.name,
        path: paths.get(item.id) ?? "",
        mimeType: item.mimeType,
        modifiedTime: item.modifiedTime,
        size: item.size === undefined ? null : Number(item.size),
        md5Checksum: item.md5Checksum ?? null
      })
    )
    .sort((a, b) => `${a.path}/${a.name}`.localeCompare(`${b.path}/${b.name}`))
  return new DriveInventory({
    crawledAt: new Date().toISOString(),
    fileCount: entries.filter((entry) => entry.mimeType !== FOLDER).length,
    folderCount: entries.filter((entry) => entry.mimeType === FOLDER).length,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
    entries
  })
}

/**
 * The inventory as a pipeline source: each pass re-crawls metadata and
 * rewrites `inventory/drive/latest.json` when anything changed. `ingested`
 * means the inventory moved; `cached` means the Drive looks the same.
 */
export const driveInventorySource: Source<Drive | FileSystem.FileSystem> = {
  name: "drive-inventory",
  ingest: Effect.gen(function*() {
    const drive = yield* Drive
    const items = yield* drive.listAll
    const inventory = buildInventory(items)
    const previous = yield* Files.readJson(DriveInventory, dataPath(DRIVE_INVENTORY_KEY)).pipe(
      Effect.orElseSucceed(() => Option.none<DriveInventory>())
    )
    const unchanged = Option.isSome(previous)
      && JSON.stringify(previous.value.entries) === JSON.stringify(inventory.entries)
    if (!unchanged) {
      yield* Files.writeJson(dataPath(DRIVE_INVENTORY_KEY), inventory)
      yield* Effect.log(
        `drive inventory: ${inventory.fileCount} files, ${inventory.folderCount} folders, `
          + `${Math.round(inventory.totalBytes / 1e6)} MB visible`
      )
    }
    return {
      discovered: items.length,
      ingested: unchanged ? 0 : 1,
      cached: unchanged ? 1 : 0,
      skipped: 0,
      failures: []
    }
  })
}

export const readAllowlist: Effect.Effect<DriveAllowlist, Error, FileSystem.FileSystem> = Effect.map(
  Files.readJson(DriveAllowlist, dataPath(DRIVE_ALLOWLIST_KEY)),
  Option.getOrElse(() => new DriveAllowlist({ files: [] }))
)

const DRIVE_ALLOW_SOURCE = "drive-allow"

/**
 * The gate: only files on the allowlist are ever remotely imported. Discovery
 * intersects the allowlist with the live metadata (a listed id that Drive
 * no longer shows is reported as a failure, not silently dropped) -- an
 * empty allowlist discovers nothing and the source reads as `empty`.
 */
export const driveAllowlistSource: Source<Drive | TransloaditNormalize | Bucket | FileSystem.FileSystem> = makeItemSource({
  name: DRIVE_ALLOW_SOURCE,
  discover: Effect.gen(function*() {
    const allowlist = yield* readAllowlist
    if (allowlist.files.length === 0) return []
    const drive = yield* Drive
    const byId = new Map((yield* drive.listAll).map((item) => [item.id, item]))
    return allowlist.files.map((entry) => {
      const item = byId.get(entry.id)
      return item === undefined
        ? { id: entry.id, missing: true as const }
        : { id: entry.id, missing: false as const, item }
    })
  }),
  ingest: (allowed) => {
    if (allowed.missing) {
      return Effect.fail(new Error(`allowlisted file ${allowed.id} is not visible to the Drive credential`))
    }
    const item = allowed.item
    return Effect.gen(function*() {
      const drive = yield* Drive
      const transloadit = yield* TransloaditNormalize
      if (!transloadit.configured) {
        return yield* Effect.fail(new Error(
          `allowlisted Drive file ${item.id} requires configured Transloadit remote ingest; refusing to download it to this host`
        ))
      }
      const result = yield* transloadit.ingestDrive(DRIVE_ALLOW_SOURCE, {
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        modifiedTime: item.modifiedTime,
        ...(item.md5Checksum === undefined ? {} : { checksum: item.md5Checksum })
      }, drive.importRequest(item.id))
      return result === "cached" ? "cached" as const
        : result === "pending" ? "skipped" as const
        : "ingested" as const
    })
  },
  label: (allowed) => allowed.missing ? allowed.id : `${allowed.item.name} (${allowed.id})`,
  // Keep starts/polls serial so an allowlist pass makes bounded, predictable
  // vendor/API progress regardless of the size of the remote recordings.
  concurrency: 1
})
