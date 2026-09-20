package dev.exe.bucketcapture.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.sqrt

/**
 * "Last synced …" value for the home screen, from the newest upload the
 * bucket confirmed (PUT 2xx → uploadedAt). Pure for testing.
 */
fun lastSyncedText(nowMs: Long, lastUploadedAtMs: Long?): String {
    if (lastUploadedAtMs == null) return "Nothing synced yet"
    val ageMs = (nowMs - lastUploadedAtMs).coerceAtLeast(0)
    return when {
        ageMs < 60_000 -> "just now"
        ageMs < 3_600_000 -> "${ageMs / 60_000}m ago"
        ageMs < 24 * 3_600_000 -> "${ageMs / 3_600_000}h ago"
        ageMs < 48 * 3_600_000 -> "Yesterday"
        else -> Instant.ofEpochMilli(lastUploadedAtMs).atZone(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofPattern("MMM d"))
    }
}

/**
 * Map a MediaRecorder peak amplitude (0..32767) to a 0..1 meter level.
 * getMaxAmplitude() is linear and speech lives near the bottom of its range,
 * so a square-root curve keeps quiet audio visible. Pure for testing.
 */
fun normalizeAmplitude(peak: Int): Float {
    val n = peak.coerceIn(0, 32767) / 32767f
    return sqrt(n).coerceIn(0f, 1f)
}
