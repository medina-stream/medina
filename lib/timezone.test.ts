import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getDefaultTimeZone, isValidTimeZone, localDateFromDayId, localDateOf, lookupTimeZone } from "./timezone";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("timezone lookup", () => {
  test("resolves common US coordinates to IANA zones", () => {
    expect(lookupTimeZone(37.7749, -122.4194)).toBe("America/Los_Angeles");
    expect(lookupTimeZone(40.7128, -74.006)).toBe("America/New_York");
  });

  test("returns null for invalid coordinates", () => {
    expect(lookupTimeZone(91, 0)).toBeNull();
    expect(lookupTimeZone(0, 181)).toBeNull();
    expect(lookupTimeZone(Number.NaN, 0)).toBeNull();
  });

  test("accepts valid ocean zones", () => {
    const timeZone = lookupTimeZone(0, -160);
    expect(timeZone).not.toBeNull();
    expect(isValidTimeZone(timeZone!)).toBe(true);
  });
});

describe("timezone validation", () => {
  test("probes Intl for validity", () => {
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("Etc/GMT+8")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });

  test("reads the default timezone at call time", () => {
    delete process.env.MEDINA_GPS_TIME_ZONE;
    expect(getDefaultTimeZone()).toBe("UTC");

    process.env.MEDINA_GPS_TIME_ZONE = "America/New_York";
    expect(getDefaultTimeZone()).toBe("America/New_York");

    process.env.MEDINA_GPS_TIME_ZONE = "Nope/Invalid";
    expect(getDefaultTimeZone()).toBe("UTC");
  });

  test("computes local dates across DST boundaries and global offsets", () => {
    expect(localDateOf("2026-03-08T04:30:00.000Z", "America/New_York")).toBe("2026-03-07");
    expect(localDateOf("2026-03-08T07:30:00.000Z", "America/New_York")).toBe("2026-03-08");
    expect(localDateOf("2026-11-01T03:30:00.000Z", "America/New_York")).toBe("2026-10-31");
    expect(localDateOf("2026-11-01T06:30:00.000Z", "America/New_York")).toBe("2026-11-01");
    expect(localDateOf("2026-07-22T14:30:00.000Z", "Asia/Tokyo")).toBe("2026-07-22");
    expect(localDateOf("2026-07-22T15:30:00.000Z", "Asia/Tokyo")).toBe("2026-07-23");
  });

  test("maps day ids to local date strings", () => {
    expect(localDateFromDayId("020260722")).toBe("2026-07-22");
  });
});
