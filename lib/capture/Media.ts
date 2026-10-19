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
 *   chunk's offset. Captures already in canonical-ish form (compact codec,
 *   mono 16 kHz, within one chunk -- i.e. the recorder app's output) skip
 *   this entirely: the archived original *is* the chunk. Chunk bytes live durably in R2; local normalization may
 *   create a temporary/local copy first, but it is uploaded before the
 *   manifest is considered settled. After this the original blob is never
 *   read again -- transcription consumes signed chunk URLs.
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
import { AssemblyAI } from "../AssemblyAI.ts"
import { Bucket } from "../Bucket.ts"
import * as Files from "../Files.ts"
import { R2TempCreds } from "../R2TempCreds.ts"
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
/** Span length for captures too long to transcribe as one job. Four hours:
 * long spans keep speaker diarization coherent across a day-long lifelog
 * file and put few seams in the merged transcript. The cost of a span is
 * its blast radius when a job fails — and since per-chunk settling, a
 * failed span is dropped rather than re-bought, so the radius is one
 * span's transcript, never the file's spend. Silence inside a span is the
 * provider's problem: billing is per submitted duration, so client-side
 * silence skipping was considered and deliberately not built. Fresh
 * captures never reach this — phone segments are minutes long and the
 * archived original is the chunk (see directChunkFor). */
export const CHUNK_SECONDS = 14400

/** The direct path's ceiling, deliberately NOT CHUNK_SECONDS: a direct
 * capture becomes a single transcription job in its source form, and one
 * hour is the most audio one unsegmented job should carry. Longer
 * canonical-form captures still segment into spans, so every span carries
 * its own transcription receipt. */
const DIRECT_CHUNK_MAX_SECONDS = 3600

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

export const transcriptJobsKey = (captureId: string) =>
  `transcript/${TRANSCRIPT_VERSION}/${captureId}.jobs.json`

/** Marker written when a capture's transcription settles as errored (every
 * chunk failed for a real reason). Discovery skips settled captures: their
 * AssemblyAI jobs are terminal, and re-queuing would resubmit — and
 * re-buy — them on every pass. Requeue manually by deleting this marker,
 * the jobs receipt, and any canonical transcript for the capture. */
export const transcriptSettledKey = (captureId: string) =>
  `transcribe-settled/${TRANSCRIPT_VERSION}/${captureId}.json`

/** AssemblyAI refuses language detection on audio with no spoken audio.
 * That is a property of the audio, not a transient failure: the chunk is
 * silence, and its transcript is empty by definition. */
const isNoSpokenAudioError = (error: string | null): boolean =>
  error !== null && error.toLowerCase().includes("no spoken audio")

export class TranscriptChunkJob extends Schema.Class<TranscriptChunkJob>("TranscriptChunkJob")({
  index: Schema.Number,
  key: Schema.String,
  transcriptId: Schema.String,
  submittedAt: Schema.String
}) {}

