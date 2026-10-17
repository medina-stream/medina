/**
 * Stars: named intervals over the lifelog, authored by command ("star the
 * last 5 minutes") rather than derived by the pipeline.
 *
 * The authored `star/<id>.json` record is the source of truth, in the same
 * way a correction file is: everything else is a view. Two views are
 * materialized by `starsResource`:
 *
 * - a per-day view (`stars/<version>/<day>/<basisHash>.json`) resolving each
 *   star's transcript excerpt from the day index, keyed by a hash over the
 *   day's authored stars and the transcript keys they touch;
 * - for public stars, a public artifact at `public/star/<hash>.json`, where
 *   the hash is the sha256 of the artifact's canonical JSON. The public URL
 *   is just a base plus that hash and requires no auth, so the URL names a
 *   version of a moment: any edit changes the content, the hash, the URL.
 *
 * Retention is a lifetime in seconds from `createdAt` (fractional values
 * are valid), enforced by true deletion: the sweep removes the authored
 * record, and every view re-materializes without it. Zero is a supported
 * retention meaning best-effort full forget: `setStar` returns the record
 * for in-flight use but writes nothing, and the sweep treats any
 * zero-retention record it finds as already expired. That forget is an
 * honest best-effort within the system's control, not a guarantee about
 * copies outside it. Stars overlap freely — they are bookmarks with names,
 * not partitions of the day.
 *
 * Forgetting leaves a receipt: a content-free provenance record (hash and
 * timestamps only) attesting that the star existed and was forgotten on
 * schedule — so the system's forgetting is attestable rather than merely
 * asserted.
 */
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Files from "../Files.ts"
import { sha256 } from "../Hash.ts"
import type { Resource } from "../Resource.ts"
import { currentDayIndex, dayTranscripts } from "./DayIndex.ts"
import {
  dataPath,
  DayIndex,
  DAY_INDEX_VERSION,
  DEFAULT_STAR_RETENTION_SECONDS,
  PublicStar,
  publicStarKey,
  Star,
  StarForgetReceipt,
  starForgetReceiptKey,
  starKey,
  StarsDay,
  StarsDayEntry,
  starsDayKey,
  STARS_VERSION
} from "./Resources.ts"
import type { StartTimeRulesService } from "./StartTimeRules.ts"
import { homeTimeZone } from "./Time.ts"

// --- errors ------------------------------------------------------------------

export class InvalidInterval extends Schema.TaggedError<InvalidInterval>()("InvalidInterval", {
  startUtc: Schema.String,
  endUtc: Schema.String
}) {}

export class InvalidRetention extends Schema.TaggedError<InvalidRetention>()("InvalidRetention", {
  retentionSeconds: Schema.Number
}) {}

export class StarNotFound extends Schema.TaggedError<StarNotFound>()("StarNotFound", {
  id: Schema.String
}) {}

export type StarsError = InvalidInterval | InvalidRetention | StarNotFound

// --- inputs ------------------------------------------------------------------

export interface SetStarInput {
  /** Caller-chosen id; defaults to a random UUID. */
  readonly id?: string
  readonly startUtc: string
  readonly endUtc: string
  readonly name?: string | null
  readonly note?: string | null
  readonly visibility?: "private" | "public"
  /** Defaults to DEFAULT_STAR_RETENTION_SECONDS. */
  readonly retentionSeconds?: number
  /** Defaults to now. */
  readonly createdAt?: string
  readonly createdVia?: "voice" | "api"
}

export interface UpdateStarPatch {
  readonly startUtc?: string
  readonly endUtc?: string
  readonly name?: string | null
  readonly note?: string | null
  readonly visibility?: "private" | "public"
  readonly retentionSeconds?: number
}

export interface ListStarsFilter {
  /** A civil day (YYYY-MM-DD); matches stars whose interval overlaps it. */
  readonly day?: string
  /** Zone for `day`; defaults to the lifelog home zone. */
  readonly timeZone?: string
  readonly fromUtc?: string
  readonly toUtc?: string
}

// --- authored records ----------------------------------------------------------

