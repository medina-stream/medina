export function dayIdFromDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `0${y}${m}${d}`;
}

export function dateFromDayId(dayId: string): Date {
  const raw = dayId.startsWith("0") ? dayId.slice(1) : dayId;
  return new Date(Date.UTC(
    Number(raw.slice(0, 4)),
    Number(raw.slice(4, 6)) - 1,
    Number(raw.slice(6, 8)),
  ));
}

export function addDays(dayId: string, days: number): string {
  const date = dateFromDayId(dayId);
  date.setUTCDate(date.getUTCDate() + days);
  return dayIdFromDate(date);
}

export function getLastDayIds(count: number, from = new Date()): string[] {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate() - i,
    ));
    return dayIdFromDate(date);
  });
}