export class TranscriptJobReceipt extends Schema.Class<TranscriptJobReceipt>("TranscriptJobReceipt")({
  captureId: Schema.String,
  version: Schema.String,
  chunks: Schema.Array(TranscriptChunkJob)
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

/** Codecs compact enough that re-encoding buys transcription nothing: the
 * canonical codec itself, plus what the recorder app emits. */
const DIRECT_CODECS = new Set(["opus", "aac"])

export interface DirectChunk {
  readonly durationSeconds: number
}

/**
 * Whether the probed bytes are already in canonical-ish form -- a compact
 * speech codec, mono 16 kHz, no longer than one hour. Such captures skip
 * the transcode/split entirely: the archived original *is* the chunk, and
 * the manifest points at it. Returns null for anything else (multi-hour
 * captures, video, lossless uploads), which keeps the old path.
 */
export const directChunkFor = (probe: unknown): DirectChunk | null => {
  const ffprobe = probe as {
    streams?: Array<{ codec_type?: string; codec_name?: string; channels?: number; sample_rate?: string }>
  }
  const audio = ffprobe.streams?.find((stream) => stream.codec_type === "audio")
  if (audio === undefined) return null
  if (!DIRECT_CODECS.has(audio.codec_name ?? "")) return null
  if (audio.channels !== 1 || audio.sample_rate !== "16000") return null
  const duration = probeDuration(probe)
  if (duration === null || duration > DIRECT_CHUNK_MAX_SECONDS) return null
  return { durationSeconds: duration }
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

const ensureManifestChunksInR2 = (manifest: MediaManifest) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const bucket = yield* Bucket
    if (!bucket.configured) {
      return yield* Effect.fail(new Error("R2 bucket is required before media chunks can be transcribed"))
    }
    let uploaded = 0
    for (const chunk of manifest.chunks) {
      const remote = yield* bucket.head(chunk.key)
      if (remote !== null && remote.size !== null && remote.size > 0) continue
      const local = dataPath(chunk.key)
      if (!(yield* fs.exists(local))) {
        return yield* Effect.fail(new Error(`media chunk is missing from R2 and local storage: ${chunk.key}`))
      }
      yield* bucket.putFile(chunk.key, local, "audio/ogg")
      uploaded++
    }
    return uploaded
  })

/**
 * Probe + normalize as a pipeline stage. Every capture is probed once;
 * captures already in canonical-ish form (the recorder app's AAC) skip
 * transcode/split and point a one-chunk manifest at the archived original.
 * Everything else goes through the transcode path as before. Settled
 * captures cost one probe read and one manifest existence check per pass.
 *
 * Unbounded: nothing here is CPU-bound -- ffprobe is milliseconds, and the
 * heavy work (Transloadit assemblies, AssemblyAI transcripts) happens in
 * the cloud. Let it chew in parallel.
 */
export const mediaNormalizeSource: Source<FileSystem.FileSystem | TransloaditNormalize | Bucket> = makeItemSource({
  name: "media-normalize",
  discover: captureIds,
  ingest: (captureId) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const probe = yield* probeCapture(captureId)
      if (!probe.media) return "skipped" as const
      if (yield* fs.exists(dataPath(mediaManifestKey(captureId)))) {
        const stored = Option.getOrNull(yield* Files.readJson(MediaManifest, dataPath(mediaManifestKey(captureId))))
        if (stored === null) return yield* Effect.fail(new Error(`manifest vanished for ${captureId}`))
        return (yield* ensureManifestChunksInR2(stored)) > 0 ? "ingested" as const : "cached" as const
      }
      const direct = directChunkFor(probe.ffprobe)
      if (direct !== null) {
        if (probe.blobName === null) return yield* Effect.fail(new Error(`no blob name for media capture ${captureId}`))
        // The archive sweep runs before this stage, so the original is
        // already the durable R2 object; the manifest points at it directly.
        const key = `${captureDir(captureId)}/${probe.blobName}`
        const manifest = new MediaManifest({
          captureId,
          version: MEDIA_VERSION,
          createdAt: new Date().toISOString(),
          sourceDurationSeconds: direct.durationSeconds,
          chunks: [new MediaChunk({ index: 0, key, startSeconds: 0, durationSeconds: direct.durationSeconds })]
        })
        yield* Files.writeJson(dataPath(mediaManifestKey(captureId)), manifest)
        yield* ensureManifestChunksInR2(manifest)
        return "ingested" as const
      }
      const transloadit = yield* TransloaditNormalize
      if (transloadit.configured) {
        if (probe.blobName === null) return yield* Effect.fail(new Error(`no blob name for media capture ${captureId}`))
        const result = yield* transloadit.normalize(captureId, probe.blobName, probeDuration(probe.ffprobe))
        return result === "pending" ? "skipped" as const : "ingested" as const
      }
      const manifest = yield* normalizeCapture(captureId)
      yield* ensureManifestChunksInR2(manifest)
      return "ingested" as const
    }),
  label: (captureId) => `capture/${captureId}`,
  concurrency: "unbounded"
})

