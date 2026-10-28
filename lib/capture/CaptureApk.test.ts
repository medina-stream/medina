import { describe, expect, test } from "bun:test"
import { apkKey, apkPath, apkStamp, isApkStamp, stampFromFileName } from "./CaptureApk.ts"

describe("CaptureApk stamps", () => {
  test("formats UTC build time with the leading 0", () => {
    expect(apkStamp(new Date("2026-10-28T03:17:45Z"))).toBe("0202610280317")
    expect(apkStamp(new Date("2026-01-05T00:03:00Z"))).toBe("0202601050003")
  })

  test("validates the fixed-width shape", () => {
    expect(isApkStamp("0202610280317")).toBe(true)
    expect(isApkStamp("202610280317")).toBe(false) // no leading 0, 12 chars
    expect(isApkStamp("02026102803170")).toBe(false) // too long
    expect(isApkStamp("02026102803ab")).toBe(false)
    expect(isApkStamp("")).toBe(false)
  })

  test("stamps order lexicographically by time", () => {
    const earlier = apkStamp(new Date("2026-10-28T03:17:00Z"))
    const later = apkStamp(new Date("2026-10-28T03:18:00Z"))
    const nextDay = apkStamp(new Date("2026-10-29T00:00:00Z"))
    expect(earlier < later).toBe(true)
    expect(later < nextDay).toBe(true)
  })

  test("keys and paths derive from valid stamps only", () => {
    expect(apkKey("0202610280317")).toBe("bucket-capture/0202610280317.apk")
    expect(apkKey("bogus")).toBeNull()
    expect(apkPath("0202610280317")).toBe("/bucket-capture/0202610280317.apk")
    expect(stampFromFileName("0202610280317.apk")).toBe("0202610280317")
    expect(stampFromFileName("0202610280317")).toBeNull()
    expect(stampFromFileName("../0202610280317.apk")).toBeNull()
    expect(stampFromFileName("latest.apk")).toBeNull()
  })
})
