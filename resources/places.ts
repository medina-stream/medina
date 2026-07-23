import type { Bucket } from "../lib/bucket";
import { getGpsDistanceMeters } from "./gps";

export type Place = {
  latitude: number;
  longitude: number;
  name: string;
  notes: string;
  radiusMeters: number;
};

export const PLACES_KEY = "places.md";
export const DEFAULT_PLACE_RADIUS_METERS = 75;

export const PLACES_TEMPLATE = `# Places

Named locations used to enrich GPS narratives. Edit freely; rows are matched
by proximity (radius in meters, default ${DEFAULT_PLACE_RADIUS_METERS}).

| Name | Latitude | Longitude | Radius | Notes |
| --- | ---: | ---: | ---: | --- |
`;

export function parsePlacesMarkdown(markdown: string): Place[] {
  return markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("| ") && !line.includes("---"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells[0] !== "Name")
    .map((cells): Place | null => {
      const [name, latitudeValue, longitudeValue, radiusValue, notes] = cells;
      const latitude = Number(latitudeValue);
      const longitude = Number(longitudeValue);
      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const radius = Number(radiusValue);
      return {
        latitude,
        longitude,
        name,
        notes: notes ?? "",
        radiusMeters: Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_PLACE_RADIUS_METERS,
      };
    })
    .filter((place): place is Place => place !== null);
}

export function findPlace(places: Place[], point: { latitude: number; longitude: number }): Place | null {
  let best: Place | null = null;
  let bestDistance = Infinity;
  for (const place of places) {
    const distance = getGpsDistanceMeters(place, point);
    if (distance <= place.radiusMeters && distance < bestDistance) {
      best = place;
      bestDistance = distance;
    }
  }
  return best;
}

export async function readPlaces(bucket: Bucket): Promise<{ markdown: string; places: Place[] }> {
  if (!(await bucket.exists(PLACES_KEY))) {
    return { markdown: PLACES_TEMPLATE, places: [] };
  }
  const markdown = await bucket.readText(PLACES_KEY);
  return { markdown, places: parsePlacesMarkdown(markdown) };
}