/** One chunk's transcription result, ready to merge. Shared by the production
 * merge and the comparison harness so both apply identical offset semantics. */
export interface TranscriptChunkPart {
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
}

export interface MergedTranscriptParts {
  readonly status: "completed" | "error"
  readonly text: string | null
  readonly utterances: Array<{
    readonly speaker: string | null
    readonly startMs: number
    readonly endMs: number
    readonly text: string
    readonly confidence: number | null
  }>
  readonly transcriptId: string
  readonly error: string | null
}

/**
 * Merge per-chunk results into the shared transcript fields: joined text,
 * utterances offset by their chunk's start, joined vendor ids, and the first
 * error. Provider/version/vendorKey identity is left to the caller — the
 * production merge and the comparison harness tag their output differently.
 */
export const mergeParts = (parts: ReadonlyArray<TranscriptChunkPart>): MergedTranscriptParts => {
  const failed = parts.find((part) => part.error !== null)
  return {
    status: failed === undefined ? "completed" : "error",
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
    transcriptId: parts.map((part) => part.transcriptId ?? "").join(","),
    error: failed?.error ?? null
  }
}

/** Merge chunk transcripts into one Transcript, offsetting each utterance
 * by its chunk's start. Chunk boundaries can split an utterance in two;
 * that is accepted — offsets stay exact and nothing is lost. */
export const mergeChunkTranscripts = (
  captureId: string,
  manifest: MediaManifest,
  capturedAt: string | null,
  parts: ReadonlyArray<TranscriptChunkPart>
): Transcript => {
  const merged = mergeParts(parts)
  return new Transcript({
    provider: "assemblyai",
    version: TRANSCRIPT_VERSION,
    ingestId: captureId,
    inputKey: mediaManifestKey(captureId),
    ...(capturedAt === null ? {} : { capturedAt }),
    transcriptId: merged.transcriptId,
    vendorKey: vendorKey(captureId),
    status: merged.status,
    completedAt: new Date().toISOString(),
    text: merged.text,
    utterances: merged.utterances,
    error: merged.error
  })
}

/**
 * Transcription as a stage over manifests: R2 chunk URLs in, one merged
 * transcript per capture out. A first pass submits short-lived signed URLs
 * and persists transcript ids; later passes only poll those ids. No audio is
 * uploaded to AssemblyAI or downloaded through Medina.
 */
