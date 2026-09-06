/** Lightweight process-local event feed for operators and the browser UI. */
import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"

export interface RuntimeEvent {
  readonly at: string
  readonly type: string
  readonly message: string
  readonly name?: string
  readonly status?: string
}

export const eventHub = Effect.runSync(
  PubSub.sliding<RuntimeEvent>({ capacity: 256, replay: 64 })
)

export const publishEvent = (event: Omit<RuntimeEvent, "at">) =>
  Effect.asVoid(PubSub.publish(eventHub, { at: new Date().toISOString(), ...event }))
