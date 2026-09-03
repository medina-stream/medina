/**
 * Attribution: per capture, the believed UTC start instant, IANA zone,
 * channel, and journal day -- guessed from evidence, overridable by a
 * correction file (`correction/<captureId>.json`).
 *
 * This is the only place that interprets source metadata. Sources record
 * what they saw; attribution decides what it means, and every belief here
 * is correctable without touching the evidence.
 */
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Files from "../lib/Files.ts"
import type { Resource } from "../lib/Resource.ts"
import { sha256 } from "./Hash.ts"
import { homeTimeZone } from "./Time.ts"
import {
  Attribution,
  ATTRIBUTION_VERSION,
  attributionKey,
  captureTime,
  CHANNEL_MAIN,
  Correction,
  correctionKey,
  dataPath,
  Provenance,
  provenanceKey,
  Transcript,
  TRANSCRIPT_VERSION,
  transcriptKey,
  Triage
} from "./Resources.ts"

/**
 * All captures that have a usable transcript, with the evidence needed to
 * attribute them. Transcript listing is the source of capture ids (legacy
 * captures have no capture/ dir).
 */
export const transcribedCaptures = Effect.gen(function*() {
  const prefix = `transcript/${TRANSCRIPT_VERSION}`
  const entries = yield* Files.listFiles(dataPath(prefix))
  return entries
    .filter((entry) => entry.endsWith(".json") && !entry.endsWith(".assemblyai.json"))
    .map((entry) => entry.replace(/\.json$/, ""))
})

/** Every correction that exists, by capture id, with the hash of its exact
 * bytes (the basis for attribution freshness and journal staleness).
 *
 * One directory listing answers for the whole corpus. Asking per capture
 * would be a round-trip each -- and corrections are rare, so nearly all of
 * those would be spent learning that no file is there.
 */
export const readCorrections = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* Files.listFiles(dataPath("correction"))
  const corrections = new Map<string, { correction: Option.Option<Correction>; hash: string }>()
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    const captureId = entry.replace(/\.json$/, "")
    const path = dataPath(correctionKey(captureId))
    const text = yield* fs.readFileString(path)
    corrections.set(captureId, { correction: yield* Files.readJson(Correction, path), hash: sha256(text) })
  }
  return corrections
}).pipe(Effect.mapError((cause) => cause instanceof Error ? cause : new Error(String(cause))))

export type Corrections = ReadonlyMap<string, { readonly correction: Option.Option<Correction>; readonly hash: string }>

const NO_CORRECTION = { correction: Option.none<Correction>(), hash: null } as const

/** One capture's correction, from a listing already in hand. */
export const correctionFor = (corrections: Corrections, captureId: string) =>
  corrections.get(captureId) ?? NO_CORRECTION

/** What attribution for one capture must be derived from: version, any
 * correction, and the home zone (zone-less evidence is interpreted in it, so
 * changing HOME_TZ after a move re-attributes -- and thus re-journals --
 * every capture whose zone belief came from the default). Evidence
 * (transcript/triage/provenance) is immutable per capture id, so it does
 * not participate. */
const attributionBasisHash = (correctionHash: string | null, homeZone: string) =>
  sha256(`${ATTRIBUTION_VERSION}\n${homeZone}\n${correctionHash ?? ""}`)

/** Best-evidence guess (or correction) for one capture. The correction is
 * passed in: callers already hold the listing they derived the basis from. */
