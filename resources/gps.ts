import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

import type { Bucket } from "../lib/bucket";
import { bucketObject, defineResource, parseResourceArgs, runResource, writeBucketJson } from "../lib/resource";
import { createBucketFromEnv } from "../lib/bucket-bun";
import { parseIntervalId } from "./interval";
import { getGpsHourId, getGpsHourKey, type GpsHour } from "./gps-hour";
import { PLACES_KEY, readPlaces, type Place } from "./places";
import { describeSegments, segmentGpsLogs, type GpsSegment } from "./gps-segments";
import { getDefaultTimeZone, localDateFromDayId, localDateOf } from "../lib/timezone";

export type GpsLog = {
  ingestKey: string;
  latitude: number;
  longitude: number;
  speed: number | null;
  time: string;
  timeZone?: string;
  timeZoneSource?: "gps" | "carry-forward" | "default";
};

export type CollapsedGpsLog = GpsLog & {
  collapsedPoints: number;
};

type GpsState = {
  dayId: string;
  intervalId: string;
  logs: GpsLog[];
  markdownKey: string;
  jsonKey: string;
  places: Place[];
  rawCount: number;
  timeZoneFallbackUsed: boolean;
};

export type GpsJsonSegment = {
  endTime: string;
  kind: "stay" | "travel";
  startTime: string;
  timeZone: string;
  distanceMeters?: number;
  mode?: string;
  place?: string;
};

export type GpsJson = {
  collapsedCount: number;
  dayId: string;
  dominantTimeZone: string;
  generatedAt: string;
  multiZone: boolean;
  rawCount: number;
  segments: GpsJsonSegment[];
  summary: string;
  timeline: string[];
  timeZoneCoverage: Array<{ seconds: number; timeZone: string }>;
  timeZoneFallbackUsed: boolean;
  warnings: string[];
};

const defaultMinimumSampleMs = 10 * 60 * 1000;
const defaultAlwaysSampleMs = 30 * 60 * 1000;
const defaultSignificantDistanceMeters = 100;
const defaultJitterDistanceMeters = 25;
const movingSpeedMetersPerSecond = 1;

function toRadians(value: number) {
  return value * Math.PI / 180;
}