const readAllStars: Effect.Effect<ReadonlyArray<Star>, Error, FileSystem.FileSystem> = Effect.gen(
  function*() {
    const files = yield* Files.listFiles(dataPath("star"))
    const read = yield* Effect.forEach(
      files.filter((file) => file.endsWith(".json")),
      (file) => Files.readJson(Star, dataPath(`star/${file}`))
    )
    return read
      .flatMap((star) => (Option.isSome(star) ? [star.value] : []))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }
)

/** One authored star by id, if it exists. */
export const starById = (id: string) => Files.readJson(Star, dataPath(starKey(id)))

const writeStar = (star: Star) => Files.writeJson(dataPath(starKey(star.id)), star)

const validateInterval = (startUtc: string, endUtc: string) =>
  Date.parse(endUtc) > Date.parse(startUtc)
    ? Effect.void
    : Effect.fail(new InvalidInterval({ startUtc, endUtc }))

/** Retention is any finite, non-negative number of seconds. Zero is valid
 * (best-effort full forget); only negative or non-finite values are lies
 * the record cannot keep. */
const validateRetention = (retentionSeconds: number) =>
  Number.isFinite(retentionSeconds) && retentionSeconds >= 0
    ? Effect.void
    : Effect.fail(new InvalidRetention({ retentionSeconds }))

const requireStar = (id: string) =>
  Effect.flatMap(starById(id), (star) =>
    Option.isSome(star) ? Effect.succeed(star.value) : Effect.fail(new StarNotFound({ id })))

const setStar = (input: SetStarInput) =>
  Effect.gen(function*() {
    const retentionSeconds = input.retentionSeconds ?? DEFAULT_STAR_RETENTION_SECONDS
    yield* validateInterval(input.startUtc, input.endUtc)
    yield* validateRetention(retentionSeconds)
    const star = new Star({
      id: input.id ?? crypto.randomUUID(),
      startUtc: input.startUtc,
      endUtc: input.endUtc,
      name: input.name ?? null,
      note: input.note ?? null,
      visibility: input.visibility ?? "private",
      retentionSeconds,
      createdAt: input.createdAt ?? new Date().toISOString(),
      createdVia: input.createdVia ?? "api"
    })
    // Zero retention: best-effort full forget. The caller gets the record
    // to resolve in-flight, but the star itself is not written — only its
    // content-free receipt is, so the forget is attestable.
    if (retentionSeconds > 0) {
      yield* writeStar(star)
    } else {
      yield* writeForgetReceipt(star, "zero-retention", star.createdAt, { transcriptKeys: [], excerpt: null })
    }
    return star
  })

const updateStar = (id: string, patch: UpdateStarPatch) =>
  Effect.gen(function*() {
    const current = yield* requireStar(id)
    const next = new Star({
      id: current.id,
      startUtc: patch.startUtc ?? current.startUtc,
      endUtc: patch.endUtc ?? current.endUtc,
      name: patch.name !== undefined ? patch.name : current.name,
      note: patch.note !== undefined ? patch.note : current.note,
      visibility: patch.visibility ?? current.visibility,
      retentionSeconds: patch.retentionSeconds ?? current.retentionSeconds,
      createdAt: current.createdAt,
      createdVia: current.createdVia
    })
    yield* validateInterval(next.startUtc, next.endUtc)
    yield* validateRetention(next.retentionSeconds)
    yield* writeStar(next)
    return next
  })

const removeStar = (id: string) =>
  Effect.gen(function*() {
    const star = yield* requireStar(id)
    yield* writeForgetReceipt(star, "removed", new Date().toISOString(), { transcriptKeys: [], excerpt: null })
    yield* Files.remove(dataPath(starKey(id)))
  }).pipe(Effect.mapError((error) => (error instanceof StarNotFound ? error : new Error(String(error)))))

/** The instant a star stops existing. A zero retention puts that instant
 * at `createdAt` itself, so the sweep treats the record as already
 * expired. An unparseable `createdAt` never expires: bad authored data is
 * kept, not silently deleted. */
