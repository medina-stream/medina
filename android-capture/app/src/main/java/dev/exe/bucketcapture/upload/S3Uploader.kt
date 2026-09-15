package dev.exe.bucketcapture.upload

import dev.exe.bucketcapture.data.BucketSettings
import dev.exe.bucketcapture.data.UploadItem
import okhttp3.*
import okio.BufferedSink
import java.io.File
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

sealed interface PutResult {
    data object Success : PutResult
    data class Retry(val detail: String) : PutResult
    data class ConfigurationError(val detail: String) : PutResult
}

class S3Uploader(private val client: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(java.time.Duration.ofSeconds(20)).writeTimeout(java.time.Duration.ofMinutes(20))
    .readTimeout(java.time.Duration.ofSeconds(60)).build()) {
    suspend fun put(settings: BucketSettings, item: UploadItem): PutResult =
        put(settings, item.objectKey, File(item.localPath), item.contentType, item.contentMd5)

    suspend fun probe(settings: BucketSettings, key: String): PutResult {
        val file = kotlin.io.path.createTempFile("bucket-probe", ".empty").toFile()
        return try { put(settings, key, file, "application/octet-stream", "1B2M2Y8AsgTpgAmY7PhCfg==") } finally { file.delete() }
    }

    private suspend fun put(settings: BucketSettings, key: String, file: File, type: String, md5: String): PutResult {
        if (!settings.isComplete()) return PutResult.ConfigurationError("Complete HTTPS bucket settings first")
        if (!file.exists()) return PutResult.ConfigurationError("Local payload is missing")
        val endpoint = URI(settings.endpoint.trimEnd('/'))
        val encodedKey = key.split('/').joinToString("/") { encode(it) }
        val path = "/${encode(settings.bucket)}/$encodedKey"
        val url = HttpUrl.Builder().scheme(endpoint.scheme).host(endpoint.host)
            .port(if (endpoint.port == -1) 443 else endpoint.port)
            .encodedPath((endpoint.rawPath ?: "").trimEnd('/') + path).build()
        val now = Instant.now()
        val payloadHash = sha256(file)
        val headers = SigV4.headers("PUT", url, settings.region, settings.accessKey, settings.secretKey, payloadHash, md5, type, now)
        val body = object : RequestBody() {
            // Content-Type is set explicitly from the signed headers map; body type intentionally null.
            override fun contentType(): MediaType? = null
            override fun contentLength() = file.length()
            override fun writeTo(sink: BufferedSink) { file.inputStream().use { input ->
                val buf = ByteArray(8192)
                while (true) { val n = input.read(buf); if (n < 0) break; sink.write(buf, 0, n) }
            } }
        }
        val request = Request.Builder().url(url).put(body).apply { headers.forEach { (k, v) -> header(k, v) } }.build()
        return try {
            client.newCall(request).await().use { response ->
                when {
                    response.isSuccessful -> PutResult.Success
                    response.code in listOf(408, 425, 429) || response.code >= 500 -> PutResult.Retry("HTTP ${response.code}")
                    else -> PutResult.ConfigurationError("HTTP ${response.code}: check endpoint, region, bucket policy, and credentials")
                }
            }
        } catch (e: java.io.IOException) { PutResult.Retry(e.message ?: "Network error") }
    }

    private fun sha256(file: File): String { val md = MessageDigest.getInstance("SHA-256"); file.inputStream().use { input ->
        val b = ByteArray(64 * 1024); while (true) { val n = input.read(b); if (n < 0) break; md.update(b, 0, n) }
    }; return md.digest().joinToString("") { "%02x".format(it) } }
    private fun encode(value: String) = URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20").replace("%7E", "~")
}

object SigV4 {
    private val day = DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneOffset.UTC)
    private val timestamp = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC)
    fun headers(method: String, url: HttpUrl, region: String, access: String, secret: String, payloadHash: String, md5: String, type: String, now: Instant): Map<String, String> {
        val date = day.format(now); val amzDate = timestamp.format(now)
        val canonicalHeaders = "content-md5:$md5\ncontent-type:$type\nhost:${url.hostHeader()}\nx-amz-content-sha256:$payloadHash\nx-amz-date:$amzDate\n"
        val signed = "content-md5;content-type;host;x-amz-content-sha256;x-amz-date"
        val canonicalRequest = listOf(method, url.encodedPath, url.encodedQuery ?: "", canonicalHeaders, signed, payloadHash).joinToString("\n")
        val scope = "$date/$region/s3/aws4_request"
        val toSign = "AWS4-HMAC-SHA256\n$amzDate\n$scope\n${hex(hash(canonicalRequest.toByteArray()))}"
        val signingKey = hmac(hmac(hmac(hmac(("AWS4$secret").toByteArray(), date), region), "s3"), "aws4_request")
        val authorization = "AWS4-HMAC-SHA256 Credential=$access/$scope, SignedHeaders=$signed, Signature=${hex(hmac(signingKey, toSign))}"
        return mapOf("Content-MD5" to md5, "Content-Type" to type, "x-amz-content-sha256" to payloadHash, "x-amz-date" to amzDate, "Authorization" to authorization)
    }
    private fun HttpUrl.hostHeader() = if (port == 443 && scheme == "https" || port == 80 && scheme == "http") host else "$host:$port"
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
    private fun hmac(key: ByteArray, value: String): ByteArray = Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(value.toByteArray()) }
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
}

private suspend fun Call.await(): Response = kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: java.io.IOException) { if (continuation.isActive) continuation.resumeWith(Result.failure(e)) }
        override fun onResponse(call: Call, response: Response) {
            if (continuation.isActive) continuation.resumeWith(Result.success(response)) else response.close()
        }
    })
}
