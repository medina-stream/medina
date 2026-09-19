package dev.exe.bucketcapture.data

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class PolicyTest {
    private val valid = """
        {
          "version": 1, "updatedAt": "2026-09-18T00:00:00Z", "unknownFuture": true,
          "audio": { "enabled": true, "codec": "aac", "channels": 1, "sampleRateHz": 16000, "bitrateBps": 32000, "segmentSeconds": 900 },
          "gps": { "enabled": false, "intervalSeconds": 60, "minUpdateDistanceMeters": 25, "minAccuracyMeters": 50 },
          "upload": { "endpoint": "https://example.r2.cloudflarestorage.com", "bucket": "b", "region": "auto",
                      "prefix": "phone/", "accessKeyId": "AK", "secretAccessKey": "SK", "unmeteredOnly": false }
        }
    """.trimIndent()

    @Test fun `valid policy parses with unknown fields ignored`() {
        val policy = parsePolicy(valid)
        assertNotNull(policy)
        policy!!
        assertEquals(1, policy.version)
        assertEquals(16000, policy.audio.sampleRateHz)
        assertEquals(900, policy.audio.segmentSeconds)
        assertFalse(policy.gps.enabled)
        assertEquals(60, policy.gps.intervalSeconds)
        assertEquals("b", policy.upload.bucket)
        assertFalse(policy.upload.unmeteredOnly)
        assertTrue(policy.upload.toBucketSettings().isComplete())
        assertEquals("phone/", policy.upload.toBucketSettings().normalizedPrefix())
    }

    @Test fun `missing sections fall back to defaults`() {
        val policy = parsePolicy("""{"version":1}""")
        assertNotNull(policy)
        policy!!
        assertTrue(policy.audio.enabled)
        assertEquals(1, policy.audio.channels)
        assertEquals("", policy.upload.bucket)
        assertFalse(policy.upload.toBucketSettings().isComplete())
    }

    @Test fun `rejects hostile or nonsensical documents`() {
        assertNull(parsePolicy("""{"version":2}"""))                       // newer than the app understands
        assertNull(parsePolicy("""{"audio":{"codec":"mp3"}}"""))           // unsupported codec
        assertNull(parsePolicy("""{"audio":{"segmentSeconds":30}}"""))     // below minimum
        assertNull(parsePolicy("""{"gps":{"intervalSeconds":1}}"""))       // below minimum
        assertNull(parsePolicy("""{"audio":{"channels":8}}"""))            // above maximum
        assertNull(parsePolicy("not json at all"))
        assertNull(parsePolicy(""))
    }

    @Test fun `fetcher maps status codes`() {
        val server = MockWebServer()
        server.start()
        try {
            val base = server.url("/api/capture-policy/").toString()
            val fetcher = PolicyFetcher()

            server.enqueue(MockResponse().setResponseCode(200).setBody(valid))
            val ok = fetcher.fetch(base + "cpol_good", null)
            assertTrue(ok is PolicyFetchResult.Success)
            assertTrue((ok as PolicyFetchResult.Success).changed)

            server.enqueue(MockResponse().setResponseCode(200).setBody(valid))
            val unchanged = fetcher.fetch(base + "cpol_good", valid)
            assertTrue(unchanged is PolicyFetchResult.Success)
            assertFalse((unchanged as PolicyFetchResult.Success).changed)

            server.enqueue(MockResponse().setResponseCode(404))
            assertTrue(fetcher.fetch(base + "cpol_dead", null) is PolicyFetchResult.Revoked)

            server.enqueue(MockResponse().setResponseCode(500))
            assertTrue(fetcher.fetch(base + "cpol_x", null) is PolicyFetchResult.Transient)

            server.enqueue(MockResponse().setResponseCode(200).setBody("{\"audio\":{\"codec\":\"mp3\"}}"))
            assertTrue(fetcher.fetch(base + "cpol_x", null) is PolicyFetchResult.Transient)

            assertTrue(fetcher.fetch("::not a url::", null) is PolicyFetchResult.Transient)
        } finally {
            server.shutdown()
        }
    }

    @Test fun `gps adaptive fields parse with defaults`() {
        val policy = parsePolicy(valid)!!
        // The fixture has no adaptive fields: defaults apply.
        assertEquals(15, policy.gps.movingIntervalSeconds)
        assertTrue(policy.gps.activityRecognition)
        assertTrue(policy.gps.adaptive)

        val withAdaptive = valid.replace(
            "\"gps\": { \"enabled\": false, \"intervalSeconds\": 60, \"minUpdateDistanceMeters\": 25, \"minAccuracyMeters\": 50 }",
            "\"gps\": { \"enabled\": true, \"intervalSeconds\": 120, \"movingIntervalSeconds\": 10, \"minUpdateDistanceMeters\": 25, \"minAccuracyMeters\": 50, \"activityRecognition\": false, \"adaptive\": false }"
        )
        val parsed = parsePolicy(withAdaptive)!!
        assertEquals(120, parsed.gps.intervalSeconds)
        assertEquals(10, parsed.gps.movingIntervalSeconds)
        assertFalse(parsed.gps.activityRecognition)
        assertFalse(parsed.gps.adaptive)
    }
}
