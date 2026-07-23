#!/usr/bin/env bun

import type { Bucket } from "../lib/bucket";
import { bucketObject, defineResource, parseResourceArgs, runResource } from "../lib/resource";
import { createBucketFromEnv } from "../lib/bucket-bun";
import { getGpsJsonKey, readGpsLogsForDay, type GpsLog } from "./gps";
import { parseIntervalId } from "./interval";
import { getDefaultTimeZone } from "../lib/timezone";

export const gpsMapWidth = 1024;
export const gpsMapHeight = 1024;

export type GpsBounds = {
  east: number;
  north: number;
  south: number;
  west: number;
};

type GpsMapState = {
  bounds: GpsBounds;
  height: number;
  intervalId: string;
  logs: GpsLog[];
  outputKey: string;
  sourceKey: string;
  url: string;
  width: number;
};

type GpsMapSvgState = {
  bounds: GpsBounds;
  height: number;
  imageKey: string;
  intervalId: string;
  logs: GpsLog[];
  outputKey: string;
  sourceKey: string;
  width: number;
};

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function templateStaticMapUrl(template: string, values: GpsBounds & { height: number; width: number }) {
  return template.replace(/\{(west|south|east|north|width|height)\}/g, (_, key: keyof typeof values) => String(values[key]));
}

function longitudeToTileX(longitude: number, zoom: number) {
  return Math.floor((longitude + 180) / 360 * 2 ** zoom);
}

function latitudeToTileY(latitude: number, zoom: number) {
  const radians = latitude * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * 2 ** zoom);
}

function tileXToLongitude(x: number, zoom: number) {
  return x / 2 ** zoom * 360 - 180;
}

function tileYToLatitude(y: number, zoom: number) {
  const radians = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** zoom)));
  return radians * 180 / Math.PI;
}

export function getOsmTileForBounds(bounds: GpsBounds, maxZoom = 16) {
  for (let zoom = maxZoom; zoom >= 0; zoom -= 1) {
    const westX = longitudeToTileX(bounds.west, zoom);
    const eastX = longitudeToTileX(bounds.east, zoom);
    const northY = latitudeToTileY(bounds.north, zoom);
    const southY = latitudeToTileY(bounds.south, zoom);
    if (westX === eastX && northY === southY) {
      return {
        bounds: {
          east: tileXToLongitude(westX + 1, zoom),
          north: tileYToLatitude(northY, zoom),
          south: tileYToLatitude(northY + 1, zoom),
          west: tileXToLongitude(westX, zoom),
        },
        url: `https://tile.openstreetmap.org/${zoom}/${westX}/${northY}.png`,
        x: westX,
        y: northY,
        zoom,
      };
    }
  }

  return {
    bounds: { east: 180, north: 85.0511287798066, south: -85.0511287798066, west: -180 },
    url: "https://tile.openstreetmap.org/0/0/0.png",
    x: 0,
    y: 0,
    zoom: 0,
  };
}

export function getGpsMapImageKey(intervalId: string) {
  return `${intervalId}/map.png`;
}

export function getGpsMapSvgKey(intervalId: string) {
  return `${intervalId}/map.svg`;
}

