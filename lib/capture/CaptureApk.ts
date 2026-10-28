/**
 * Bucket Capture APK distribution: the naming contract shared by the
 * publish script, the policy document's `apk` section, and the serving
 * routes (the Medina server and the public medina-index Worker).
 *
 * APKs are public-safe artifacts — the APK contains no credentials (the
 * policy capability URL is entered per-device), so they are served
 * without auth. They live in the artifact bucket (sco-lifelog) under
 * `bucket-capture/<stamp>.apk` and are addressed on the site as
 * `/bucket-capture/<stamp>.apk`.
 *
 * A stamp is "0" + UTC `yyyyMMddHHmm` of build time: a fixed-width
 * 13-char string, so lexicographic order is chronological order and the
 * app can decide "is this newer than what I'm running" with one string
 * comparison.
 */

export const APK_BUCKET_PREFIX = "bucket-capture"
export const APK_CONTENT_TYPE = "application/vnd.android.package-archive"

const STAMP_PATTERN = /^0\d{12}$/

export const isApkStamp = (value: string): boolean => STAMP_PATTERN.test(value)

/** The stamp for a build moment: "0" + UTC yyyyMMddHHmm. */
export const apkStamp = (date: Date): string => {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0")
  return "0" + String(date.getUTCFullYear()).padStart(4, "0")
    + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate())
    + pad(date.getUTCHours()) + pad(date.getUTCMinutes())
}

/** Bucket object key for a stamp, or null when the stamp is malformed. */
export const apkKey = (stamp: string): string | null =>
  isApkStamp(stamp) ? `${APK_BUCKET_PREFIX}/${stamp}.apk` : null

/** Site path for a stamp: `/bucket-capture/<stamp>.apk`. */
export const apkPath = (stamp: string): string => `/bucket-capture/${stamp}.apk`

/** The stamp named by a `/bucket-capture/<stamp>.apk` file name, or null. */
export const stampFromFileName = (name: string): string | null => {
  const match = /^(0\d{12})\.apk$/.exec(name)
  return match?.[1] ?? null
}