export const starExpiresAt = (star: Star): number | null => {
  const created = Date.parse(star.createdAt)
  return Number.isNaN(created) ? null : created + star.retentionSeconds * 1000
}

const sweepExpired = (now: Date = new Date()) =>
  Effect.gen(function*() {
    const stars = yield* readAllStars
    const expired = stars.filter((star) => {
      const expiry = starExpiresAt(star)
      return expiry !== null && expiry <= now.getTime()
    })
    yield* Effect.forEach(expired, (star) =>
      Effect.gen(function*() {
        yield* writeForgetReceipt(star, "expired", now.toISOString(), { transcriptKeys: [], excerpt: null })
        yield* Files.remove(dataPath(starKey(star.id)))
      }))
    return expired.map((star) => star.id)
  }).pipe(Effect.mapError((error) => new Error(String(error))))

// --- civil-day membership ------------------------------------------------------

const civilDayInZone = (instant: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value
  return `${part("year")}-${part("month")}-${part("day")}`
}

const nextDay = (day: string): string => {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

/** Every civil day in `timeZone` the interval [startUtc, endUtc) touches. */
export const starDays = (star: Star, timeZone: string): ReadonlyArray<string> => {
  const first = civilDayInZone(new Date(star.startUtc), timeZone)
  const last = civilDayInZone(new Date(Math.max(Date.parse(star.startUtc), Date.parse(star.endUtc) - 1)), timeZone)
  const days: string[] = []
  for (let day = first; day <= last; day = nextDay(day)) days.push(day)
  return days
}

const homeZone = homeTimeZone.pipe(Effect.orElseSucceed(() => "UTC"))

const listStars = (filter: ListStarsFilter = {}) =>
  Effect.gen(function*() {
    const stars = yield* readAllStars
    const zone = filter.day !== undefined ? filter.timeZone ?? (yield* homeZone) : null
    return stars.filter((star) => {
      if (zone !== null && filter.day !== undefined && !starDays(star, zone).includes(filter.day)) return false
      if (filter.fromUtc !== undefined && Date.parse(star.endUtc) <= Date.parse(filter.fromUtc)) return false
      if (filter.toUtc !== undefined && Date.parse(star.startUtc) >= Date.parse(filter.toUtc)) return false
      return true
    })
  })

/** The stars overlapping one civil day, in the lifelog home zone. */
export const starsForDay = (day: string) => listStars({ day })

// --- the service -----------------------------------------------------------------

export interface StarsShape {
  readonly setStar: (input: SetStarInput) => Effect.Effect<Star, InvalidInterval | InvalidRetention | Error, FileSystem.FileSystem>
  readonly getStar: (id: string) => Effect.Effect<Star, StarNotFound | Error, FileSystem.FileSystem>
  readonly listStars: (filter?: ListStarsFilter) => Effect.Effect<ReadonlyArray<Star>, Error, FileSystem.FileSystem>
  readonly updateStar: (
    id: string,
    patch: UpdateStarPatch
  ) => Effect.Effect<Star, StarNotFound | InvalidInterval | InvalidRetention | Error, FileSystem.FileSystem>
  readonly removeStar: (id: string) => Effect.Effect<void, StarNotFound | Error, FileSystem.FileSystem>
  /** Delete every authored star whose retention has lapsed; returns ids. */
  readonly sweepExpired: (now?: Date) => Effect.Effect<ReadonlyArray<string>, Error, FileSystem.FileSystem>
}

export class Stars extends Context.Service<Stars, StarsShape>()("medina/lifelog/Stars") {}

export const StarsLive: Layer.Layer<Stars> = Layer.succeed(Stars)({
  setStar,
  getStar: requireStar,
  listStars,
  updateStar,
  removeStar,
  sweepExpired
})

// --- public artifacts --------------------------------------------------------------

/** The public form of a star, given its resolved transcript overlap. */
export const publicStarFor = (star: Star, transcriptKeys: ReadonlyArray<string>, excerpt: string | null): PublicStar =>
  new PublicStar({
    id: star.id,
    startUtc: star.startUtc,
    endUtc: star.endUtc,
    name: star.name,
    note: star.note,
    createdAt: star.createdAt,
    transcriptKeys: [...transcriptKeys],
    excerpt
  })

/** The canonical JSON whose hash names the public artifact. Field order is
 * fixed by construction, so identical content hashes identically. */
export const publicStarCanonicalJson = (star: PublicStar): string =>
  JSON.stringify({
    id: star.id,
    startUtc: star.startUtc,
    endUtc: star.endUtc,
    name: star.name,
    note: star.note,
    createdAt: star.createdAt,
    transcriptKeys: [...star.transcriptKeys],
    excerpt: star.excerpt
  })

export const publicStarContentHash = (star: PublicStar): string => sha256(publicStarCanonicalJson(star))

/** Base for public star URLs; the URL itself is the base plus the hash. */
export const publicStarsBaseUrl = Config.String("PUBLIC_STARS_BASE_URL").pipe(
  Config.withDefault("https://sco-lifelog-public.example/")
)

export const publicStarUrl = (contentHash: string, baseUrl: string): string =>
  `${baseUrl.replace(/\/*$/, "/")}${contentHash}`

/**
 * Leave the content-free receipt for a forgotten star and return its
 * content hash. The receipt carries hashes and timestamps only — never the
 * name, note, interval or excerpt it attests to forgetting.
 *
 * The hash is the star's public-artifact content hash, computed from the
 * caller's best knowledge of the star's resolved evidence: the pipeline
 * sweep resolves the overlap from the day index, so a swept public star's
 * receipt names exactly the content its public URL named. Service-level
 * forgets (a direct sweep call, a removal, a zero-retention creation) have
 * no index at hand and hash the authored content under the same canonical
 * function with an empty evidence projection.
 */
export const writeForgetReceipt = (
  star: Star,
  reason: StarForgetReceipt["reason"],
  deletedAt: string,
  overlap: StarOverlap
): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const contentHash = publicStarContentHash(publicStarFor(star, overlap.transcriptKeys, overlap.excerpt))
    yield* Files.writeJson(
      dataPath(starForgetReceiptKey(contentHash)),
      new StarForgetReceipt({
        contentHash,
        createdAt: star.createdAt,
        deletedAt,
        retentionSeconds: star.retentionSeconds,
        reason
      })
    )
    return contentHash
  })