export function getGpsBounds(logs: GpsLog[], paddingRatio = 0.15): GpsBounds {
  if (logs.length === 0) {
    throw new Error("GPS map requires at least one point.");
  }

  const latitudes = logs.map((log) => log.latitude);
  const longitudes = logs.map((log) => log.longitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const latitudeSpan = Math.max(maxLatitude - minLatitude, 0.002);
  const longitudeSpan = Math.max(maxLongitude - minLongitude, 0.002);
  const latitudePadding = latitudeSpan * paddingRatio;
  const longitudePadding = longitudeSpan * paddingRatio;

  return {
    east: Math.min(180, maxLongitude + longitudePadding),
    north: Math.min(90, maxLatitude + latitudePadding),
    south: Math.max(-90, minLatitude - latitudePadding),
    west: Math.max(-180, minLongitude - longitudePadding),
  };
}

function getMapboxToken() {
  return process.env.MEDINA_MAPBOX_TOKEN?.trim()
    || process.env.MAPBOX_TOKEN?.trim()
    || process.env.MAPBOX_ACCESS_TOKEN?.trim()
    || "";
}

function getMapboxStyle() {
  return process.env.MEDINA_MAPBOX_STYLE?.trim() || "mapbox/streets-v12";
}

export function getMapboxStaticMapUrl(bounds: GpsBounds, options?: { height?: number; style?: string; token?: string; width?: number }) {
  const width = options?.width ?? gpsMapWidth;
  const height = options?.height ?? gpsMapHeight;
  const token = options?.token ?? getMapboxToken();
  const style = options?.style ?? getMapboxStyle();
  if (!token) return null;
  const encodedBounds = [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(6)).join(",");
  return `https://api.mapbox.com/styles/v1/${style}/static/[${encodedBounds}]/${width}x${height}@2x?padding=80&logo=false&attribution=false&access_token=${encodeURIComponent(token)}`;
}

export function getGpsStaticMapUrl(bounds: GpsBounds, options?: { height?: number; template?: string; width?: number }) {
  const width = options?.width ?? gpsMapWidth;
  const height = options?.height ?? gpsMapHeight;
  const template = options?.template ?? process.env.MEDINA_STATIC_MAP_URL_TEMPLATE;
  if (template) return templateStaticMapUrl(template, { ...bounds, height, width });
  return getMapboxStaticMapUrl(bounds, { height, width }) ?? getOsmTileForBounds(bounds).url;
}

function getGpsMapFetchPlan(bounds: GpsBounds) {
  const template = process.env.MEDINA_STATIC_MAP_URL_TEMPLATE;
  if (template) return { bounds, url: getGpsStaticMapUrl(bounds, { template }) };
  const mapboxUrl = getMapboxStaticMapUrl(bounds);
  if (mapboxUrl) return { bounds, url: mapboxUrl };
  return getOsmTileForBounds(bounds);
}


function formatGpsCalloutTime(log: GpsLog) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: log.timeZone ?? getDefaultTimeZone(),
  }).format(new Date(log.time));
}

function selectGpsCalloutIndexes(count: number, maxCallouts = 14) {
  if (count <= 0) return [];
  if (count <= maxCallouts) return Array.from({ length: count }, (_, index) => index);

  const indexes = new Set<number>();
  for (let index = 0; index < maxCallouts; index += 1) {
    indexes.add(Math.round(index * (count - 1) / (maxCallouts - 1)));
  }
  return [...indexes].sort((left, right) => left - right);
}

function createGpsCallouts(logs: GpsLog[], points: Array<{ x: number; y: number }>, width: number, height: number) {
  const calloutIndexes = selectGpsCalloutIndexes(logs.length);
  const labelWidth = 58;
  const labelHeight = 24;

  return calloutIndexes.map((logIndex, calloutIndex) => {
    const point = points[logIndex]!;
    const angle = calloutIndex / Math.max(1, calloutIndexes.length) * Math.PI * 2 - Math.PI / 3;
    const distance = 54 + (calloutIndex % 3) * 18;
    const anchorX = point.x + Math.cos(angle) * distance;
    const anchorY = point.y + Math.sin(angle) * distance;
    const x = Math.max(8, Math.min(width - labelWidth - 8, anchorX - labelWidth / 2));
    const y = Math.max(8, Math.min(height - labelHeight - 8, anchorY - labelHeight / 2));
    const cx = x + labelWidth / 2;
    const cy = y + labelHeight / 2;
    const time = escapeXml(formatGpsCalloutTime(logs[logIndex]!));

    return `<g class="gps-callout">
    <line x1="${point.x.toFixed(2)}" y1="${point.y.toFixed(2)}" x2="${cx.toFixed(2)}" y2="${cy.toFixed(2)}" stroke="#111827" stroke-width="2" opacity="0.75"/>
    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${labelWidth}" height="${labelHeight}" rx="7" fill="#ffffff" stroke="#111827" stroke-width="2" opacity="0.94"/>
    <text x="${cx.toFixed(2)}" y="${(y + 16).toFixed(2)}" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="14" font-weight="700" fill="#111827">${time}</text>
  </g>`;
  });
}

function projectGpsPoint(log: GpsLog, bounds: GpsBounds, width: number, height: number) {
  const longitudeSpan = bounds.east - bounds.west || 1;
  const latitudeSpan = bounds.north - bounds.south || 1;
  return {
    x: (log.longitude - bounds.west) / longitudeSpan * width,
    y: (bounds.north - log.latitude) / latitudeSpan * height,
  };
}

