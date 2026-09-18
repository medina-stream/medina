package dev.exe.bucketcapture.data

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import java.time.Duration

/**
 * The capture policy: a server-owned JSON document fetched from a single
 * capability URL. The URL itself is the credential; the policy carries
 * everything else, including the bucket upload secrets.
 *
 * The app treats the policy as advisory data, never as code: the shape is
 * validated, unknown fields are ignored, the last-known-good document is
 * kept when a fetch fails, and capture never stops just because the
 * server is unreachable. A 404 (unknown/revoked token) is the one
 * terminal state and is surfaced loudly.
 */

data class PolicyAudio(
    val enabled: Boolean = true,
    val codec: String = "aac",
    val channels: Int = 1,
    val sampleRateHz: Int = 16000,
    val bitrateBps: Int = 32000,
    val segmentSeconds: Int = 900,
) {
    fun describe() = "$codec · ${if (channels == 1) "mono" else "$channels-ch"} · ${sampleRateHz / 1000}kHz · ${segmentSeconds / 60}min segments"
}

data class PolicyGps(
    val enabled: Boolean = true,
    val intervalSeconds: Int = 30,
    val minUpdateDistanceMeters: Int = 50,
    val minAccuracyMeters: Int = 100,
) {
    fun describe() = "every ${intervalSeconds}s · ≥${minUpdateDistanceMeters}m · ≤${minAccuracyMeters}m accuracy"
}

data class PolicyUpload(
    val endpoint: String = "",
    val bucket: String = "",
    val region: String = "us-east-1",
    val prefix: String = "",
    val accessKeyId: String = "",
    val secretAccessKey: String = "",
    val unmeteredOnly: Boolean = true,
) {
    fun normalizedPrefix(): String = prefix.trim('/').let { if (it.isEmpty()) "" else "$it/" }
    fun isComplete() = endpoint.startsWith("https://") && bucket.isNotBlank() && region.isNotBlank() &&
        accessKeyId.isNotBlank() && secretAccessKey.isNotBlank()
    fun describe() = if (bucket.isBlank()) "not configured" else "$bucket · ${endpoint.removePrefix("https://").substringBefore("/")}"
}

data class CapturePolicy(
    val version: Int = 1,
    val updatedAt: String = "",
    val audio: PolicyAudio = PolicyAudio(),
    val gps: PolicyGps = PolicyGps(),
    val upload: PolicyUpload = PolicyUpload(),
)

/** Newest policy version this app build understands. */
const val MAX_POLICY_VERSION = 1

sealed interface PolicyFetchResult {
    /** A fresh, validated policy. `raw` is the exact body, cached verbatim. */
    data class Success(val policy: CapturePolicy, val raw: String, val changed: Boolean) : PolicyFetchResult
    /** Transient failure (network, 5xx, malformed body): keep last-known-good. */
    data class Transient(val detail: String) : PolicyFetchResult
    /** 404: the token is unknown or revoked. Terminal until a new URL is entered. */
    data object Revoked : PolicyFetchResult
}

/** Parses and validates a policy document. Returns null when it must not be trusted. */
fun parsePolicy(raw: String): CapturePolicy? = runCatching {
    val root = JSONObject(raw)
    val version = root.optInt("version", 1)
    if (version < 1 || version > MAX_POLICY_VERSION) return null
    val audioJson = root.optJSONObject("audio") ?: JSONObject()
    val codec = audioJson.optString("codec", "aac")
    if (codec != "aac") return null
    val channels = audioJson.optInt("channels", 1)
    val sampleRateHz = audioJson.optInt("sampleRateHz", 16000)
    val bitrateBps = audioJson.optInt("bitrateBps", 32000)
    val segmentSeconds = audioJson.optInt("segmentSeconds", 900)
    if (channels !in 1..2 || sampleRateHz !in setOf(8000, 16000, 22050, 44100, 48000) ||
        bitrateBps !in 8000..320000 || segmentSeconds !in 60..3600) return null
    val gpsJson = root.optJSONObject("gps") ?: JSONObject()
    val intervalSeconds = gpsJson.optInt("intervalSeconds", 30)
    val minDistance = gpsJson.optInt("minUpdateDistanceMeters", 50)
    val minAccuracy = gpsJson.optInt("minAccuracyMeters", 100)
    if (intervalSeconds !in 5..3600 || minDistance !in 0..10000 || minAccuracy !in 1..1000) return null
    val uploadJson = root.optJSONObject("upload") ?: JSONObject()
    CapturePolicy(
        version = version,
        updatedAt = root.optString("updatedAt", ""),
        audio = PolicyAudio(
            enabled = audioJson.optBoolean("enabled", true),
            codec = codec, channels = channels, sampleRateHz = sampleRateHz,
            bitrateBps = bitrateBps, segmentSeconds = segmentSeconds,
        ),
        gps = PolicyGps(
            enabled = gpsJson.optBoolean("enabled", true),
            intervalSeconds = intervalSeconds,
            minUpdateDistanceMeters = minDistance,
            minAccuracyMeters = minAccuracy,
        ),
        upload = PolicyUpload(
            endpoint = uploadJson.optString("endpoint", ""),
            bucket = uploadJson.optString("bucket", ""),
            region = uploadJson.optString("region", "us-east-1"),
            prefix = uploadJson.optString("prefix", ""),
            accessKeyId = uploadJson.optString("accessKeyId", ""),
            secretAccessKey = uploadJson.optString("secretAccessKey", ""),
            unmeteredOnly = uploadJson.optBoolean("unmeteredOnly", true),
        ),
    )
}.getOrNull()

class PolicyFetcher(private val client: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(Duration.ofSeconds(15)).readTimeout(Duration.ofSeconds(30)).build()) {

    /** Fetches the policy document. `cachedRaw` is the last-known-good body for change detection. */
    fun fetch(url: String, cachedRaw: String?): PolicyFetchResult {
        val request = try {
            Request.Builder().url(url.trim()).header("Accept", "application/json").build()
        } catch (e: IllegalArgumentException) {
            return PolicyFetchResult.Transient("Policy URL is not a valid URL")
        }
        val response = try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            return PolicyFetchResult.Transient(e.message ?: "Network error")
        }
        response.use {
            if (it.code == 404) return PolicyFetchResult.Revoked
            if (!it.isSuccessful) return PolicyFetchResult.Transient("Server returned HTTP ${it.code}")
            val body = it.body?.string() ?: return PolicyFetchResult.Transient("Empty policy response")
            val policy = parsePolicy(body) ?: return PolicyFetchResult.Transient("Policy document failed validation")
            return PolicyFetchResult.Success(policy, raw = body, changed = body != cachedRaw)
        }
    }
}
