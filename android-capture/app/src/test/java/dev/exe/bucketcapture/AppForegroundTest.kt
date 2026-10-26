package dev.exe.bucketcapture

import org.junit.Assert.*
import org.junit.Test

class AppForegroundTest {
    @Test fun `transcription follows foreground state`() {
        // JVM tests share one process; restore the background default after.
        try {
            AppForeground.setForeground(false)
            assertFalse(AppForeground.isForeground)
            assertFalse(AppForeground.transcriptionAllowed())

            AppForeground.setForeground(true)
            assertTrue(AppForeground.isForeground)
            assertTrue(AppForeground.transcriptionAllowed())

            AppForeground.setForeground(false)
            assertFalse(AppForeground.transcriptionAllowed())
        } finally {
            AppForeground.setForeground(false)
        }
    }
}