// --- excerpt resolution -----------------------------------------------------------

export interface StarOverlap {
  readonly transcriptKeys: ReadonlyArray<string>
  readonly excerpt: string | null
}

/**
 * Best-effort resolution of a star against the day index: the transcripts
 * whose spans overlap the interval, and the text of the overlapping
 * utterances. Utterance times are capture-relative, so an utterance is
 * placed at capture start + offset; a text-only transcript contributes its
 * whole text when the capture starts inside the interval. Live provisionals
 * carry local wall-clock starts, so their placement is approximate until
 * the sealed capture replaces them.
 */
export const starOverlap = (
  index: DayIndex,
  star: Star,
  days: ReadonlyArray<string>
): Effect.Effect<StarOverlap, Error, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const start = Date.parse(star.startUtc)
    const end = Date.parse(star.endUtc)
    const keys: string[] = []
    const parts: string[] = []
    for (const day of days) {
      const transcripts = yield* dayTranscripts(index, day)
      for (const { entry, transcript } of transcripts) {
        const captureStart = Date.parse(entry.startTime)
        if (Number.isNaN(captureStart)) continue
        if (transcript.utterances.length > 0) {
          const captureEnd = captureStart + Math.max(...transcript.utterances.map((u) => u.endMs))
          if (!(captureStart < end && captureEnd > start)) continue
          keys.push(entry.transcriptKey)
          for (const utterance of transcript.utterances) {
            if (captureStart + utterance.startMs < end && captureStart + utterance.endMs > start) {
              parts.push(utterance.text)
            }
          }
        } else if (transcript.text?.trim() && captureStart >= start && captureStart < end) {
          keys.push(entry.transcriptKey)
          parts.push(transcript.text)
        }
      }
    }
    return { transcriptKeys: [...new Set(keys)], excerpt: parts.length > 0 ? parts.join(" ") : null }
  })

