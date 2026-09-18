package dev.exe.bucketcapture.capture

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class AudioCaptureBoundaryTest {
    private val seg = 900_000L

    @Test fun `exactly on a boundary waits a full segment`() {
        val onBoundary = Instant.parse("2026-09-18T03:30:00Z").toEpochMilli()
        assertEquals(seg, AudioCapture.millisToNextBoundary(onBoundary, seg))
    }

    @Test fun `mid-segment waits until the next clock boundary`() {
        // 03:32:05 -> next 15-min boundary 03:45:00, 12m55s away
        val now = Instant.parse("2026-09-18T03:32:05Z").toEpochMilli()
        assertEquals(775_000L, AudioCapture.millisToNextBoundary(now, seg))
    }

    @Test fun `one millisecond before a boundary`() {
        val now = Instant.parse("2026-09-18T03:44:59.999Z").toEpochMilli()
        assertEquals(1L, AudioCapture.millisToNextBoundary(now, seg))
    }

    @Test fun `works for other cadences`() {
        // 5-min grid: 03:32:05 -> next boundary 03:35:00, 2m55s away
        val now = Instant.parse("2026-09-18T03:32:05Z").toEpochMilli()
        assertEquals(175_000L, AudioCapture.millisToNextBoundary(now, 300_000L))
    }
}
