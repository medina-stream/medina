package dev.exe.bucketcapture.update

import dev.exe.bucketcapture.data.CapturePolicy
import dev.exe.bucketcapture.data.PolicyApk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppUpdateTest {
    private fun policyWith(stamp: String?) = CapturePolicy(
        apk = stamp?.let {
            PolicyApk(
                stamp = it,
                url = "https://edge.example/bucket-capture/$it.apk",
                sha256 = "a".repeat(64),
                sizeBytes = 100,
                publishedAt = "2026-10-28T03:17:00Z",
            )
        },
    )

    @Test fun `newer policy stamp is offered`() {
        val offered = AppUpdate.availableFor("0202610272009", policyWith("0202610280317"))
        assertEquals("0202610280317", offered?.stamp)
    }

    @Test fun `same or older stamps are not offered`() {
        assertNull(AppUpdate.availableFor("0202610280317", policyWith("0202610280317")))
        assertNull(AppUpdate.availableFor("0202610280317", policyWith("0202610272009")))
    }

    @Test fun `no apk section means no offer`() {
        assertNull(AppUpdate.availableFor("0202610272009", policyWith(null)))
        assertNull(AppUpdate.availableFor("0202610272009", CapturePolicy()))
    }

    @Test fun `unstamped dev builds are offered every published build`() {
        val offered = AppUpdate.availableFor("0000000000000", policyWith("0202610280317"))
        assertEquals("0202610280317", offered?.stamp)
    }
}
