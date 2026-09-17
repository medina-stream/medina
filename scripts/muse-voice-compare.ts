import { BunHttpClient, BunServices } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Files from "../lib/Files.ts"
import * as R2TempCreds from "../lib/R2TempCreds.ts"
import {
  MEDIA_VERSION,
  mediaManifestKey,
  MediaManifest,
  type TranscriptChunkPart
} from "../lib/capture/Media.ts"
import {
  dataPath,
  filenameWallClock,
  Provenance,
  provenanceKey
} from "../lib/lifelog/Resources.ts"
import { MuseVoice, layer as MuseVoiceLayer } from "../lib/transcribe/MuseVoice.ts"
import {
  COMPARE_VERSION,
  CompareChunkJob,
  CompareJobReceipt,
  compareJobsKey,
  compareRawKey,
  compareTranscriptKey,
  formatSummary,
  inWindow,
  mergeCompareTranscript,
  parseCompareArgs,
  type CompareSummary
} from "../lib/transcribe/Compare.ts"

/**
 * Parallel-comparison harness: run Meta Muse Voice Transcribe over the same
 * audio the production pipeline already sent to AssemblyAI, bounded to an
 * explicit capture-time window, and compare the results side by side.
 *
 * Production is untouched: no production keys are read for writing, and all
 * output lands under transcript-compare/<version>/. Each capture is isolated —
 * one failure is recorded in the summary and the run continues.
 *
 *   bun scripts/muse-voice-compare.ts --start 2026-09-16T00:00:00 --end 2026-09-16T12:00:00
 *
 * Window bounds are capture-local wall clock (device filenames carry no zone).
 * Flags: --limit N (cap captures), --submit-only, --poll-only (resume a run).
 * Requires MODEL_API_KEY plus the usual R2 temp-credential env.
 */
const POLL_ATTEMPTS = 180
const POLL_DELAY_MS = 10_000

const args = parseCompareArgs(process.argv.slice(2))