export function getGpsDistanceMeters(left: Pick<GpsLog, "latitude" | "longitude">, right: Pick<GpsLog, "latitude" | "longitude">) {
  const earthRadiusMeters = 6_371_000;
  const deltaLatitude = toRadians(right.latitude - left.latitude);
  const deltaLongitude = toRadians(right.longitude - left.longitude);
  const leftLatitude = toRadians(left.latitude);
  const rightLatitude = toRadians(right.latitude);
  const haversine = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

function getGpsTimeMs(log: GpsLog) {
  return new Date(log.time).getTime();
}

function isMoving(log: GpsLog) {
  return (log.speed ?? 0) >= movingSpeedMetersPerSecond;
}

export function getGpsMarkdownKey(intervalId: string) {
  return `${intervalId}/gps.md`;
}

export function getGpsJsonKey(intervalId: string) {
  return `${intervalId}/gps.json`;
}

export function deduplicateGpsLogs(logs: GpsLog[]) {
  const sorted = logs
    .slice()
    .sort((left, right) => left.time.localeCompare(right.time) || left.ingestKey.localeCompare(right.ingestKey));
  const deduplicated: GpsLog[] = [];
  const seen = new Set<string>();

  for (const log of sorted) {
    const fingerprint = `${log.time}|${log.latitude}|${log.longitude}|${log.speed ?? ""}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    deduplicated.push(log);
  }

  return deduplicated;
}

export function collapseGpsLogs(logs: GpsLog[], options?: {
  alwaysSampleMs?: number;
  jitterDistanceMeters?: number;
  minimumSampleMs?: number;
  significantDistanceMeters?: number;
}): CollapsedGpsLog[] {
  const alwaysSampleMs = options?.alwaysSampleMs ?? defaultAlwaysSampleMs;
  const jitterDistanceMeters = options?.jitterDistanceMeters ?? defaultJitterDistanceMeters;
  const minimumSampleMs = options?.minimumSampleMs ?? defaultMinimumSampleMs;
  const significantDistanceMeters = options?.significantDistanceMeters ?? defaultSignificantDistanceMeters;
  const deduped = deduplicateGpsLogs(logs);

  if (deduped.length === 0) return [];

  const collapsed: CollapsedGpsLog[] = [{ ...deduped[0]!, collapsedPoints: 1 }];
  for (const log of deduped.slice(1)) {
    const lastKept = collapsed.at(-1)!;
    const elapsedMs = getGpsTimeMs(log) - getGpsTimeMs(lastKept);
    const distanceMeters = getGpsDistanceMeters(lastKept, log);
    const keep = distanceMeters >= significantDistanceMeters
      || (elapsedMs >= minimumSampleMs && distanceMeters >= jitterDistanceMeters)
      || elapsedMs >= alwaysSampleMs
      || isMoving(log) !== isMoving(lastKept);

    if (keep) {
      collapsed.push({ ...log, collapsedPoints: 1 });
    } else {
      lastKept.collapsedPoints += 1;
    }
  }

  const finalLog = deduped.at(-1)!;
  const lastKept = collapsed.at(-1)!;
  if (lastKept.time !== finalLog.time || lastKept.latitude !== finalLog.latitude || lastKept.longitude !== finalLog.longitude) {
    collapsed.push({ ...finalLog, collapsedPoints: 1 });
  }

  return collapsed;
}


function getGpsSummaryModel() {
  return process.env.MEDINA_GPS_SUMMARY_MODEL?.trim() || "gpt-4o-mini";
}

function getGpsSummaryProvider() {
  const apiKey = process.env.MEDINA_GPS_OPENAI_API_KEY?.trim()
    || process.env.OPENAI_API_KEY?.trim()
    || "unused";
  const baseURL = process.env.MEDINA_GPS_OPENAI_BASE_URL?.trim()
    || process.env.OPENAI_BASE_URL?.trim()
    || undefined;
  if (getGpsSummaryModel().startsWith("claude")) {
    return createAnthropic({ apiKey, baseURL });
  }
  return createOpenAI({ apiKey, baseURL });
}

function formatTimeInZone(isoTime: string, timeZone: string, includeZone = false) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    timeZone,
    ...(includeZone ? { timeZoneName: "short" } : {}),
  }).format(new Date(isoTime));
}

function createTimeZoneTransitionSummary(segments: GpsSegment[]) {
  const transitions: Array<{ label: string; timeZone: string }> = [];
  for (const segment of segments) {
    if (transitions.at(-1)?.timeZone === segment.timeZone) continue;
    transitions.push({
      label: transitions.length === 0
        ? `${segment.timeZone} until ${formatTimeInZone(segment.endTime, segment.timeZone)}`
        : `${segment.timeZone} after`,
      timeZone: segment.timeZone,
    });
  }
  return transitions.length > 1 ? `Time zone changes: ${transitions.map((transition) => transition.label).join(", ")}.` : null;
}

function createGpsSummaryPrompt(intervalId: string, logs: CollapsedGpsLog[], segments: GpsSegment[], dominantTimeZone: string, multiZone: boolean) {
  const segmentLines = describeSegments(segments, dominantTimeZone);
  const rows = logs.map((log) => ({
    latitude: log.latitude,
    longitude: log.longitude,
    rawPoints: log.collapsedPoints,
    speed: log.speed,
    time: log.time,
    timeZone: log.timeZone ?? getDefaultTimeZone(),
  }));

  return `Write a natural 2-4 sentence narrative of this person's day (${intervalId}) from their GPS trace. Every time below is already local to that segment's own time zone.

Pre-computed segments (stays and travel legs, in order). Named places come from the person's own places list — use those names naturally ("spent the morning at home", "stopped by Reveille Cafe"). For unnamed stays, describe the area only loosely from coordinates or skip naming it.
${multiZone ? `${createTimeZoneTransitionSummary(segments) ?? ""}` : ""}
${segmentLines.map((line) => `- ${line}`).join("\n")}

Travel modes were inferred from speed. Trust them, but phrase vehicular legs neutrally (drove/rode). Do not compare clock times across time zones or imply impossible elapsed time. Keep it warm and concise, like a journal recap. No exact addresses, no coordinates in the output, no bullet lists.

Raw waypoints for additional context:
${JSON.stringify(rows)}`;
}

function formatSegmentBoundary(log: GpsLog, dominantTimeZone: string) {
  const timeZone = log.timeZone ?? getDefaultTimeZone();
  return formatTimeInZone(log.time, timeZone, timeZone !== dominantTimeZone);
}

export function createFallbackGpsSummary(
  intervalId: string,
  logs: GpsLog[],
  options?: { dominantTimeZone?: string; rawCount?: number; segments?: GpsSegment[] },
) {
  const collapsed = collapseGpsLogs(logs);
  const rawCount = options?.rawCount ?? logs.length;
  const dominantTimeZone = options?.dominantTimeZone ?? getDefaultTimeZone();
  if (collapsed.length === 0) return `No GPS points were recorded for ${intervalId}.`;
  const segments = options?.segments ?? [];
  if (segments.length > 0) {
    const transitionSummary = createTimeZoneTransitionSummary(segments);
    const lines = describeSegments(segments, dominantTimeZone).join("; ");
    return transitionSummary ? `${lines}. ${transitionSummary}` : `${lines}.`;
  }
  const first = collapsed[0]!;
  const last = collapsed.at(-1)!;
  const latitudes = collapsed.map((log) => log.latitude);
  const longitudes = collapsed.map((log) => log.longitude);
  return `GPS coverage runs from ${formatSegmentBoundary(first, dominantTimeZone)} to ${formatSegmentBoundary(last, dominantTimeZone)}, with ${rawCount} points collapsed into ${collapsed.length} waypoints. The track spans roughly ${Math.min(...latitudes).toFixed(4)}–${Math.max(...latitudes).toFixed(4)} latitude and ${Math.min(...longitudes).toFixed(4)}–${Math.max(...longitudes).toFixed(4)} longitude.`;
}

export async function summarizeGpsPath(
  intervalId: string,
  logs: GpsLog[],
  options?: {
    dominantTimeZone?: string;
    multiZone?: boolean;
    places?: Place[];
    rawCount?: number;
    warn?: (warning: { code: string; message: string }) => void;
  },
) {
  const segments = segmentGpsLogs(logs, options?.places ?? []);
  if (process.env.MEDINA_GPS_SUMMARY_MODE === "off") return createFallbackGpsSummary(intervalId, logs, { ...options, segments });
  if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL && !process.env.MEDINA_GPS_OPENAI_BASE_URL) {
    options?.warn?.({
      code: "gps-summary-unconfigured",
      message: "No OPENAI_API_KEY or OPENAI_BASE_URL configured; using fallback stats summary. Set MEDINA_GPS_SUMMARY_MODE=off to silence.",
    });
    return createFallbackGpsSummary(intervalId, logs, { ...options, segments });
  }

  const collapsed = collapseGpsLogs(logs);
  if (collapsed.length === 0) return createFallbackGpsSummary(intervalId, logs, { ...options, segments });

  try {
    const result = await generateText({
      model: getGpsSummaryProvider()(getGpsSummaryModel()),
      maxRetries: 0,
      prompt: createGpsSummaryPrompt(intervalId, collapsed, segments, options?.dominantTimeZone ?? getDefaultTimeZone(), options?.multiZone ?? false),
      temperature: 0.2,
    });
    return result.text.trim() || createFallbackGpsSummary(intervalId, logs, { ...options, segments });
  } catch (error) {
    options?.warn?.({
      code: "gps-summary-failed",
      message: `GPS summary generation failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return createFallbackGpsSummary(intervalId, logs, { ...options, segments });
  }
}

function getCoveredSeconds(segment: GpsSegment) {
  return Math.max(0, Math.round((new Date(segment.endTime).getTime() - new Date(segment.startTime).getTime()) / 1000));
}

function normalizeGpsLog(log: GpsLog) {
  if (log.timeZone) return { ...log };
  return {
    ...log,
    timeZone: getDefaultTimeZone(),
    timeZoneSource: log.timeZoneSource ?? "default",
  };
}

function summarizeTimeZoneCoverage(segments: GpsSegment[]) {
  const coverage = new Map<string, number>();
  for (const segment of segments) {
    coverage.set(segment.timeZone, (coverage.get(segment.timeZone) ?? 0) + getCoveredSeconds(segment));
  }
  return [...coverage.entries()]
    .map(([timeZone, seconds]) => ({ seconds, timeZone }))
    .sort((left, right) => right.seconds - left.seconds || left.timeZone.localeCompare(right.timeZone));
}

function getDominantTimeZone(segments: GpsSegment[]) {
  if (segments.length === 0) return getDefaultTimeZone();
  const coverage = summarizeTimeZoneCoverage(segments);
  const ordered = coverage.slice().sort((left, right) => {
    if (right.seconds !== left.seconds) return right.seconds - left.seconds;
    const leftIndex = segments.findIndex((segment) => segment.timeZone === left.timeZone);
    const rightIndex = segments.findIndex((segment) => segment.timeZone === right.timeZone);
    return leftIndex - rightIndex;
  });
  return ordered[0]?.timeZone ?? segments[0]!.timeZone;
}

function buildGpsJson(input: {
  dayId: string;
  generatedAt: string;
  logs: GpsLog[];
  places: Place[];
  rawCount: number;
  summary: string;
  timeZoneFallbackUsed: boolean;
  warnings: string[];
}): GpsJson {
  const segments = segmentGpsLogs(input.logs, input.places);
  const dominantTimeZone = segments.length > 0 ? getDominantTimeZone(segments) : getDefaultTimeZone();
  const timeZoneCoverage = segments.length > 0 ? summarizeTimeZoneCoverage(segments) : [{ seconds: 0, timeZone: dominantTimeZone }];
  const coveredSeconds = timeZoneCoverage.reduce((sum, zone) => sum + zone.seconds, 0);
  const topSeconds = timeZoneCoverage[0]?.seconds ?? 0;
  const segmentWarnings = segments
    .filter((segment) => segment.kind === "travel" && segment.zoneChanged)
    .map(() => "zone-change-in-segment");
  const warnings = [...new Set([...input.warnings, ...segmentWarnings])];
  const multiZone = coveredSeconds > 0 && topSeconds / coveredSeconds < 0.6;
  const timeline = describeSegments(segments, dominantTimeZone);
  const collapsedCount = collapseGpsLogs(input.logs).length;

  return {
    collapsedCount,
    dayId: input.dayId,
    dominantTimeZone,
    generatedAt: input.generatedAt,
    multiZone,
    rawCount: input.rawCount,
    segments: segments.map((segment) => segment.kind === "stay"
      ? {
          endTime: segment.endTime,
          kind: segment.kind,
          place: segment.placeName ?? undefined,
          startTime: segment.startTime,
          timeZone: segment.timeZone,
        }
      : {
          distanceMeters: segment.distanceMeters,
          endTime: segment.endTime,
          kind: segment.kind,
          mode: segment.mode,
          startTime: segment.startTime,
          timeZone: segment.timeZone,
        }),
    summary: input.summary,
    timeline,
    timeZoneCoverage,
    timeZoneFallbackUsed: input.timeZoneFallbackUsed || input.logs.length === 0,
    warnings: input.logs.length === 0 && !warnings.includes("no-gps") ? [...warnings, "no-gps"] : warnings,
  };
}

export function createGpsMarkdown(data: GpsJson, logs: GpsLog[]) {
  const collapsed = collapseGpsLogs(logs);
  const rows = collapsed.map((log) => `| ${log.time} | ${log.latitude} | ${log.longitude} | ${log.speed ?? ""} | ${log.collapsedPoints} |`);
  return [
    `# GPS ${data.dayId}`,
    "",
    `![GPS map](map.svg)`,
    "",
    ...(data.summary ? [data.summary, ""] : []),
    ...(data.timeline.length > 0 ? ["## Timeline", "", ...data.timeline.map((line) => `- ${line}`), ""] : []),
    `Generated: ${data.generatedAt}`,
    "",
    `Raw points: ${data.rawCount}`,
    `Collapsed points: ${data.collapsedCount}`,
    "",
    "| Time | Latitude | Longitude | Speed | Raw points |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}

export function getGpsHourKeysForDay(intervalId: string) {
  const interval = parseIntervalId(intervalId);
  if (interval.length !== "P1D") throw new Error(`GPS requires a daily interval: ${intervalId}`);
  const startMs = interval.startTime.getTime() - 14 * 60 * 60 * 1000;
  return Array.from({ length: 52 }, (_, hour) => getGpsHourKey(getGpsHourId(new Date(startMs + hour * 60 * 60 * 1000))));
}

export async function readGpsLogsForDay(bucket: Bucket, intervalId: string) {
  const hourKeys = getGpsHourKeysForDay(intervalId);
  const localDate = localDateFromDayId(intervalId);
  const hours = (await Promise.all(hourKeys.map(async (key) => {
    if (!(await bucket.exists(key))) return null;
    return await bucket.readJson<GpsHour>(key);
  }))).filter((hour): hour is GpsHour => hour !== null);
  const normalized = deduplicateGpsLogs(hours.flatMap((hour) => hour.deduplicatedPoints ?? []).map((log) => normalizeGpsLog(log)));
  const logs = normalized.filter((log) => localDateOf(log.time, log.timeZone ?? getDefaultTimeZone()) === localDate);
  const timeZoneFallbackUsed = hours.flatMap((hour) => hour.deduplicatedPoints ?? []).some((log) => !log.timeZone);
  return { dependencies: hourKeys.map(bucketObject), logs, rawCount: logs.length, timeZoneFallbackUsed };
}

export const gpsDefinition = defineResource<GpsState>({
  async materialize({ bucket, now, plan, warn }) {
    const warningCodes: string[] = [];
    const initialWarnings = plan.state.logs.length === 0 ? ["no-gps"] : [];
    const baselineTimeZone = plan.state.logs[0]?.timeZone ?? getDefaultTimeZone();
    const baselineSegments = segmentGpsLogs(plan.state.logs, plan.state.places);
    const dominantTimeZone = baselineSegments.length > 0 ? getDominantTimeZone(baselineSegments) : baselineTimeZone;
    const multiZone = baselineSegments.length > 0 && (() => {
      const coverage = summarizeTimeZoneCoverage(baselineSegments);
      const coveredSeconds = coverage.reduce((sum, zone) => sum + zone.seconds, 0);
      return coveredSeconds > 0 && (coverage[0]?.seconds ?? 0) / coveredSeconds < 0.6;
    })();
    const summary = await summarizeGpsPath(plan.state.intervalId, plan.state.logs, {
      dominantTimeZone,
      multiZone,
      places: plan.state.places,
      rawCount: plan.state.rawCount,
      warn: (warning) => {
        warningCodes.push(warning.code);
        warn(warning);
      },
    });
    const data = buildGpsJson({
      dayId: plan.state.dayId,
      generatedAt: now.toISOString(),
      logs: plan.state.logs,
      places: plan.state.places,
      rawCount: plan.state.rawCount,
      summary,
      timeZoneFallbackUsed: plan.state.timeZoneFallbackUsed,
      warnings: [...initialWarnings, ...warningCodes],
    });
    await writeBucketJson(plan.state.jsonKey, data, bucket);
    await bucket.write(plan.state.markdownKey, createGpsMarkdown(data, plan.state.logs), {
      type: "text/markdown; charset=utf-8",
    });
  },
  name: "gps",
  async plan({ bucket, inputKey }) {
    const intervalId = parseIntervalId(inputKey).id;
    const { dependencies, logs, rawCount, timeZoneFallbackUsed } = await readGpsLogsForDay(bucket, intervalId);
    const { places } = await readPlaces(bucket);
    return {
      dependencies: [...dependencies, bucketObject(PLACES_KEY)],
      outputs: [getGpsMarkdownKey(intervalId), getGpsJsonKey(intervalId)],
      state: {
        dayId: intervalId,
        intervalId,
        logs,
        jsonKey: getGpsJsonKey(intervalId),
        markdownKey: getGpsMarkdownKey(intervalId),
        places,
        rawCount,
        timeZoneFallbackUsed,
      },
    };
  },
  version: "7",
});

export async function materializeGps(inputKey: string, options: { bucket: Bucket; force?: boolean }) {
  return await runResource(gpsDefinition, {
    bucket: options.bucket,
    force: options.force,
    inputKey,
  });
}

if (import.meta.main) {
  const bucket = createBucketFromEnv();
  const { force, inputKey } = parseResourceArgs();
  const result = await materializeGps(inputKey, { bucket, force });
  console.log(JSON.stringify(result.outputs));
}
