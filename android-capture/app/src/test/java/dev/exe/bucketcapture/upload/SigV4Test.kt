package dev.exe.bucketcapture.upload

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class SigV4Test {
    @Test fun signatureIsStableAndSignsIntegrityHeaders() {
        val headers = SigV4.headers(
            "PUT", "https://objects.example.test/example/device/audio/item.m4a".toHttpUrl(), "us-east-1",
            "AKIDEXAMPLE", "secret", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "1B2M2Y8AsgTpgAmY7PhCfg==", "audio/mp4", Instant.parse("2026-09-14T12:34:56Z"),
        )
        assertEquals("20260914T123456Z", headers["x-amz-date"])
        assertTrue(headers.getValue("Authorization").contains("20260914/us-east-1/s3/aws4_request"))
        assertTrue(headers.getValue("Authorization").contains("content-md5;content-type;host;x-amz-content-sha256;x-amz-date"))
        assertEquals(headers, SigV4.headers("PUT", "https://objects.example.test/example/device/audio/item.m4a".toHttpUrl(), "us-east-1", "AKIDEXAMPLE", "secret", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "1B2M2Y8AsgTpgAmY7PhCfg==", "audio/mp4", Instant.parse("2026-09-14T12:34:56Z")))
    }
}
