package dev.exe.bucketcapture.upload

import android.content.Context
import androidx.core.content.ContextCompat
import androidx.work.*
import dev.exe.bucketcapture.CaptureApplication
import dev.exe.bucketcapture.capture.CaptureService
import dev.exe.bucketcapture.data.PolicyFetchResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val app = applicationContext as CaptureApplication
        var settings = app.policies.bucketSettings()
        if (settings == null) return@withContext Result.failure(workDataOf("error" to "No upload credentials: configure the policy URL"))
        for (item in app.db.manifest().pending()) {
            val file = File(item.localPath)
            if (!file.isFile || file.length() != item.byteCount) {
                app.db.manifest().failed(item.id, "Local payload missing or size changed")
                continue
            }
            var result = app.uploader.put(settings, item)
            // Credentials may have been rotated server-side: one policy refresh, then one retry.
            if (result is PutResult.ConfigurationError && result.detail.contains("HTTP 403")) {
                if (app.policies.refresh() is PolicyFetchResult.Success) {
                    settings = app.policies.bucketSettings()
                    if (settings != null) result = app.uploader.put(settings, item)
                }
            }
            when (result) {
                PutResult.Success -> {
                    if (app.db.manifest().uploaded(item.id, System.currentTimeMillis()) == 1 && (!file.exists() || file.delete())) app.db.manifest().cleared(item.id)
                }
                is PutResult.Retry -> { app.db.manifest().failed(item.id, result.detail); return@withContext Result.retry() }
                is PutResult.ConfigurationError -> { app.db.manifest().failed(item.id, result.detail); return@withContext Result.failure(workDataOf("error" to result.detail)) }
            }
        }
        Result.success()
    }
}

/** Periodically refreshes the capture policy. On a changed policy the
 * running capture service reloads it; on revocation the device stops
 * trusting the URL until a new one is entered. */
class PolicyWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val app = applicationContext as CaptureApplication
        if (!app.policies.hasPolicyUrl || app.policies.isRevoked) return@withContext Result.success()
        when (val result = app.policies.refresh()) {
            is PolicyFetchResult.Success -> {
                if (result.changed) {
                    val intent = android.content.Intent(app, CaptureService::class.java).setAction(CaptureService.ACTION_REPOLICY)
                    ContextCompat.startForegroundService(app, intent)
                }
                // A refreshed policy may have fixed credentials: kick the uploader.
                SyncScheduler.schedule(app)
                Result.success()
            }
            is PolicyFetchResult.Transient -> Result.retry()
            PolicyFetchResult.Revoked -> Result.success()
        }
    }
}

object SyncScheduler {
    private const val UNIQUE = "bucket-upload"
    private const val POLICY_UNIQUE = "capture-policy"
    fun schedule(context: Context, explicit: Boolean = false) {
        val app = context.applicationContext as CaptureApplication
        val settings = app.policies.bucketSettings()
        val type = if (!explicit && (settings?.unmeteredOnly != false)) NetworkType.UNMETERED else NetworkType.CONNECTED
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(type).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE, ExistingWorkPolicy.REPLACE, request)
    }
    /** Every six hours, on any connection: refresh the policy from the server. */
    fun schedulePolicy(context: Context) {
        val request = PeriodicWorkRequestBuilder<PolicyWorker>(6, TimeUnit.HOURS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(POLICY_UNIQUE, ExistingPeriodicWorkPolicy.KEEP, request)
    }
}
