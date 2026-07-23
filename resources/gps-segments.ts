import { getGpsDistanceMeters, type GpsLog } from "./gps";
import { findPlace, type Place } from "./places";

export type TravelMode = "walked" | "biked" | "drove or rode transit" | "moved";

export type StaySegment = {
  endTime: string;
  kind: "stay";
  latitude: number;
  longitude: number;
  placeName: string | null;
  pointCount: number;
  startTime: string;
  timeZone: string;
};

export type TravelSegment = {
  distanceMeters: number;
  endTime: string;
  kind: "travel";
  medianSpeed: number | null;
  maxSpeed: number | null;
  mode: TravelMode;
  pointCount: number;
  startTime: string;
  timeZone: string;
  zoneChanged: boolean;
};

export type GpsSegment = StaySegment | TravelSegment;

const STAY_RADIUS_METERS = 100;
const STAY_MINIMUM_MS = 10 * 60 * 1000;

function timeMs(log: GpsLog) {
  return new Date(log.time).getTime();
}

function centroid(logs: GpsLog[]) {
  const latitude = logs.reduce((sum, log) => sum + log.latitude, 0) / logs.length;
  const longitude = logs.reduce((sum, log) => sum + log.longitude, 0) / logs.length;
  return { latitude, longitude };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// Speeds in m/s, blending reported GPS speed with speeds derived from
// distance/time between consecutive points (reported speed is often null).
function travelSpeeds(logs: GpsLog[]): number[] {
  const speeds: number[] = [];
  for (let i = 0; i < logs.length; i++) {
    const reported = logs[i]!.speed;
    if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
      speeds.push(reported);
      continue;
    }
    if (i === 0) continue;
    const elapsed = (timeMs(logs[i]!) - timeMs(logs[i - 1]!)) / 1000;
    if (elapsed <= 0 || elapsed > 15 * 60) continue;
    speeds.push(getGpsDistanceMeters(logs[i - 1]!, logs[i]!) / elapsed);
  }
  return speeds.filter((speed) => Number.isFinite(speed) && speed >= 0);
}

// Speed alone cannot reliably distinguish a bus from a car, so vehicular
// travel is reported as "drove or rode transit".
export function inferTravelMode(speeds: number[]): TravelMode {
  const med = median(speeds);
  if (med === null) return "moved";
  const sorted = speeds.slice().sort((left, right) => left - right);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
  if (med < 2 && p90 < 3.5) return "walked";
  if (med < 7 && p90 < 11) return "biked";
  return "drove or rode transit";
}

export function segmentGpsLogs(logs: GpsLog[], places: Place[]): GpsSegment[] {
  const sorted = logs.slice().sort((left, right) => left.time.localeCompare(right.time));
  if (sorted.length === 0) return [];

  const segments: GpsSegment[] = [];
  let index = 0;

  const flushTravel = (travel: GpsLog[]) => {
    if (travel.length < 2) return;
    let distance = 0;
    for (let i = 1; i < travel.length; i++) {
      distance += getGpsDistanceMeters(travel[i - 1]!, travel[i]!);
    }
    const speeds = travelSpeeds(travel);
    const timeZone = travel[0]!.timeZone ?? "UTC";
    segments.push({
      distanceMeters: Math.round(distance),
      endTime: travel.at(-1)!.time,
      kind: "travel",
      maxSpeed: speeds.length ? Math.max(...speeds) : null,
      medianSpeed: median(speeds),
      mode: inferTravelMode(speeds),
      pointCount: travel.length,
      startTime: travel[0]!.time,
      timeZone,
      zoneChanged: travel.some((log) => (log.timeZone ?? timeZone) !== timeZone),
    });
  };

  let pendingTravel: GpsLog[] = [];

  while (index < sorted.length) {
    // Greedily grow a cluster of consecutive points within STAY_RADIUS_METERS
    // of its running centroid.
    const cluster: GpsLog[] = [sorted[index]!];
    let end = index + 1;
    while (end < sorted.length) {
      const center = centroid(cluster);
      if (getGpsDistanceMeters(center, sorted[end]!) > STAY_RADIUS_METERS) break;
      cluster.push(sorted[end]!);
      end += 1;
    }

    const dwellMs = timeMs(cluster.at(-1)!) - timeMs(cluster[0]!);
    if (dwellMs >= STAY_MINIMUM_MS) {
      if (pendingTravel.length > 0) {
        pendingTravel.push(cluster[0]!);
        flushTravel(pendingTravel);
        pendingTravel = [];
      }
      const center = centroid(cluster);
      segments.push({
        endTime: cluster.at(-1)!.time,
        kind: "stay",
        latitude: center.latitude,
        longitude: center.longitude,
        placeName: findPlace(places, center)?.name ?? null,
        pointCount: cluster.length,
        startTime: cluster[0]!.time,
        timeZone: cluster[0]!.timeZone ?? "UTC",
      });
      pendingTravel.push(cluster.at(-1)!);
      index = end;
    } else {
      pendingTravel.push(sorted[index]!);
      index += 1;
    }
  }

  flushTravel(pendingTravel);
  return segments;
}

function formatClock(iso: string, timeZone: string, includeZone: boolean) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    timeZone,
    ...(includeZone ? { timeZoneName: "short" } : {}),
  }).format(new Date(iso));
}

export function describeSegments(segments: GpsSegment[], dominantTimeZone: string): string[] {
  const clock = (iso: string, timeZone: string) => formatClock(iso, timeZone, timeZone !== dominantTimeZone);

  return segments.map((segment) => {
    if (segment.kind === "stay") {
      const where = segment.placeName ?? `${segment.latitude.toFixed(4)}, ${segment.longitude.toFixed(4)}`;
      return `${clock(segment.startTime, segment.timeZone)}–${clock(segment.endTime, segment.timeZone)}: at ${where}`;
    }
    const km = segment.distanceMeters / 1000;
    const distance = km >= 1 ? `${km.toFixed(1)} km` : `${segment.distanceMeters} m`;
    return `${clock(segment.startTime, segment.timeZone)}–${clock(segment.endTime, segment.timeZone)}: ${segment.mode} ${distance}`;
  });
}
