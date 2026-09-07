/**
 * Probing a capture's container for its recording time, cached.
 *
 * A capture id is a content hash, so the answer can never change: probe
 * once, write the result beside the blob, and read it thereafter. A probe
 * that found nothing is recorded too (all fields null), so files without
 * usable metadata are not re-probed on every pass.
 *
 * Only the blob on local disk is probed today. `Mp4.httpRangeReader` exists
 * so the same few-hundred-byte read can be done against a remote archive
 * without downloading it, which is what makes dating a multi-gigabyte
 * backlog feasible.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Files from "../Files.ts"
import { fileReader, probeMp4Timing } from "../Mp4.ts"
import { captureDir, dataPath, MediaTiming, mediaTimingKey } from "./Resources.ts"

/** Extensions worth probing: containers whose `mvhd` we can read. */
const PROBABLE = /\.(m4a|mp4|m4v|mov|aac)$/i

/**
 * The capture's audio blob, if one is on disk. Legacy captures kept no
 * audio, so this is routinely absent.
 */
const blobPath = (captureId: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = dataPath(captureDir(captureId))
    if (!(yield* fs.exists(dir))) return null
    const names = yield* fs.readDirectory(dir)
    const name = names.find((candidate) => PROBABLE.test(candidate))
    return name ? `${dir}/${name}` : null
  }).pipe(Effect.orElseSucceed(() => null))

/**
 * Container timing for a capture, probing and caching on first ask.
 *
 * Never fails: a missing blob, an unreadable one, or a container without
 * `mvhd` all resolve to an absence of evidence for the caller to fall back
 * from.
 */
export const mediaTimingFor = (captureId: string) =>
  Effect.gen(function*() {
    const key = mediaTimingKey(captureId)
    const cached = yield* Files.readJson(MediaTiming, dataPath(key)).pipe(
      Effect.orElseSucceed(() => Option.none<MediaTiming>())
    )
    if (Option.isSome(cached)) return cached.value

    const path = yield* blobPath(captureId)
    const timing = path === null
      ? null
      : yield* probeMp4Timing(fileReader(path)).pipe(Effect.orElseSucceed(() => null))

    const record = new MediaTiming({
      captureId,
      probedAt: new Date().toISOString(),
      createdAt: timing?.createdAt ?? null,
      durationSeconds: timing?.durationSeconds ?? null,
      startedAt: timing?.startedAt ?? null
    })
    // Cache the absence too: without a blob there is nothing to re-probe,
    // and with one the bytes are immutable under a content-addressed id.
    if (path !== null || timing !== null) {
      yield* Files.writeJson(dataPath(key), record).pipe(Effect.orElseSucceed(() => undefined))
    }
    return record
  })
