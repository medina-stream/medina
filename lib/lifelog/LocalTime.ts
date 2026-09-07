/**
 * Civil time in an IANA zone.
 *
 * Medina stores instants in UTC and carries the believed zone beside them
 * (`DayEntry.timeZone`, `Attribution.timeZone`). Anything a person reads --
 * a journal chunk header, a recording label -- has to be rendered back into
 * that zone. Skipping the conversion does not fail loudly; it silently
 * reports a UTC clock as if it were local, which for a US zone means events
 * appearing hours in the future.
 *
 * `Intl` does the zone arithmetic so DST needs no special handling. Pure and
 * dependency-free, so the browser bundle and tests share it.
 */

const parts = (instant: Date, zone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(instant).filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  ) as Record<string, string>

/** `HH:MM` in `zone`, or `""` if the instant or zone is unusable. */
export const localTime = (iso: string, zone: string): string => {
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return ""
  try {
    const p = parts(instant, zone)
    return `${p.hour}:${p.minute}`
  } catch {
    return ""
  }
}

/** The civil `YYYY-MM-DD` in `zone`, or `""` if unusable. */
export const localDay = (iso: string, zone: string): string => {
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return ""
  try {
    const p = parts(instant, zone)
    return `${p.year}-${p.month}-${p.day}`
  } catch {
    return ""
  }
}

/**
 * How a recording is labelled in the evidence given to the model: the local
 * clock time, with the zone named so the model is not left inferring it.
 * Falls back to the raw instant rather than dropping the time entirely.
 */
export const recordingLabel = (iso: string, zone: string): string => {
  const time = localTime(iso, zone)
  return time === "" ? iso : `${time} ${zone}`
}
