package dev.exe.bucketcapture.upload

import android.content.Context
import androidx.work.*
import dev.exe.bucketcapture.CaptureApplication
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val app = applicationContext as CaptureApplication
        val settings = app.settings.load()
        if (!settings.isComplete()) return@withContext Result.failure(workDataOf("error" to "Bucket settings are incomplete"))
        for (item in app.db.manifest().pending()) {
            val file = File(item.localPath)
            if (!file.isFile || file.length() != item.byteCount) {
                app.db.manifest().failed(item.id, "Local payload missing or size changed")
                continue
            }
            when (val result = app.uploader.put(settings, item)) {
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

object SyncScheduler {
    private const val UNIQUE = "bucket-upload"
    fun schedule(context: Context, explicit: Boolean = false) {
        val app = context.applicationContext as CaptureApplication
        val type = if (!explicit && app.settings.load().unmeteredOnly) NetworkType.UNMETERED else NetworkType.CONNECTED
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(type).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE, ExistingWorkPolicy.REPLACE, request)
    }
}
