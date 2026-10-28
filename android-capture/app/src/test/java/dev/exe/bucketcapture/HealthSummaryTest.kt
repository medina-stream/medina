package dev.exe.bucketcapture

import dev.exe.bucketcapture.data.UploadItem
import dev.exe.bucketcapture.data.UploadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HealthSummaryTest {
    private fun item(
        id: String,
        state: UploadState,
        lastError: String? = null,
        createdAt: Long = 0,
    ) = UploadItem(
        id = id, objectKey = "k/$id", kind = "audio", localPath = "", contentType = "audio/mp4",
        byteCount = 1, contentMd5 = "", createdAt = createdAt, state = state, lastError = lastError,
    )

    @Test fun `uploaded rows carrying stale errors do not count as errors`() {
        // The field case: rows a racing pass stamped with an offline
        // error after another pass had already uploaded them.
        val items = listOf(
            item("a", UploadState.UPLOADED, lastError = "Failed to connect to example.r2.cloudflarestorage.com:443", createdAt = 3),
            item("b", UploadState.UPLOADED, lastError = "timeout", createdAt = 2),
            item("c", UploadState.UPLOADED, createdAt = 1),
        )
        val summary = summarizeHealth(items)
        assertEquals(0, summary.pending)
        assertEquals(3, summary.uploaded)
        assertEquals(0, summary.errorCount)
        assertNull(summary.lastError)
    }

    @Test fun `pending rows with errors count, newest error wins`() {
        val items = listOf(
            item("a", UploadState.PENDING, lastError = "older failure", createdAt = 1),
            item("b", UploadState.PENDING, lastError = "newer failure", createdAt = 5),
            item("c", UploadState.PENDING, createdAt = 9),
            item("d", UploadState.UPLOADED, lastError = "stale, ignored", createdAt = 99),
        )
        val summary = summarizeHealth(items)
        assertEquals(3, summary.pending)
        assertEquals(1, summary.uploaded)
        assertEquals(2, summary.errorCount)
        assertEquals("newer failure", summary.lastError)
    }

    @Test fun `empty spool is nominal`() {
        val summary = summarizeHealth(emptyList())
        assertEquals(0, summary.pending)
        assertEquals(0, summary.uploaded)
        assertEquals(0, summary.errorCount)
        assertNull(summary.lastError)
    }
}
