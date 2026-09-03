import * as Config from "effect/Config"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

/** The zone used to interpret zone-less evidence and request labels. A
 * capture's own believed IANA zone always takes precedence. */
export const homeTimeZone = Config.string("HOME_TZ").pipe(Config.withDefault("America/Chicago"))

/**
 * A development window: when set, only the last N days are enumerated
 * eagerly, so iterating doesn't re-journal the whole corpus.
 *
 * This bounds *eager* work only. Lazy dereference is untouched -- asking for
 * an older day still materializes it on demand -- so the window changes what
 * the pipeline does ahead of time, never what the record can answer. Unset
 * (production) means no window at all.
 */
export const eagerWindowDays = Config.int("EAGER_WINDOW_DAYS").pipe(Config.option)

/** The oldest day worth materializing ahead of demand, if a window is set. */
export const eagerSinceDay = Effect.gen(function*() {
  const days = yield* eagerWindowDays
  if (Option.isNone(days)) return null
  const now = yield* DateTime.now
  return DateTime.formatIsoDate(DateTime.subtract(now, { days: days.value }))
})

/** Narrow a set of candidate days to the eager window. */
export const withinEagerWindow = <A>(days: Iterable<A>, since: string | null, dayOf: (value: A) => string) =>
  since === null ? [...days] : [...days].filter((value) => dayOf(value) >= since)
