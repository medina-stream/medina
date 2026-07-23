type TimeFormatOptions = {
  withSeconds?: boolean;
  withZoneAbbr?: boolean;
};

function isValidDate(date: Date) {
  return !Number.isNaN(date.getTime());
}

function formatTimeParts(iso: string, timeZone: string, options?: TimeFormatOptions) {
  const date = new Date(iso);
  if (!isValidDate(date)) return null;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    ...(options?.withSeconds ? { second: "2-digit" } : {}),
    timeZone,
    ...(options?.withZoneAbbr ? { timeZoneName: "short" } : {}),
  }).format(date);
}

export function formatClockTime(iso: string, timeZone: string, options?: TimeFormatOptions): string {
  return formatTimeParts(iso, timeZone, options) ?? "--:--";
}

export function formatTimeRange(
  startIso: string,
  endIso: string,
  timeZone: string,
  options?: TimeFormatOptions,
): string {
  const start = formatClockTime(startIso, timeZone);
  const end = formatClockTime(endIso, timeZone, options);
  return `${start}\u2013${end}`;
}
