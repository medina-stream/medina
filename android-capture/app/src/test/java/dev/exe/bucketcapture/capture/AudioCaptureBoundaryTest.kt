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

    @Test fun `early roll not due for a just-started segment`() {
        val start = Instant.parse("2026-09-18T03:30:00Z").toEpochMilli()
        assertFalse(AudioCapture.earlyRollDue(start, start + 5_000L))
        assertFalse(AudioCapture.earlyRollDue(start, start + AudioCapture.MIN_EARLY_ROLL_AGE_MS - 1))
    }

    @Test fun `early roll due once the segment is old enough`() {
        val start = Instant.parse("2026-09-18T03:30:00Z").toEpochMilli()
        assertTrue(AudioCapture.earlyRollDue(start, start + AudioCapture.MIN_EARLY_ROLL_AGE_MS))
        // The foreground-after-a-while case: most of a 15-minute segment in.
        assertTrue(AudioCapture.earlyRollDue(start, start + 12 * 60_000L))
    }

    @Test fun `segment after an early roll still ends at the next boundary`() {
        // Early roll at 03:37:00: the follow-on segment's rollover delay is
        // computed from the roll moment, so it still seals at 03:45:00.
        val rollAt = Instant.parse("2026-09-18T03:37:00Z").toEpochMilli()
        assertEquals(480_000L, AudioCapture.millisToNextBoundary(rollAt, seg))
    }
}
