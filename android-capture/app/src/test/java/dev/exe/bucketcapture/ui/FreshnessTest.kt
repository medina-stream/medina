package dev.exe.bucketcapture.ui

import org.junit.Assert.*
import org.junit.Test

class FreshnessTest {
    private val now = 1_750_000_000_000L

    @Test fun `null means nothing synced yet`() {
        assertEquals("Nothing synced yet", lastSyncedText(now, null))
    }

    @Test fun `under a minute is just now`() {
        assertEquals("just now", lastSyncedText(now, now - 30_000))
    }

    @Test fun `minutes bucket`() {
        assertEquals("5m ago", lastSyncedText(now, now - 5 * 60_000))
        assertEquals("59m ago", lastSyncedText(now, now - 59 * 60_000))
    }

    @Test fun `hours bucket`() {
        assertEquals("2h ago", lastSyncedText(now, now - 2 * 3_600_000))
        assertEquals("23h ago", lastSyncedText(now, now - 23 * 3_600_000))
    }

    @Test fun `a day ago is yesterday`() {
        assertEquals("Yesterday", lastSyncedText(now, now - 30 * 3_600_000))
    }

    @Test fun `older shows the date`() {
        val text = lastSyncedText(now, now - 5 * 24 * 3_600_000)
        assertTrue("expected MMM d, got: $text", text.matches(Regex("[A-Z][a-z]{2} \\d{1,2}")))
    }

    @Test fun `future timestamps clamp to just now`() {
        assertEquals("just now", lastSyncedText(now, now + 60_000))
    }

    @Test fun `amplitude normalizes to 0..1`() {
        assertEquals(0f, normalizeAmplitude(0))
        assertEquals(1f, normalizeAmplitude(32767), 0.001f)
        assertEquals(1f, normalizeAmplitude(99_999), 0.001f)
        assertEquals(0f, normalizeAmplitude(-5), 0.001f)
    }

    @Test fun `amplitude curve keeps quiet audio visible`() {
        // 1% of full scale should still read well above 1% on the meter.
        assertTrue(normalizeAmplitude(327) > 0.05f)
        // Monotonic: louder in, louder out.
        assertTrue(normalizeAmplitude(1000) < normalizeAmplitude(8000))
    }
}
