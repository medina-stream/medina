/**
 * Media normalization: probe once, transcode once, never read the original
 * bytes again.
 *
 * Capture stays uninterpreted (bytes + provenance). These stages sit between
 * capture and transcription:
 *
 * - Probe: `ffprobe` runs once per capture and its complete JSON output is
 *   stored losslessly at `capture/<id>/ffprobe.json` -- beside the blob, so
 *   the archive sweep makes it durable and any host can know what a
 *   multi-gigabyte WAV *is* without reading it. A capture id is a content
 *   hash, so the answer can never change; a probe that found no media is
 *   recorded too, and never re-asked. Interpretation of what the probe saw
 *   (creation_time tags, durations) belongs downstream, to attribution.
 *
 * - Normalize: any capture whose probe shows an audio stream -- audio files,
 *   video files, whatever a capturer was rude enough to upload -- is
 *   transcoded once to a canonical form: mono 16 kHz Opus (voice-ranged
 *   bitrate), segmented into bounded chunks, with a manifest recording each
 *   chunk's offset. Chunks are derivation artifacts under a versioned key
 *   (`media/<version>/<captureId>/`); the manifest's existence is the
 *   freshness check. After this the original blob is never read again --
 *   transcription and playback consume chunks.
 *
 * - Transcribe: consumes manifests, not blobs. Each chunk is transcribed
 *   separately and the utterances merged with cumulative offsets into one
 *   `Transcript` per capture, identical in shape to the single-file case,
 *   so attribution, day indexing and journals need no changes.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { AssemblyAI } from "../AssemblyAI.ts"
import { Bucket } from "../Bucket.ts"
import * as Files from "../Files.ts"
import type { Source } from "../Resource.ts"
import { makeItemSource } from "../Source.ts"
import { TransloaditNormalize } from "./TransloaditNormalize.ts"
import {
  captureDir,
  dataPath,
  filenameWallClock,
  Provenance,
  provenanceKey,
  Transcript,
  TRANSCRIPT_VERSION,
  transcriptKey,
  vendorKey
} from "../lifelog/Resources.ts"

export const MEDIA_VERSION = "media-v1"
/** Chunk length. One hour of mono 16k Opus is ~11 MB: comfortably within
 * any transcription provider's upload limits, big enough that a full day
 * is a handful of requests. */
export const CHUNK_SECONDS = 3600

export const ffprobeKey = (captureId: string) => `${captureDir(captureId)}/ffprobe.json`
export const mediaManifestKey = (captureId: string) => `media/${MEDIA_VERSION}/${captureId}.json`
export const mediaChunkKey = (captureId: string, index: number) =>
  `media/${MEDIA_VERSION}/${captureId}/chunk-${String(index).padStart(3, "0")}.ogg`
export const canonicalMediaKey = (captureId: string) =>
  `media/${MEDIA_VERSION}/${captureId}/canonical.ogg`

/** The stored probe: ffprobe's own JSON, lossless, plus a tiny envelope.
 * `media` is the one interpreted bit -- whether an audio stream exists --
 * because it decides membership in the normalize pipeline. */
export class ProbeRecord extends Schema.Class<ProbeRecord>("ProbeRecord")({
  captureId: Schema.String,
  probedAt: Schema.String,
  blobName: Schema.NullOr(Schema.String),
  media: Schema.Boolean,
  /** Raw `ffprobe -show_format -show_streams -show_chapters` output, or
   * `{ error }` when ffprobe rejected the bytes (not media at all). */
  ffprobe: Schema.Unknown
}) {}

export class MediaChunk extends Schema.Class<MediaChunk>("MediaChunk")({
  index: Schema.Number,
  key: Schema.String,
  startSeconds: Schema.Number,
  durationSeconds: Schema.Number
}) {}

export class MediaManifest extends Schema.Class<MediaManifest>("MediaManifest")({
  captureId: Schema.String,
  version: Schema.String,
  createdAt: Schema.String,
  sourceDurationSeconds: Schema.NullOr(Schema.Number),
  chunks: Schema.Array(MediaChunk)
}) {}

