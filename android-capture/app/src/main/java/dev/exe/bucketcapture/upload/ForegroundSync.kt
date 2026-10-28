package dev.exe.bucketcapture.upload

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.*
import dev.exe.bucketcapture.CaptureApplication
import dev.exe.bucketcapture.CaptureTelemetry
import dev.exe.bucketcapture.transcribe.ModelManager
import dev.exe.bucketcapture.transcribe.TranscribeWorker
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
 * - Rolls the in-progress audio segment early (see
 *   [dev.exe.bucketcapture.capture.AudioCapture.rollNow]) so "the latest
 *   recording" is uploadable now instead of waiting for the next
 *   clock-aligned 15-minute rollover.
 * - On an unmetered connection: full upload pass, like an explicit sync.
 * - On a metered connection: still go — every pending location batch and
 *   transcript plus the single newest audio segment. The backlog beyond that
 *   waits for wifi.
 *
 * The pass is enqueued only after the seals land, so the worker's pending
 * snapshot includes the just-sealed segment. It runs under its own unique
 * work name as EXPEDITED work with REPLACE: a fresh foreground always wins
 * over a stale queued pass and starts as soon as the platform allows. If
 * the expedited enqueue itself throws, a plain request is enqueued
 * instead — the pass is never dropped. The separate background unique
 * work is untouched, so a foreground pass never cancels a background one.
 * A 60s cooldown keeps rapid foreground/background cycles from queueing
 * churn.
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
        val latestOnly = !isUnmetered(app)
        // Seal fresh data on the way in, then enqueue the pass: the worker
        // snapshots the pending list when it starts, so the seals must land
        // first or the freshest items miss this pass entirely.
        CoroutineScope(Dispatchers.IO).launch {
            // Fresh fixes, so the newest GPS is in the pass.
            runCatching { app.spool.sealLocations() }
            // The in-progress recording, sealed early via the service's
            // recorder (published process-wide in CaptureTelemetry): the
            // newest sealed segment is then part of this pass even on a
            // metered connection. No-op when capture isn't running.
            runCatching { CaptureTelemetry.audio?.rollNow() }
            // Best-effort on-device transcription of the latest segment.
            runCatching { kickTranscription(app) }
            enqueueForegroundPass(app, latestOnly)
        }
    }

    /**
     * Enqueue the foreground pass as expedited work (REPLACE, so a fresh
     * foreground supersedes a stale queued pass). Android 12+ expedited
     * quota exhaustion degrades to a normal run via
     * [OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST]; if the
     * expedited enqueue throws outright, fall back to the plain request
     * rather than dropping the pass.
     */
    private fun enqueueForegroundPass(app: CaptureApplication, latestOnly: Boolean) {
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        val input = workDataOf(SyncScheduler.KEY_LATEST_ONLY to latestOnly)
        val expedited = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(constraints)
            .setInputData(input)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build()
        try {
            WorkManager.getInstance(app).enqueueUniqueWork(FOREGROUND_UNIQUE, ExistingWorkPolicy.REPLACE, expedited)
        } catch (e: Exception) {
            val plain = OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(constraints)
                .setInputData(input)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            runCatching {
                WorkManager.getInstance(app).enqueueUniqueWork(FOREGROUND_UNIQUE, ExistingWorkPolicy.REPLACE, plain)
            }
        }
    }

    private fun isUnmetered(context: Context): Boolean {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    /**
     * Best-effort local transcription: when the model is on device, transcribe
     * the latest sealed segment (once per segment); otherwise fetch the model
     * on unmetered wifi so a later foreground can transcribe.
     */
    private suspend fun kickTranscription(app: CaptureApplication) {
        if (ModelManager.isPresent(app)) {
            val latest = app.db.manifest().latestAudio() ?: return
            if (!TranscribeWorker.isTranscribed(app, latest.id)) {
                TranscribeWorker.schedule(app, latest.id)
            }
        } else if (isUnmetered(app)) {
            ModelManager.scheduleDownload(app)
        }
    }
}
