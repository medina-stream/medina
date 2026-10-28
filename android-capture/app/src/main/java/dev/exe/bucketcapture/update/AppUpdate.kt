package dev.exe.bucketcapture.update

import android.content.Context
import dev.exe.bucketcapture.BuildConfig
import dev.exe.bucketcapture.data.CapturePolicy
import dev.exe.bucketcapture.data.PolicyApk
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Self-hosted update checks. The capture policy — already fetched on a
 * schedule and on foreground — names the newest published build; when
 * its stamp beats the stamp baked into this build, the offer surfaces
 * on the main screen until installed or dismissed. Dismissal is
 * per-stamp: the next newer build offers itself again.
 *
 * The check rides entirely on policy application, so it costs no extra
 * network traffic — and, by the same token, it can only fire when a
 * policy fetch actually reaches the server (the policy URL must be
 * publicly reachable for updates to arrive off the home network).
 */
object AppUpdate {
    /**
     * Pure: the update a policy offers this build, or null. Stamps are
     * fixed-width ("0" + UTC yyyyMMddHHmm), so string order is time
     * order. An unstamped dev build ("0000000000000") is offered every
     * published build.
     */
    fun availableFor(installedStamp: String, policy: CapturePolicy): PolicyApk? {
        val apk = policy.apk ?: return null
        if (apk.stamp.length != installedStamp.length) return null
        return apk.takeIf { it.stamp > installedStamp }
    }

    private val _available = MutableStateFlow<PolicyApk?>(null)
    val available: StateFlow<PolicyApk?> = _available.asStateFlow()

    /** Called whenever a policy is applied — a fresh fetch on any path,
     * or the cached policy at startup. */
    fun onPolicyApplied(context: Context, policy: CapturePolicy) {
        val offered = availableFor(BuildConfig.APK_STAMP, policy)
        val dismissed = prefs(context).getString(KEY_DISMISSED, null)
        _available.value = offered?.takeIf { it.stamp != dismissed }
    }

    fun dismiss(context: Context, stamp: String) {
        prefs(context).edit().putString(KEY_DISMISSED, stamp).apply()
        if (_available.value?.stamp == stamp) _available.value = null
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences("app_update", Context.MODE_PRIVATE)

    private const val KEY_DISMISSED = "dismissed_stamp"
}
