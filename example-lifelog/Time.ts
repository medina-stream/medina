import * as Config from "effect/Config"

/** The zone used to interpret zone-less evidence and request labels. A
 * capture's own believed IANA zone always takes precedence. */
export const homeTimeZone = Config.string("HOME_TZ").pipe(Config.withDefault("America/Chicago"))
