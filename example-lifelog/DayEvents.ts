/**
 * Live day updates: a process-wide broadcast hub. The journal workflow
 * publishes a day when its journal lands; SSE subscribers (and the
 * previews-memo sync in `main.ts`) react. Messages are hints, not data —
 * receivers re-fetch through the RPC, so caches and staleness rules stay
 * in one place.
 *
 * Sliding (never blocks publishers) with a small replay so a freshly
 * connected subscriber catches the latest bursts. Nothing is ever shut
 * down: the hub lives as long as the process.
 */
import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"

export const dayHub = Effect.runSync(PubSub.sliding<string>({ capacity: 64, replay: 16 }))

/** Broadcast that a day's journal was (re)written. Never blocks. */
export const publishDay = (day: string) => Effect.asVoid(PubSub.publish(dayHub, day))
