package dev.exe.bucketcapture.upload

import dev.exe.bucketcapture.data.UploadItem
import dev.exe.bucketcapture.data.UploadState
import org.junit.Assert.assertEquals
import org.junit.Test

private fun item(id: String, kind: String, createdAt: Long) = UploadItem(
    id = id, objectKey = "k/$id", kind = kind, localPath = "/tmp/$id",
    contentType = "application/octet-stream", byteCount = 10, contentMd5 = "x",
    createdAt = createdAt, state = UploadState.PENDING,
)

class ForegroundSelectTest {
    @Test fun `metered pass takes locations transcripts and only the newest audio`() {
        val pending = listOf(
            item("a1", "audio", 1000),
            item("a2", "audio", 2000),
            item("a3", "audio", 3000),
            item("l1", "location", 1500),
            item("l2", "location", 2500),
            item("t1", "transcript", 2800),
        )
        val selected = selectForegroundItems(pending)
        assertEquals(listOf("l1", "l2", "t1", "a3"), selected.map { it.id })
    }

    @Test fun `metered pass with no audio still sends locations`() {
        val pending = listOf(item("l1", "location", 1500))
        assertEquals(listOf("l1"), selectForegroundItems(pending).map { it.id })
    }

    @Test fun `empty pending selects nothing`() {
        assertEquals(emptyList<UploadItem>(), selectForegroundItems(emptyList()))
    }
}