export function createGpsMapSvg(input: {
  bounds: GpsBounds;
  imageData: ArrayBuffer;
  intervalId: string;
  logs: GpsLog[];
  width?: number;
  height?: number;
}) {
  const width = input.width ?? gpsMapWidth;
  const height = input.height ?? gpsMapHeight;
  const points = input.logs.map((log) => projectGpsPoint(log, input.bounds, width, height));
  const polyline = points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const circles = points.map((point, index) => {
    const radius = index === 0 || index === points.length - 1 ? 7 : 4;
    const fill = index === 0 ? "#22c55e" : index === points.length - 1 ? "#ef4444" : "#0ea5e9";
    return `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${radius}" fill="${fill}" stroke="#fff" stroke-width="2"/>`;
  });
  const callouts = createGpsCallouts(input.logs, points, width, height);
  const base64 = Buffer.from(input.imageData).toString("base64");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="GPS map ${escapeXml(input.intervalId)}">
  <image href="data:image/png;base64,${base64}" x="0" y="0" width="${width}" height="${height}"/>
  <polyline points="${polyline}" fill="none" stroke="#f97316" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
  ${circles.join("\n  ")}
  ${callouts.join("\n  ")}
</svg>
`;
}

export const gpsMapImageDefinition = defineResource<GpsMapState>({
  async materialize({ bucket, plan }) {
    const response = await fetch(plan.state.url, {
      headers: {
        "user-agent": "Medina GPS map resource (https://medina.stream)",
      },
    });
    if (!response.ok) {
      throw new Error(`Static map fetch failed: HTTP ${response.status}`);
    }
    await bucket.write(plan.state.outputKey, await response.arrayBuffer(), { type: "image/png" });
  },
  name: "gps-map-image",
  async plan({ bucket, inputKey }) {
    const intervalId = parseIntervalId(inputKey).id;
    const sourceKey = getGpsJsonKey(intervalId);
    const { dependencies, logs } = await readGpsLogsForDay(bucket, intervalId);
    const dataBounds = getGpsBounds(logs);
    const map = getGpsMapFetchPlan(dataBounds);
    const outputKey = getGpsMapImageKey(intervalId);
    return {
      dependencies: [bucketObject(sourceKey), ...dependencies],
      outputs: [outputKey],
      state: {
        bounds: map.bounds,
        height: gpsMapHeight,
        intervalId,
        logs,
        outputKey,
        sourceKey,
        url: map.url,
        width: gpsMapWidth,
      },
    };
  },
  version: "3",
});

export const gpsMapSvgDefinition = defineResource<GpsMapSvgState>({
  async materialize({ bucket, plan }) {
    const imageData = await bucket.readArrayBuffer(plan.state.imageKey);
    await bucket.write(plan.state.outputKey, createGpsMapSvg({
      bounds: plan.state.bounds,
      height: plan.state.height,
      imageData,
      intervalId: plan.state.intervalId,
      logs: plan.state.logs,
      width: plan.state.width,
    }), { type: "image/svg+xml; charset=utf-8" });
  },
  name: "gps-map-svg",
  async plan({ bucket, inputKey }) {
    const intervalId = parseIntervalId(inputKey).id;
    const sourceKey = getGpsJsonKey(intervalId);
    const imageKey = getGpsMapImageKey(intervalId);
    const { dependencies, logs } = await readGpsLogsForDay(bucket, intervalId);
    const dataBounds = getGpsBounds(logs);
    const map = getGpsMapFetchPlan(dataBounds);
    return {
      dependencies: [bucketObject(sourceKey), bucketObject(imageKey), ...dependencies],
      outputs: [getGpsMapSvgKey(intervalId)],
      state: {
        bounds: map.bounds,
        height: gpsMapHeight,
        imageKey,
        intervalId,
        logs,
        outputKey: getGpsMapSvgKey(intervalId),
        sourceKey,
        width: gpsMapWidth,
      },
    };
  },
  version: "3",
});

export async function materializeGpsMap(inputKey: string, options: { bucket: Bucket; force?: boolean }) {
  const image = await runResource(gpsMapImageDefinition, {
    bucket: options.bucket,
    force: options.force,
    inputKey,
  });
  const svg = await runResource(gpsMapSvgDefinition, {
    bucket: options.bucket,
    force: options.force,
    inputKey,
  });
  return { image, svg };
}

if (import.meta.main) {
  const bucket = createBucketFromEnv();
  const { force, inputKey } = parseResourceArgs();
  const result = await materializeGpsMap(inputKey, { bucket, force });
  console.log(JSON.stringify([...result.image.outputs, ...result.svg.outputs]));
}
