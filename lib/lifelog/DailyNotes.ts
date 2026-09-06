/** Read access to the canonical written note for a civil day.
 *
 * Importing notes from a particular repository is application policy. Once a
 * note has entered the artifact store, however, its lookup and contribution
 * to derivative freshness are shared lifelog behavior.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Files from "../Files.ts"
import { dataPath, Note, noteKey } from "./Resources.ts"

/** The ingested note for a day, if there is one. */
export const noteForDay = (day: string) => Files.readJson(Note, dataPath(noteKey(day)))

/** A note's source revision, used as an input to downstream basis hashes. */
export const noteBasisHash = (day: string) =>
  Effect.map(noteForDay(day), (note) => Option.isSome(note) ? note.value.blobSha : null)