export const transcribeMediaCapture = (captureId: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const bucket = yield* Bucket
    const r2 = yield* R2TempCreds
    const assemblyai = yield* AssemblyAI
    if (!bucket.configured || !r2.configured) {
      return yield* Effect.fail(new Error(`R2 signed URLs are not configured for transcription of ${captureId}`))
    }
    const manifest = Option.getOrNull(
      yield* Files.readJson(MediaManifest, dataPath(mediaManifestKey(captureId)))
    )
    if (manifest === null) return yield* Effect.fail(new Error(`manifest vanished for ${captureId}`))
    if (manifest.chunks.length === 0) return yield* Effect.fail(new Error(`empty media manifest for ${captureId}`))

    // A canonical transcript left by a pre-fix run may be an error record.
    // It is not evidence: clear it up front so the capture is invisible to
    // the day index until a completed transcript lands, and so discovery
    // (which keys off transcript absence) keeps it retryable.
    const canonicalPath = dataPath(transcriptKey(captureId))
    const stale = yield* Files.readJson(Transcript, canonicalPath)
    if (Option.isSome(stale) && stale.value.status === "error") {
      yield* fs.remove(canonicalPath, { force: true })
    }

    const receiptPath = dataPath(transcriptJobsKey(captureId))
    const existing = yield* Files.readJson(TranscriptJobReceipt, receiptPath)
    if (Option.isNone(existing)) {
      const jobs: Array<TranscriptChunkJob> = []
      for (const chunk of manifest.chunks) {
        const remote = yield* bucket.head(chunk.key)
        if (remote === null || remote.size === null || remote.size <= 0) {
          return yield* Effect.fail(new Error(`R2 media chunk missing for transcription: ${chunk.key}`))
        }
        yield* Effect.log(
          `submitting ${captureId.slice(0, 12)} chunk ${chunk.index + 1}/${manifest.chunks.length}`
        )
        const audioUrl = yield* r2.presignGet(chunk.key, 2 * 60 * 60)
        const submitted = yield* assemblyai.submit({ _tag: "url", url: audioUrl })
        jobs.push(new TranscriptChunkJob({
          index: chunk.index,
          key: chunk.key,
          transcriptId: submitted.transcript.id,
          submittedAt: new Date().toISOString()
        }))
        // Commit after every accepted job: a later submission failure must
        // not duplicate the already-running AssemblyAI transcripts.
        yield* Files.writeJson(receiptPath, new TranscriptJobReceipt({
          captureId,
          version: TRANSCRIPT_VERSION,
          chunks: jobs
        }))
      }
      return "ingested" as const
    }

    const receipt = existing.value
    if (receipt.chunks.length > manifest.chunks.length || receipt.chunks.some((job, index) => {
      const chunk = manifest.chunks[index]
      return chunk === undefined || job.index !== chunk.index || job.key !== chunk.key
    })) {
      return yield* Effect.fail(new Error(`transcription receipt does not match media manifest for ${captureId}`))
    }
    if (receipt.chunks.length < manifest.chunks.length) {
      const jobs = [...receipt.chunks]
      for (const chunk of manifest.chunks.slice(jobs.length)) {
        const remote = yield* bucket.head(chunk.key)
        if (remote === null || remote.size === null || remote.size <= 0) {
          return yield* Effect.fail(new Error(`R2 media chunk missing for transcription: ${chunk.key}`))
        }
        const audioUrl = yield* r2.presignGet(chunk.key, 2 * 60 * 60)
        const submitted = yield* assemblyai.submit({ _tag: "url", url: audioUrl })
        jobs.push(new TranscriptChunkJob({
          index: chunk.index,
          key: chunk.key,
          transcriptId: submitted.transcript.id,
          submittedAt: new Date().toISOString()
        }))
        yield* Files.writeJson(receiptPath, new TranscriptJobReceipt({
          captureId,
          version: TRANSCRIPT_VERSION,
          chunks: jobs
        }))
      }
      return "ingested" as const
    }

    const results = []
    for (const [index, job] of receipt.chunks.entries()) {
      yield* Effect.log(
        `polling ${captureId.slice(0, 12)} chunk ${index + 1}/${receipt.chunks.length}`
      )
      results.push(yield* assemblyai.poll(job.transcriptId))
    }
    if (results.some((result) => result.transcript.status === "queued" || result.transcript.status === "processing")) {
      return "skipped" as const
    }

    const parts = results.map((result, index) => {
      const chunk = manifest.chunks[index]!
      return {
        chunk,
        utterances: (result.transcript.utterances ?? []).map((utterance) => ({
          speaker: utterance.speaker ?? null,
          startMs: utterance.start,
          endMs: utterance.end,
          text: utterance.text,
          confidence: utterance.confidence ?? null
        })),
        text: result.transcript.text ?? null,
        transcriptId: result.transcript.id,
        error: result.transcript.status === "error"
          ? result.transcript.error ?? "AssemblyAI transcription failed"
          : result.transcript.error ?? null
      }
    })

    const provenance = yield* Files.readJson(Provenance, dataPath(provenanceKey(captureId))).pipe(
      Effect.orElseSucceed(() => Option.none<Provenance>())
    )
    const filename = Option.isSome(provenance) ? provenance.value.records[0]?.filename ?? null : null
    const capturedAt = filename === null ? null : filenameWallClock(filename)

    // The vendor receipt is always kept for debugging, error or not.
    yield* Files.writeJson(dataPath(vendorKey(captureId)), {
      chunked: true,
      chunks: results.map((result) => result.raw)
    })
    const completedParts = parts.filter((part) => part.error === null)
    const erroredParts = parts.filter((part) => part.error !== null)
    if (erroredParts.length === 0) {
      yield* Files.writeJson(canonicalPath, mergeChunkTranscripts(captureId, manifest, capturedAt, parts))
      return "ingested" as const
    }
    if (completedParts.length > 0) {
      // Partial success settles the capture: the completed chunks are the
      // transcript, and the errored chunks are dropped (their raw vendor
      // results stay in the vendor receipt above). The previous behavior —
      // fail the whole file and delete the jobs receipt — made the next
      // pass resubmit every chunk, re-buying all the completed ones; one
      // bad chunk in a many-chunk file looped that spend indefinitely.
      yield* Effect.log(
        `settling ${captureId.slice(0, 12)} with ${completedParts.length}/${parts.length} chunks; ` +
        `dropping ${erroredParts.length} errored chunk(s): ${erroredParts[0]!.error ?? "unknown error"}`
      )
      yield* Files.writeJson(canonicalPath, mergeChunkTranscripts(captureId, manifest, capturedAt, completedParts))
      return "ingested" as const
    }
    if (erroredParts.every((part) => isNoSpokenAudioError(part.error))) {
      // No chunk has any spoken audio: the transcript is empty. Settle
      // with a completed, empty transcript instead of failing — silence
      // is a result, and resubmitting it can only fail the same way.
      yield* Files.writeJson(canonicalPath, mergeChunkTranscripts(captureId, manifest, capturedAt, []))
      return "ingested" as const
    }
    // Every chunk failed for a real reason. Settle the capture as errored:
    // write the settled marker, KEEP the jobs receipt, and fail so the
    // pipeline records the failure instead of counting a success. Do not
    // write a canonical transcript — its existence is what the day index
    // keys off, and this capture has none. Discovery skips settled
    // captures, so a fully-failed file costs nothing further; the manual
    // requeue is deleting the settled marker (see transcriptSettledKey).
    const merged = mergeChunkTranscripts(captureId, manifest, capturedAt, parts)
    yield* Files.writeJson(dataPath(transcriptSettledKey(captureId)), {
      captureId,
      error: merged.error,
      settledAt: new Date().toISOString()
    })
    return yield* Effect.fail(new Error(
      `AssemblyAI transcription failed for ${captureId}: ${merged.error ?? "unknown error"}`
    ))
  })