// --- the resource -------------------------------------------------------------------

type StarsEnv = FileSystem.FileSystem | StartTimeRulesService

const starsBasis = Effect.gen(function*() {
  // Retention is enforced where views are made: expired records are
  // forgotten first, so no view can resurrect them. The index is read
  // before anything is deleted, so a forgotten public star's receipt can
  // be hashed over the same resolved evidence its public artifact was.
  const now = new Date()
  const authored = yield* readAllStars
  const zone = yield* homeZone
  // Stars are authored data; their views must not be held hostage by a
  // corrupt transcript elsewhere in the corpus. If the day index cannot
  // be built, stars still materialize — with no excerpts resolved.
  const index = yield* currentDayIndex.pipe(
    Effect.orElseSucceed(
      () => new DayIndex({ version: DAY_INDEX_VERSION, inputHash: "unavailable", builtAt: now.toISOString(), days: {} })
    )
  )
  const stars: Array<Star> = []
  for (const star of authored) {
    const expiry = starExpiresAt(star)
    if (expiry !== null && expiry <= now.getTime()) {
      const overlap = yield* starOverlap(index, star, starDays(star, zone))
      yield* writeForgetReceipt(star, "expired", now.toISOString(), overlap)
      yield* Files.remove(dataPath(starKey(star.id)))
    } else {
      stars.push(star)
    }
  }
  const perDay = new Map<string, { entries: Array<StarsDayEntry>; starIds: Array<string>; transcriptKeys: Array<string> }>()
  const publics: Array<{ star: Star; overlap: StarOverlap; content: PublicStar; contentHash: string }> = []
  for (const star of stars) {
    const days = starDays(star, zone)
    const overlap = yield* starOverlap(index, star, days)
    for (const day of days) {
      const group = perDay.get(day) ?? { entries: [], starIds: [], transcriptKeys: [] }
      group.entries.push(new StarsDayEntry({ star, transcriptKeys: overlap.transcriptKeys, excerpt: overlap.excerpt }))
      group.starIds.push(star.id)
      group.transcriptKeys.push(...overlap.transcriptKeys)
      perDay.set(day, group)
    }
    if (star.visibility === "public") {
      const content = publicStarFor(star, overlap.transcriptKeys, overlap.excerpt)
      publics.push({ star, overlap, content, contentHash: publicStarContentHash(content) })
    }
  }
  return { perDay, publics }
}).pipe(Effect.mapError((error) => new Error(String(error))))

/**
 * The stars resource: one per-day view per day any live star touches, plus
 * one public artifact per public star. Eager only — the authored records are
 * the always-current read for anything that needs a single star now.
 */
export const starsResource: Resource<StarsEnv> = {
  name: "stars",
  instances: Effect.map(starsBasis, ({ perDay, publics }) => [
    ...[...perDay.entries()].map(([day, group]) => {
      const basisHash = sha256(
        [
          STARS_VERSION,
          day,
          ...group.entries.map((entry) => `${entry.star.id}:${sha256(JSON.stringify(entry.star))}`),
          ...[...new Set(group.transcriptKeys)].sort()
        ].join("\n")
      )
      return {
        key: starsDayKey(day, basisHash),
        label: day,
        dependencies: [...group.starIds.map(starKey), ...new Set(group.transcriptKeys)],
        materialize: Files.writeJson(
          dataPath(starsDayKey(day, basisHash)),
          new StarsDay({
            version: STARS_VERSION,
            day,
            basisHash,
            generatedAt: new Date().toISOString(),
            entries: group.entries
          })
        )
      }
    }),
    ...publics.map(({ star, overlap, content, contentHash }) => ({
      key: publicStarKey(contentHash),
      label: `public:${star.id}`,
      dependencies: [starKey(star.id), ...overlap.transcriptKeys],
      materialize: Files.writeJson(dataPath(publicStarKey(contentHash)), content)
    }))
  ])
}
