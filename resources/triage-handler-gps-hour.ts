import { setIngestHandler } from "../lib/ingest-handlers";
import { ensureGpsHourWork, gpsHourDebounceMs, gpsHourMaxDelayMs, gpsHourWorkDefinition } from "./gps-hour-work";
import { getGpsHourId } from "./gps-hour";

function hourIdForResult(eventTime?: string) {
  if (!eventTime) throw new Error("Location triage result is missing event time");
  return getGpsHourId(new Date(eventTime));
}

export const gpsHourIngestHandler = setIngestHandler({
  accepts: (result) => result.content.kind === "location-point" && Boolean(result.content.eventTime),
  async ensureWork({ bucket, membership, membershipChanged, now }) {
    return await ensureGpsHourWork({
      bucket,
      hourId: membership.groupKey,
      membershipChanged,
      now,
      priority: membership.priority,
    });
  },
  groupKey: (result) => hourIdForResult(result.content.eventTime),
  inputKey: (result) => hourIdForResult(result.content.eventTime),
  name: "gps-hour",
  priority: (result) => -new Date(result.content.eventTime!).getTime(),
  schedule: { mode: "debounce", delayMs: gpsHourDebounceMs, maxDelayMs: gpsHourMaxDelayMs },
  work: gpsHourWorkDefinition,
});
