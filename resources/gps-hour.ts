import { listAllBucketKeys, normalizeBucketKey, type Bucket } from "../lib/bucket";
import { dispatchGroupPrefix, type DispatchMembership } from "../lib/ingest-handlers";
import type { LocationPointFacts } from "../lib/ingest-classification";
import { bucketObject, defineResource, runResource, writeBucketJson } from "../lib/resource";
import { getDefaultTimeZone, lookupTimeZone } from "../lib/timezone";
import { collapseGpsLogs, deduplicateGpsLogs, type CollapsedGpsLog, type GpsLog } from "./gps";

export type ParsedGpsHourId = {
  dayId: string;
  endTime: Date;
  id: string;
  startTime: Date;
};

export type GpsHour = {
  collapsedCount: number;
  collapsedPoints: CollapsedGpsLog[];
  deduplicatedCount: number;
  deduplicatedPoints: GpsLog[];
  duplicateCount: number;
  endTime: string;
  hourId: string;
  rawCount: number;
  startTime: string;
  timeBounds: { first: string; last: string } | null;
  version: 3;
};

type GpsHourState = {
  hour: GpsHour;
  outputKey: string;
};

function pad(value: number, length: number) {
  return String(value).padStart(length, "0");
}

function createUtcDate(year: number, month: number, day: number, hour: number) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

export function getGpsHourId(value: Date) {
  if (Number.isNaN(value.getTime())) throw new Error("Invalid GPS hour date");
  return [
    pad(value.getUTCFullYear(), 5),
    pad(value.getUTCMonth() + 1, 2),
    pad(value.getUTCDate(), 2),
    pad(value.getUTCHours(), 2),
  ].join("");
}

export function parseGpsHourId(value: string): ParsedGpsHourId {
  const id = value.replace(/^gps-hours\//, "").replace(/\.json$/, "").trim();
  if (!/^\d{11}$/.test(id)) throw new Error(`Invalid GPS hour id: ${value}`);

  const year = Number(id.slice(0, 5));
  const month = Number(id.slice(5, 7));
  const day = Number(id.slice(7, 9));
  const hour = Number(id.slice(9, 11));
  const startTime = createUtcDate(year, month, day, hour);
  if (startTime.getUTCFullYear() !== year
    || startTime.getUTCMonth() + 1 !== month
    || startTime.getUTCDate() !== day
    || startTime.getUTCHours() !== hour) {
    throw new Error(`Invalid GPS hour id: ${value}`);
  }

  return {
    dayId: id.slice(0, 9),
    endTime: new Date(startTime.getTime() + 60 * 60 * 1000),
    id,
    startTime,
  };
}

export function getGpsHourKey(hourId: string) {
  return `gps-hours/${parseGpsHourId(hourId).id}.json`;
}

function gpsLogFromMembership(membership: DispatchMembership): GpsLog | null {
  if (membership.content?.kind !== "location-point") return null;
  const facts = membership.content.facts as Partial<LocationPointFacts> | undefined;
  if (!facts || typeof facts.latitude !== "number" || typeof facts.longitude !== "number" || typeof facts.eventTime !== "string") {
    return null;
  }
  const time = new Date(facts.eventTime);
  if (Number.isNaN(time.getTime())) return null;

  return {
    ingestKey: membership.ingestKey,
    latitude: facts.latitude,
    longitude: facts.longitude,
    speed: typeof facts.speed === "number" ? facts.speed : null,
    time: time.toISOString(),
  };
}

export function createGpsHour(hourId: string, logs: GpsLog[]): GpsHour {
  const parsed = parseGpsHourId(hourId);
  const sorted = logs
    .slice()
    .sort((left, right) => left.time.localeCompare(right.time) || left.ingestKey.localeCompare(right.ingestKey));
  const deduplicated = annotateTimeZones(deduplicateGpsLogs(sorted));
  const collapsedPoints = annotateTimeZones(collapseGpsLogs(deduplicated));

  return {
    collapsedCount: collapsedPoints.length,
    collapsedPoints,
    deduplicatedCount: deduplicated.length,
    deduplicatedPoints: deduplicated,
    duplicateCount: sorted.length - deduplicated.length,
    endTime: parsed.endTime.toISOString(),
    hourId: parsed.id,
    rawCount: sorted.length,
    startTime: parsed.startTime.toISOString(),
    timeBounds: sorted.length > 0 ? { first: sorted[0]!.time, last: sorted.at(-1)!.time } : null,
    version: 3,
  };
}

function annotateTimeZones<T extends GpsLog>(logs: T[]): T[] {
  const defaultTimeZone = getDefaultTimeZone();
  let previousTimeZone: string | null = null;

  return logs.map((log) => {
    const gpsTimeZone = lookupTimeZone(log.latitude, log.longitude);
    const timeZone = gpsTimeZone ?? previousTimeZone ?? defaultTimeZone;
    const timeZoneSource = gpsTimeZone ? "gps" : previousTimeZone ? "carry-forward" : "default";
    previousTimeZone = timeZone;
    return { ...log, timeZone, timeZoneSource };
  });
}

export const gpsHourDefinition = defineResource<GpsHourState>({
  async materialize({ bucket, plan }) {
    await writeBucketJson(plan.state.outputKey, plan.state.hour, bucket);
  },
  name: "gps-hour",
  async plan({ bucket, inputKey }) {
    const hourId = parseGpsHourId(inputKey).id;
    const membershipKeys = (await listAllBucketKeys(bucket, { prefix: dispatchGroupPrefix("gps-hour", hourId) }))
      .filter((key) => key.endsWith(".json"));
    const memberships = (await Promise.all(membershipKeys.map((key) => bucket.readJson<DispatchMembership>(key).catch(() => null))))
      .filter((membership): membership is DispatchMembership => membership !== null);
    const logs = memberships
      .map(gpsLogFromMembership)
      .filter((log): log is GpsLog => log !== null)
      .filter((log) => getGpsHourId(new Date(log.time)) === hourId);
    const outputKey = getGpsHourKey(hourId);

    return {
      dependencies: membershipKeys.map(bucketObject),
      outputs: [outputKey],
      state: {
        hour: createGpsHour(hourId, logs),
        outputKey,
      },
    };
  },
  version: "3",
});

export async function materializeGpsHour(inputKey: string, options: { bucket: Bucket; force?: boolean; now?: Date }) {
  return await runResource(gpsHourDefinition, {
    bucket: options.bucket,
    force: options.force,
    inputKey: normalizeBucketKey(inputKey),
    now: options.now,
  });
}
