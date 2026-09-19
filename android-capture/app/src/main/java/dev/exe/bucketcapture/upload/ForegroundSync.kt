package dev.exe.bucketcapture.upload

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.*
import dev.exe.bucketcapture.CaptureApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/**
 * Aggressive sync on app foreground: the user just looked at the app, so make
 * the freshest data move now instead of waiting for the next background
 * trigger.
 *
 * - Seals any open location fixes first, so the newest GPS is in the pass.
 * - On an unmetered connection: full upload pass, like an explicit sync.
 * - On a metered connection: still go — every pending location batch and
 *   transcript plus the single newest audio segment. The backlog beyond that
 *   waits for wifi.
 *
 * Runs under its own unique work name with KEEP so a foreground kick never
 * cancels an in-flight background pass; a 60s cooldown keeps rapid
 * foreground/background cycles from queueing churn.
 */
object ForegroundSync {
    private const val FOREGROUND_UNIQUE = "bucket-upload-foreground"
    private const val COOLDOWN_MS = 60_000L

    fun kick(context: Context) {
        val app = context.applicationContext as CaptureApplication
        if (!app.policies.hasPolicyUrl || app.policies.isRevoked) return
        val prefs = app.getSharedPreferences("sync", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (now - prefs.getLong("last_foreground_kick", 0L) < COOLDOWN_MS) return
        prefs.edit().putLong("last_foreground_kick", now).apply()
        // Seal fresh fixes on the way in; the pass below picks the batch up.
        CoroutineScope(Dispatchers.IO).launch { runCatching { app.spool.sealLocations() } }
        val latestOnly = !isUnmetered(app)
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setInputData(workDataOf(SyncScheduler.KEY_LATEST_ONLY to latestOnly))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(app).enqueueUniqueWork(FOREGROUND_UNIQUE, ExistingWorkPolicy.KEEP, request)
    }

    private fun isUnmetered(context: Context): Boolean {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }
}
