package dev.exe.bucketcapture.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Resolved upload configuration: always derived from the policy, never entered by hand. */
data class BucketSettings(
    val endpoint: String = "",
    val bucket: String = "",
    val region: String = "us-east-1",
    val accessKey: String = "",
    val secretKey: String = "",
    val prefix: String = "",
    val unmeteredOnly: Boolean = true,
) {
    fun normalizedPrefix(): String = prefix.trim('/').let { if (it.isEmpty()) "" else "$it/" }
    fun isComplete() = endpoint.startsWith("https://") && bucket.isNotBlank() && region.isNotBlank() && accessKey.isNotBlank() && secretKey.isNotBlank()
}

fun PolicyUpload.toBucketSettings() = BucketSettings(
    endpoint = endpoint, bucket = bucket, region = region,
    accessKey = accessKeyId, secretKey = secretAccessKey,
    prefix = prefix, unmeteredOnly = unmeteredOnly,
)

/** What the UI shows for the policy row. */
sealed interface PolicyState {
    /** No policy URL has ever been configured. */
    data object NotConfigured : PolicyState
    /** A URL is set but no policy has ever been fetched successfully. */
    data class Unreachable(val detail: String) : PolicyState
    /** Live policy; fetch failures since the last success are reported as stale. */
    data class Active(val policy: CapturePolicy, val fetchedAt: Long, val staleError: String? = null) : PolicyState
    /** The server answered 404: the token is unknown or revoked. */
    data object Revoked : PolicyState
}

/**
 * Owns the policy URL and the cached policy document. Both are encrypted
 * with the Android Keystore: the URL is itself a credential, and the
 * cached policy embeds the bucket upload secrets.
 *
 * Transitional fallback: installs that predate the policy still carry the
 * old hand-entered bucket settings. They keep working (and are reported
 * as "on-device settings") until a policy URL is configured and a policy
 * is fetched.
 */
class PolicyStore(context: Context) {
    private val prefs = context.getSharedPreferences("capture_policy", Context.MODE_PRIVATE)
    private val legacy = context.getSharedPreferences("bucket_settings", Context.MODE_PRIVATE)
    private val cipher = KeystoreCipher()
    private val fetcher = PolicyFetcher()

    var policyUrl: String
        get() = decrypt("policy_url")
        set(value) {
            prefs.edit().putString("policy_url", cipher.encrypt(value.trim())).putBoolean("revoked", false).apply()
        }

    val hasPolicyUrl: Boolean get() = policyUrl.isNotBlank()
    val isRevoked: Boolean get() = prefs.getBoolean("revoked", false)

    fun state(): PolicyState {
        if (isRevoked) return PolicyState.Revoked
        if (!hasPolicyUrl) return PolicyState.NotConfigured
        val policy = decrypt("policy_json").takeIf { it.isNotBlank() }?.let(::parsePolicy)
        if (policy == null) {
            val err = prefs.getString("last_error", null) ?: "no policy fetched yet"
            return PolicyState.Unreachable(err)
        }
        return PolicyState.Active(policy, prefs.getLong("fetched_at", 0), prefs.getString("stale_error", null))
    }

    /** The policy currently in force: cached, else defaults with empty credentials. */
    fun currentPolicy(): CapturePolicy =
        (state() as? PolicyState.Active)?.policy ?: CapturePolicy()

    /** Upload configuration: policy first, legacy hand-entered settings as fallback. */
    fun bucketSettings(): BucketSettings? {
        val fromPolicy = (state() as? PolicyState.Active)?.policy?.upload?.toBucketSettings()
        if (fromPolicy?.isComplete() == true) return fromPolicy
        return legacySettings()?.takeIf { it.isComplete() }
    }

    /** True when uploads run on the legacy hand-entered settings instead of a policy. */
    fun usingLegacySettings(): Boolean =
        (state() as? PolicyState.Active)?.policy?.upload?.toBucketSettings()?.isComplete() != true &&
            legacySettings()?.isComplete() == true

    fun uploadPrefix(): String = bucketSettings()?.normalizedPrefix().orEmpty()

    /** Fetches the policy; caches on success, records the error otherwise. */
    fun refresh(): PolicyFetchResult {
        val url = policyUrl
        if (url.isBlank()) return PolicyFetchResult.Transient("No policy URL configured")
        if (isRevoked) return PolicyFetchResult.Revoked
        val previous = decrypt("policy_json").ifBlank { null }
        return when (val result = fetcher.fetch(url, previous)) {
            is PolicyFetchResult.Success -> {
                prefs.edit()
                    .putString("policy_json", cipher.encrypt(result.raw))
                    .putLong("fetched_at", System.currentTimeMillis())
                    .putBoolean("revoked", false)
                    .remove("stale_error").remove("last_error")
                    .apply()
                result
            }
            is PolicyFetchResult.Transient -> {
                prefs.edit().putString(if (previous == null) "last_error" else "stale_error", result.detail).apply()
                result
            }
            PolicyFetchResult.Revoked -> {
                prefs.edit().putBoolean("revoked", true).apply()
                result
            }
        }
    }

    private fun legacySettings(): BucketSettings? {
        val endpoint = legacy.getString("endpoint", "").orEmpty()
        if (endpoint.isBlank() && legacy.getString("bucket", "").isNullOrBlank()) return null
        return BucketSettings(
            endpoint = endpoint,
            bucket = legacy.getString("bucket", "").orEmpty(),
            region = legacy.getString("region", "us-east-1").orEmpty(),
            accessKey = decryptLegacy("access"),
            secretKey = decryptLegacy("secret"),
            prefix = legacy.getString("prefix", "").orEmpty(),
            unmeteredOnly = legacy.getBoolean("unmetered", true),
        )
    }

    private fun decrypt(key: String) = prefs.getString(key, null)?.let { runCatching { cipher.decrypt(it) }.getOrDefault("") } ?: ""
    private fun decryptLegacy(key: String) = legacy.getString(key, null)?.let { runCatching { cipher.decrypt(it) }.getOrDefault("") } ?: ""
}

internal class KeystoreCipher {
    private val alias = "bucket-capture-credentials"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    fun encrypt(value: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(c.iv + c.doFinal(value.toByteArray()), Base64.NO_WRAP)
    }
    fun decrypt(value: String): String {
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        return String(c.doFinal(bytes.copyOfRange(12, bytes.size)))
    }
}