export const mediaTranscribeSource: Source<
  AssemblyAI | Bucket | R2TempCreds | FileSystem.FileSystem
> = makeItemSource({
  name: "media-transcribe",
  discover: Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* Files.listFiles(dataPath(`media/${MEDIA_VERSION}`))
    const manifests = entries.filter((entry) => entry.endsWith(".json") && !entry.includes("/"))
    const pending: Array<string> = []
    for (const manifest of manifests) {
      const captureId = manifest.slice(0, -".json".length)
      // Settled-errored captures are done: re-queuing them would resubmit
      // (and re-buy) AssemblyAI jobs that already failed terminally.
      if (yield* fs.exists(dataPath(transcriptSettledKey(captureId)))) continue
      const canonicalPath = dataPath(transcriptKey(captureId))
      if (!(yield* fs.exists(canonicalPath))) {
        pending.push(captureId)
        continue
      }
      // Legacy error transcripts (written before error records stopped
      // being canonical) are retryable too; a completed one is settled.
      const stored = yield* Files.readJson(Transcript, canonicalPath)
      if (Option.isSome(stored) && stored.value.status === "error") pending.push(captureId)
    }
    return pending
  }),
  ingest: transcribeMediaCapture,
  label: (captureId) => `capture/${captureId}`,
  // Bounded on purpose: submissions spend real money, so a discovery or
  // receipt bug must not be able to submit the whole backlog — and the
  // whole balance — in a single pass.
  concurrency: 8
})