const METADATA_NAMES = new Set(["provenance.json", "media-timing.json", "ffprobe.json"])

const run = (command: ReadonlyArray<string>): Effect.Effect<{ ok: boolean; stdout: string; stderr: string }, Error> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ])
      return { ok: code === 0, stdout, stderr }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
  })

/** The capture's blob on disk: the one file that is not pipeline metadata. */
export const blobPathFor = (captureId: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = dataPath(captureDir(captureId))
    if (!(yield* fs.exists(dir))) return null
    const names = yield* fs.readDirectory(dir)
    const name = names.find((candidate) => !METADATA_NAMES.has(candidate) && !/\.tmp-[^/]*$/.test(candidate))
    return name === undefined ? null : { name, path: `${dir}/${name}` }
  }).pipe(
    Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause))))
  )

const hasAudioStream = (probe: unknown): boolean => {
  const streams = (probe as { streams?: Array<{ codec_type?: string }> }).streams
  return Array.isArray(streams) && streams.some((stream) => stream.codec_type === "audio")
}

const probeDuration = (probe: unknown): number | null => {
  const duration = Number((probe as { format?: { duration?: string } }).format?.duration)
  return Number.isFinite(duration) && duration > 0 ? duration : null
}

/**
 * The capture's probe record, probing on first ask. Immutable bytes mean
 * the result is cached forever; ffprobe rejecting the file is itself the
 * (cached) answer "not media".
 */
export const probeCapture = (captureId: string) =>
  Effect.gen(function*() {
    const existing = yield* Files.readJson(ProbeRecord, dataPath(ffprobeKey(captureId))).pipe(
      Effect.orElseSucceed(() => Option.none<ProbeRecord>())
    )
    if (Option.isSome(existing)) return existing.value

    const blob = yield* blobPathFor(captureId)
    const result = blob === null
      ? null
      : yield* run([
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        blob.path
      ])

    const ffprobe = result === null
      ? { error: "no blob on disk" }
      : result.ok
        ? (JSON.parse(result.stdout) as unknown)
        : { error: result.stderr.slice(0, 2000) }
    const record = new ProbeRecord({
      captureId,
      probedAt: new Date().toISOString(),
      blobName: blob?.name ?? null,
      media: result !== null && result.ok && hasAudioStream(ffprobe),
      ffprobe
    })
    // A missing blob is the one non-final answer: legacy captures kept no
    // audio, and a blob may land later. Everything else is cached forever.
    if (blob !== null) {
      yield* Files.writeJson(dataPath(ffprobeKey(captureId)), record)
    }
    return record
  })

/**
 * Transcode one media capture to canonical chunks and write its manifest.
 * The manifest is written last, so a crashed transcode is invisible and
 * simply redone. Chunk offsets are measured from the encoded chunks
 * themselves (cheap local probes), not assumed from the segment size.
 */
