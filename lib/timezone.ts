import tzLookup from "tz-lookup";

function isFiniteCoordinate(value: number) {
  return Number.isFinite(value);
}

function isValidLatitude(latitude: number) {
  return isFiniteCoordinate(latitude) && latitude >= -90 && latitude <= 90;
}

function isValidLongitude(longitude: number) {
  return isFiniteCoordinate(longitude) && longitude >= -180 && longitude <= 180;
}

function isPlausibleTimeZoneName(name: string) {
  return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(name) || /^Etc\/GMT[+\-]?\d+$/.test(name) || name === "UTC";
}

export function isValidTimeZone(name: string): boolean {
  if (!name || !isPlausibleTimeZoneName(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name }).format(new Date("2026-01-01T00:00:00.000Z"));
    return true;
  } catch {
    return false;
  }
}

export function lookupTimeZone(latitude: number, longitude: number): string | null {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  try {
    const timeZone = tzLookup(latitude, longitude);
    return isValidTimeZone(timeZone) ? timeZone : null;
  } catch {
    return null;
  }
}

export function getDefaultTimeZone() {
  const configured = process.env.MEDINA_GPS_TIME_ZONE?.trim();
  return configured && isValidTimeZone(configured) ? configured : "UTC";
}

export function localDateOf(isoTime: string, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  });
  const parts = formatter.formatToParts(new Date(isoTime));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error(`Unable to format local date for ${isoTime} in ${timeZone}`);
  return `${year}-${month}-${day}`;
}

export function localDateFromDayId(dayId: string) {
  const normalized = dayId.trim();
  if (!/^\d{9}$/.test(normalized)) throw new Error(`Invalid day id: ${dayId}`);
  return `${Number(normalized.slice(0, 5)).toString().padStart(4, "0")}-${normalized.slice(5, 7)}-${normalized.slice(7, 9)}`;
}
