package dev.exe.bucketcapture.capture

import android.app.*
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import dev.exe.bucketcapture.CaptureApplication
import dev.exe.bucketcapture.MainActivity
import dev.exe.bucketcapture.R
import dev.exe.bucketcapture.transcribe.LiveTranscriber
import dev.exe.bucketcapture.upload.SyncScheduler
import kotlinx.coroutines.*

class CaptureService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var audio: AudioCapture
    private lateinit var location: LocationCapture
    private lateinit var live: LiveTranscriber
    private var locationSeal: Job? = null
    override fun onCreate() {
        super.onCreate(); ensureChannel()
        val app = application as CaptureApplication
        audio = AudioCapture(app.spool, scope, ::showError)
        location = LocationCapture(this, app.spool, scope, ::showError)
        live = LiveTranscriber(this, app.spool, scope)
        audio.onSegmentStart = { info -> live.onSegment(info.id, info.startedAtMs) }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action ?: ACTION_START) {
            ACTION_STOP -> stopCapture()
            ACTION_SYNC -> SyncScheduler.schedule(this, explicit = true)
            ACTION_REPOLICY -> {
                // May arrive via startForegroundService while capture is not running:
                // promote immediately so the system never sees an unpromoted start,
                // then bail out if capture isn't desired (the next start reads the policy fresh).
                startForeground(NOTIFICATION_ID, notification("Bucket Capture"))
                reloadPolicy()
            }
            else -> {
                startForeground(NOTIFICATION_ID, notification("Audio and location capture active"))
                getSharedPreferences("capture", MODE_PRIVATE).edit().putBoolean("desired", true).apply()
                val policy = (application as CaptureApplication).policies.currentPolicy()
                if (policy.audio.enabled) { audio.start(policy.audio); live.start() } else showError("Audio capture is disabled by the capture policy")
                if (policy.gps.enabled) location.start(policy.gps)
                locationSeal?.cancel()
                locationSeal = scope.launch { while (isActive) { delay(15 * 60 * 1000L); (application as CaptureApplication).spool.sealLocations() } }
            }
        }
        return START_STICKY
    }
    /** A refreshed policy arrived while capturing: restart the components so the new parameters take effect. */
    private fun reloadPolicy() {
        if (!getSharedPreferences("capture", MODE_PRIVATE).getBoolean("desired", false)) { stopSelf(); return }
        val policy = (application as CaptureApplication).policies.currentPolicy()
        scope.launch {
            if (policy.audio.enabled) { audio.restart(policy.audio); live.start() } else { audio.stop(); live.stop(); showError("Audio capture is disabled by the capture policy") }
            if (policy.gps.enabled) location.restart(policy.gps) else location.stop()
        }
    }
    private fun stopCapture() { getSharedPreferences("capture", MODE_PRIVATE).edit().putBoolean("desired", false).apply(); location.stop(); live.stop(); locationSeal?.cancel(); scope.launch { audio.stop(); (application as CaptureApplication).spool.sealLocations(); SyncScheduler.schedule(this@CaptureService); stopSelf() } }
    private fun showError(message: String) { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(message)) }
    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        fun service(action: String, code: Int) = PendingIntent.getService(this, code, Intent(this, CaptureService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_capture).setContentTitle("Bucket Capture")
            .setContentText(text).setOngoing(true).setContentIntent(open).setOnlyAlertOnce(true)
            .addAction(0, "Sync", service(ACTION_SYNC, 1)).addAction(0, "Stop", service(ACTION_STOP, 2)).build()
    }
    private fun ensureChannel() { getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "Active capture", NotificationManager.IMPORTANCE_LOW)) }
    override fun onDestroy() { live.stop(); location.stop(); scope.cancel(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
    companion object { const val ACTION_START = "capture.start"; const val ACTION_STOP = "capture.stop"; const val ACTION_SYNC = "capture.sync"; const val ACTION_REPOLICY = "capture.repolicy"; const val CHANNEL = "capture"; const val NOTIFICATION_ID = 1001 }
}