export const segmentToChunks = (
  captureId: string,
  sourcePath: string,
  options: { readonly copy?: boolean; readonly sourceDurationSeconds?: number | null } = {}
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const tmpDir = dataPath(`tmp/media-${captureId.slice(0, 12)}-${Date.now()}`)
    yield* fs.makeDirectory(tmpDir, { recursive: true })
    const cleanup = fs.remove(tmpDir, { recursive: true, force: true }).pipe(Effect.ignore)
    const command = options.copy
      ? ["ffmpeg", "-nostdin", "-v", "error", "-i", sourcePath, "-c", "copy", "-f", "segment", "-segment_time", `${CHUNK_SECONDS}`, "-reset_timestamps", "1", `${tmpDir}/chunk-%03d.ogg`]
      : ["ffmpeg", "-nostdin", "-v", "error", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "segment", "-segment_time", `${CHUNK_SECONDS}`, "-reset_timestamps", "1", `${tmpDir}/chunk-%03d.ogg`]
    const encoded = yield* run(command).pipe(Effect.onError(() => cleanup))
    if (!encoded.ok) {
      yield* cleanup
      return yield* Effect.fail(new Error(`ffmpeg failed for ${captureId}: ${encoded.stderr.slice(0, 500)}`))
    }
    const names = (yield* fs.readDirectory(tmpDir).pipe(Effect.mapError((cause) => new Error(String(cause)))))
      .filter((name) => /^chunk-\d+\.ogg$/.test(name)).sort()
    if (names.length === 0) {
      yield* cleanup
      return yield* Effect.fail(new Error(`ffmpeg produced no chunks for ${captureId}`))
    }
    const chunks: Array<MediaChunk> = []
    let offset = 0
    const outputDir = dataPath(`media/${MEDIA_VERSION}/${captureId}`)
    yield* fs.makeDirectory(outputDir, { recursive: true })
    for (const [index, name] of names.entries()) {
      const probed = yield* run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", `${tmpDir}/${name}`])
      const duration = probed.ok ? probeDuration(JSON.parse(probed.stdout)) : null
      if (duration === null) {
        yield* cleanup
        return yield* Effect.fail(new Error(`could not determine duration for ${captureId} chunk ${index}`))
      }
      const key = mediaChunkKey(captureId, index)
      yield* fs.rename(`${tmpDir}/${name}`, dataPath(key)).pipe(Effect.mapError((cause) => new Error(String(cause))))
      chunks.push(new MediaChunk({ index, key, startSeconds: offset, durationSeconds: duration }))
      offset += duration
    }
    yield* cleanup
    const manifest = new MediaManifest({
      captureId,
      version: MEDIA_VERSION,
      createdAt: new Date().toISOString(),
      sourceDurationSeconds: options.sourceDurationSeconds ?? null,
      chunks
    })
    yield* Files.writeJson(dataPath(mediaManifestKey(captureId)), manifest)
    return manifest
  })

/** Transcode a local capture to canonical chunks. */
export const normalizeCapture = (captureId: string) =>
  Effect.gen(function*() {
    const blob = yield* blobPathFor(captureId)
    if (blob === null) return yield* Effect.fail(new Error(`no blob on disk for capture ${captureId}`))
    const probe = yield* probeCapture(captureId)
    return yield* segmentToChunks(captureId, blob.path, { sourceDurationSeconds: probeDuration(probe.ffprobe) })
  })

const captureIds = Effect.gen(function*() {
  const entries = yield* Files.listFiles(dataPath("capture"))
  return [...new Set(entries.map((entry) => entry.split("/")[0]!))].sort()
})

/**
 * Probe + normalize as a pipeline stage. Every capture is probed once;
 * every media capture is transcoded once. Settled captures cost one probe
 * read and one manifest existence check per pass.
 */
export const mediaNormalizeSource: Source<FileSystem.FileSystem | TransloaditNormalize | Bucket> = makeItemSource({
  name: "media-normalize",
  discover: captureIds,
  ingest: (captureId) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const probe = yield* probeCapture(captureId)
      if (!probe.media) return "skipped" as const
      if (yield* fs.exists(dataPath(mediaManifestKey(captureId)))) return "cached" as const
      const transloadit = yield* TransloaditNormalize
      if (transloadit.configured) {
        if (probe.blobName === null) return yield* Effect.fail(new Error(`no blob name for media capture ${captureId}`))
        const result = yield* transloadit.normalize(captureId, probe.blobName, probeDuration(probe.ffprobe))
        return result === "pending" ? "skipped" as const : "ingested" as const
      }
      yield* normalizeCapture(captureId)
      return "ingested" as const
    }),
  label: (captureId) => `capture/${captureId}`,
  concurrency: 1 // ffmpeg saturates a core; parallel encodes just thrash
})

/** Merge chunk transcripts into one Transcript, offsetting each utterance
 * by its chunk's start. Chunk boundaries can split an utterance in two;
 * that is accepted — offsets stay exact and nothing is lost. */