const downloadBytes = (url: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`chunk download failed: HTTP ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
  })

interface EligibleCapture {
  readonly captureId: string
  readonly manifest: MediaManifest
  readonly capturedAt: string | null
  readonly audioSeconds: number
}

const discoverEligible = Effect.gen(function*() {
  const entries = yield* Files.listFiles(dataPath(`media/${MEDIA_VERSION}`))
  const manifests = entries.filter((entry) => entry.endsWith(".json") && !entry.includes("/"))
  const eligible: Array<EligibleCapture> = []
  for (const name of manifests) {
    const captureId = name.slice(0, -".json".length)
    const manifest = Option.getOrNull(yield* Files.readJson(MediaManifest, dataPath(mediaManifestKey(captureId))))
    if (manifest === null || manifest.chunks.length === 0) continue
    const provenance = yield* Files.readJson(Provenance, dataPath(provenanceKey(captureId))).pipe(
      Effect.orElseSucceed(() => Option.none<Provenance>())
    )
    const filename = Option.isSome(provenance) ? provenance.value.records[0]?.filename ?? null : null
    const capturedAt = filename === null ? null : filenameWallClock(filename)
    if (!inWindow(capturedAt, args.start, args.end)) continue
    eligible.push({
      captureId,
      manifest,
      capturedAt,
      audioSeconds: manifest.chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0)
    })
  }
  eligible.sort((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""))
  return args.limit === null ? eligible : eligible.slice(0, args.limit)
})

const submitCapture = (capture: EligibleCapture) =>
  Effect.gen(function*() {
    const r2 = yield* R2TempCreds.R2TempCreds
    const muse = yield* MuseVoice
    const receiptPath = dataPath(compareJobsKey(capture.captureId))
    const jobs: Array<CompareChunkJob> = []
    for (const chunk of capture.manifest.chunks) {
      const label = `${capture.captureId.slice(0, 12)} chunk ${chunk.index + 1}/${capture.manifest.chunks.length}`
      yield* Effect.log(`muse-voice-compare: submitting ${label}`)
      const audioUrl = yield* r2.presignGet(chunk.key, 2 * 60 * 60)
      const bytes = yield* downloadBytes(audioUrl)
      const result = yield* muse.submit({
        _tag: "file",
        bytes,
        filename: `chunk-${String(chunk.index).padStart(3, "0")}.ogg`,
        contentType: "audio/ogg"
      })
      jobs.push(new CompareChunkJob({
        index: chunk.index,
        key: chunk.key,
        transcriptId: result.transcript.id,
        status: result.transcript.status,
        submittedAt: new Date().toISOString()
      }))
      // Commit after every accepted job so a later failure never resubmits.
      yield* Files.writeJson(receiptPath, new CompareJobReceipt({
        captureId: capture.captureId,
        version: COMPARE_VERSION,
        windowStart: args.start,
        windowEnd: args.end,
        chunks: jobs
      }))
    }
    return jobs
  })

const pollCapture = (capture: EligibleCapture, jobs: ReadonlyArray<CompareChunkJob>) =>
  Effect.gen(function*() {
    const muse = yield* MuseVoice
    const receiptPath = dataPath(compareJobsKey(capture.captureId))
    const raws: Array<unknown> = []
    const parts: Array<TranscriptChunkPart> = []
    const seen = jobs.map((job) => ({ ...job }))
    for (const [position, job] of seen.entries()) {
      const label = `${capture.captureId.slice(0, 12)} chunk ${job.index + 1}/${seen.length}`
      let result = yield* muse.poll(job.transcriptId)
      for (let attempt = 1; result.transcript.status === "queued" || result.transcript.status === "processing"; attempt++) {
        if (attempt > POLL_ATTEMPTS) {
          return yield* Effect.fail(new Error(`poll timed out for ${label} after ${POLL_ATTEMPTS} attempts`))
        }
        if (attempt % 6 === 1) yield* Effect.log(`muse-voice-compare: polling ${label} (${result.transcript.status})`)
        yield* Effect.sleep(POLL_DELAY_MS)
        result = yield* muse.poll(job.transcriptId)
      }
      seen[position] = new CompareChunkJob({ ...job, status: result.transcript.status })
      yield* Files.writeJson(receiptPath, new CompareJobReceipt({
        captureId: capture.captureId,
        version: COMPARE_VERSION,
        windowStart: args.start,
        windowEnd: args.end,
        chunks: seen.map((entry) => new CompareChunkJob(entry))
      }))
      const chunk = capture.manifest.chunks[position]!
      raws.push(result.raw)
      parts.push({
        chunk,
        // Vendor timestamps are milliseconds from the chunk start; the exact
        // unit rides on the pending wire format (see MuseVoice.ts).
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
          ? result.transcript.error ?? "Muse Voice transcription failed"
          : result.transcript.error ?? null
      })
    }
    yield* Files.writeJson(dataPath(compareRawKey(capture.captureId)), { chunked: true, chunks: raws })
    yield* Files.writeJson(
      dataPath(compareTranscriptKey(capture.captureId)),
      mergeCompareTranscript(capture.captureId, capture.capturedAt, parts)
    )
  })

const program = Effect.gen(function*() {
  const r2 = yield* R2TempCreds.R2TempCreds
  if (!r2.configured) {
    return yield* Effect.fail(new Error(
      "R2 temp credentials are not configured: set R2_ACCOUNT_ID and R2_PARENT_ACCESS_KEY_ID " +
      "(the chunk bytes are fetched through presigned URLs, exactly like the production path)"
    ))
  }
  const eligible = yield* discoverEligible
  yield* Effect.log(`muse-voice-compare: ${eligible.length} capture(s) in window`)
  let submitted = 0
  let completed = 0
  let failed = 0
  let audioSeconds = 0
  for (const capture of eligible) {
    const receiptPath = dataPath(compareJobsKey(capture.captureId))
    const existing = Option.getOrNull(yield* Files.readJson(CompareJobReceipt, receiptPath))
    const outcome = yield* Effect.gen(function*() {
      let jobs = existing?.chunks ?? []
      if (!args.pollOnly && existing === null) {
        jobs = yield* submitCapture(capture)
        submitted++
      } else if (!args.pollOnly && existing !== null) {
        yield* Effect.log(`muse-voice-compare: resuming ${capture.captureId.slice(0, 12)} from existing receipt`)
      }
      if (!args.submitOnly) {
        if (jobs.length !== capture.manifest.chunks.length) {
          return yield* Effect.fail(new Error(
            `receipt covers ${jobs.length}/${capture.manifest.chunks.length} chunks; rerun without --poll-only to finish submitting`
          ))
        }
        yield* pollCapture(capture, jobs)
        completed++
        audioSeconds += capture.audioSeconds
      }
    }).pipe(
      Effect.as("ok" as const),
      Effect.catchAll((cause) => Effect.gen(function*() {
        failed++
        yield* Effect.logError(`muse-voice-compare: ${capture.captureId.slice(0, 12)} failed: ${cause.message}`)
        return "failed" as const
      }))
    )
    void outcome
  }
  const summary: CompareSummary = {
    windowStart: args.start,
    windowEnd: args.end,
    capturesInWindow: eligible.length,
    submitted,
    completed,
    failed,
    audioSeconds
  }
  yield* Effect.log(`\n${formatSummary(summary)}`)
})

const Live = Layer.mergeAll(MuseVoiceLayer, R2TempCreds.layer).pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer)
)

await Effect.runPromise(Effect.provide(program, Live)).catch((cause) => {
  console.error(cause instanceof Error ? cause.message : cause)
  process.exit(1)
})