const attributeCapture = Effect.fn("attributeCapture")(function*(
  captureId: string,
  basisHash: string,
  correction: Option.Option<Correction>
) {
  const zone = yield* homeTimeZone

  // Evidence, in descending order of directness.
  const provenance = yield* Files.readJson(Provenance, dataPath(provenanceKey(captureId)))
  const transcript = yield* Files.readJson(Transcript, dataPath(transcriptKey(captureId)))
  const triage = yield* Files.readJson(Triage, dataPath(`triage/${captureId}.json`))

  let method = "none"
  let confidence: "high" | "medium" | "low" | "none" = "none"
  let wallClock: string | null = null // naive local time, interpreted in `zone`

  const fromFilename = (filename: string, fallback: string) => {
    const stamped = captureTime(filename, fallback)
    return stamped
  }

  if (Option.isSome(provenance) && provenance.value.records.length > 0) {
    const record = provenance.value.records[0]!
    wallClock = fromFilename(record.filename, record.modifiedTime)
    method = /\d{8}T\d{6}/.test(record.filename) ? "provenance-filename-stamp" : "provenance-modified-time"
    confidence = method === "provenance-filename-stamp" ? "high" : "low"
  } else if (Option.isSome(transcript) && transcript.value.capturedAt) {
    wallClock = transcript.value.capturedAt
    method = "legacy-transcript-capturedAt"
    confidence = "medium"
  } else if (Option.isSome(triage)) {
    wallClock = captureTime(triage.value.filename, triage.value.receivedAt)
    method = "legacy-triage-filename"
    confidence = "medium"
  }

  // Wall clock in the believed zone -> UTC instant. The zone belief is the
  // home zone until better evidence (GPS) exists.
  let startUtc: string | null = null
  let day: string | null = null
  let timeZone: string | null = null
  if (wallClock) {
    const zoned = DateTime.makeZoned(wallClock, { timeZone: zone, adjustForTimeZone: true })
    if (Option.isSome(zoned)) {
      startUtc = DateTime.formatIso(DateTime.toUtc(zoned.value))
      day = DateTime.formatIsoDate(zoned.value)
      timeZone = zone
    }
  }

  // A correction overrides any guess. Its start time is a UTC instant; its
  // zone (or the belief above, or home) then determines the journal day.
  if (Option.isSome(correction)) {
    const fix = correction.value
    timeZone = fix.timeZone ?? timeZone ?? zone
    if (fix.estimatedStartTime) startUtc = fix.estimatedStartTime
    if (startUtc) {
      const zoned = DateTime.makeZoned(startUtc, { timeZone })
      if (Option.isSome(zoned)) day = DateTime.formatIsoDate(zoned.value)
    }
    method = "correction"
  }

  yield* Files.writeJson(
    dataPath(attributionKey(captureId, basisHash)),
    new Attribution({
      version: ATTRIBUTION_VERSION,
      captureId,
      channel: Option.isSome(correction) && correction.value.channel ? correction.value.channel : CHANNEL_MAIN,
      estimatedStartTime: startUtc,
      timeZone,
      day,
      method,
      confidence: method === "correction" ? "corrected" : confidence,
      attributedAt: new Date().toISOString()
    })
  )
})

type AttributionEnv = FileSystem.FileSystem

/** Eager per-capture instances; the basis hash in the key means dropping in
 * a correction stales exactly that capture's attribution. */
export const attributionResource: Resource<AttributionEnv> = {
  name: "attribution",
  instances: Effect.gen(function*() {
    const captureIds = yield* transcribedCaptures
    const zone = yield* homeTimeZone
    const corrections = yield* readCorrections
    return captureIds.map((captureId) => {
      const { correction, hash } = correctionFor(corrections, captureId)
      const basisHash = attributionBasisHash(hash, zone)
      return {
        key: attributionKey(captureId, basisHash),
        label: captureId,
        dependencies: [transcriptKey(captureId), correctionKey(captureId)],
        materialize: attributeCapture(captureId, basisHash, correction)
      }
    })
  })
}

/** Read a capture's current attribution, materializing if stale/missing.
 * The corrections listing and zone are passed in so a corpus-wide walk
 * reads the correction directory once, not once per capture. */
export const currentAttribution = Effect.fn("currentAttribution")(function*(
  captureId: string,
  corrections: Corrections,
  zone: string
) {
  const { correction, hash } = correctionFor(corrections, captureId)
  const basisHash = attributionBasisHash(hash, zone)
  const key = attributionKey(captureId, basisHash)
  const existing = yield* Files.readJson(Attribution, dataPath(key))
  if (Option.isSome(existing)) return { attribution: existing.value, correctionHash: hash }
  yield* attributeCapture(captureId, basisHash, correction)
  return {
    attribution: Option.getOrThrow(yield* Files.readJson(Attribution, dataPath(key))),
    correctionHash: hash
  }
})