export const mergeChunkTranscripts = (
  captureId: string,
  manifest: MediaManifest,
  capturedAt: string | null,
  parts: ReadonlyArray<{
    readonly chunk: MediaChunk
    readonly utterances: ReadonlyArray<{
      readonly speaker: string | null
      readonly startMs: number
      readonly endMs: number
      readonly text: string
      readonly confidence: number | null
    }>
    readonly text: string | null
    readonly transcriptId: string | null
    readonly error: string | null
  }>
): Transcript => {
  const failed = parts.find((part) => part.error !== null)
  return new Transcript({
    provider: "assemblyai",
    version: TRANSCRIPT_VERSION,
    ingestId: captureId,
    inputKey: mediaManifestKey(captureId),
    ...(capturedAt === null ? {} : { capturedAt }),
    transcriptId: parts.map((part) => part.transcriptId ?? "").join(","),
    vendorKey: vendorKey(captureId),
    status: failed === undefined ? "completed" : "error",
    completedAt: new Date().toISOString(),
    text: parts.map((part) => part.text ?? "").filter(Boolean).join("\n") || null,
    utterances: parts.flatMap((part) =>
      part.utterances.map((utterance) => ({
        speaker: utterance.speaker,
        startMs: utterance.startMs + Math.round(part.chunk.startSeconds * 1000),
        endMs: utterance.endMs + Math.round(part.chunk.startSeconds * 1000),
        text: utterance.text,
        confidence: utterance.confidence
      }))
    ),
    error: failed?.error ?? null
  })
}

/**
 * Transcription as a stage over manifests: normalized chunks in, one
 * merged transcript per capture out. Never touches original blobs. The
 * existing transcript key gates re-work, so captures transcribed under the
 * old inline path are simply cached here.
 */
export const mediaTranscribeSource: Source<AssemblyAI | FileSystem.FileSystem> = makeItemSource({
  name: "media-transcribe",
  discover: Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* Files.listFiles(dataPath(`media/${MEDIA_VERSION}`))
    const manifests = entries.filter((entry) => entry.endsWith(".json") && !entry.includes("/"))
    const pending: Array<string> = []
    for (const manifest of manifests) {
      const captureId = manifest.slice(0, -".json".length)
      if (!(yield* fs.exists(dataPath(transcriptKey(captureId))))) pending.push(captureId)
    }
    return pending
  }),
  ingest: (captureId) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const assemblyai = yield* AssemblyAI
      const manifest = Option.getOrNull(
        yield* Files.readJson(MediaManifest, dataPath(mediaManifestKey(captureId)))
      )
      if (manifest === null) return yield* Effect.fail(new Error(`manifest vanished for ${captureId}`))

      const parts = []
      const raws: Array<unknown> = []
      for (const chunk of manifest.chunks) {
        yield* Effect.log(
          `transcribing ${captureId.slice(0, 12)} chunk ${chunk.index + 1}/${manifest.chunks.length}`
        )
        const audio = fs.stream(dataPath(chunk.key)).pipe(
          Stream.mapError((cause) => new Error(String(cause)))
        )
        const result = yield* assemblyai.transcribe(audio)
        raws.push(result.raw)
        parts.push({
          chunk,
          utterances: (result.transcript.utterances ?? []).map((utterance) => ({
            speaker: utterance.speaker ?? null,
            startMs: utterance.start,
            endMs: utterance.end,
            text: utterance.text,
            confidence: utterance.confidence ?? null
          })),
          text: result.transcript.text ?? null,
          transcriptId: result.transcript.id ?? null,
          error: result.transcript.error ?? null
        })
      }

      // The filename stamp, when provenance kept one, is a capture-time
      // hint for legacy attribution paths; container evidence supersedes it.
      const provenance = yield* Files.readJson(Provenance, dataPath(provenanceKey(captureId))).pipe(
        Effect.orElseSucceed(() => Option.none<Provenance>())
      )
      const filename = Option.isSome(provenance) ? provenance.value.records[0]?.filename ?? null : null
      const capturedAt = filename === null ? null : filenameWallClock(filename)

      yield* Files.writeJson(dataPath(vendorKey(captureId)), { chunked: true, chunks: raws })
      yield* Files.writeJson(
        dataPath(transcriptKey(captureId)),
        mergeChunkTranscripts(captureId, manifest, capturedAt, parts)
      )
      return "ingested" as const
    }),
  label: (captureId) => `capture/${captureId}`,
  concurrency: 1
})
