package dev.exe.bucketcapture.capture

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.DetectedActivity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Transport-relevant labels from the OS activity classifier. This is the
 * primary transport-mode signal: cheap (the OS runs the classifier anyway)
 * and far more reliable than deriving motion from coarse GPS fixes.
 */
enum class TransportActivity(val label: String) {
    STILL("still"),
    WALKING("walking"),
    RUNNING("running"),
    CYCLING("cycling"),
    DRIVING("driving"),
    TILTING("tilting"),
    UNKNOWN("unknown");

    /** True when the user is plausibly in motion (fast GPS gear). */
    val moving: Boolean
        get() = this == WALKING || this == RUNNING || this == CYCLING || this == DRIVING

    companion object {
        fun fromDetected(type: Int): TransportActivity = when (type) {
            DetectedActivity.IN_VEHICLE -> DRIVING
            DetectedActivity.ON_BICYCLE -> CYCLING
            DetectedActivity.WALKING -> WALKING
            DetectedActivity.RUNNING -> RUNNING
            DetectedActivity.STILL -> STILL
            DetectedActivity.TILTING -> TILTING
            else -> UNKNOWN
        }
    }
}

data class ActivityReading(val activity: TransportActivity, val confidence: Int)

/**
 * Process-wide hub: the manifest-declared [ActivityReceiver] posts here, the
 * monitor (and location capture) reads. Needed because the activity client
 * only delivers via PendingIntent.
 */
internal object ActivityHub {
    val readings = MutableStateFlow<ActivityReading?>(null)
}

class ActivityReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!ActivityRecognitionResult.hasResult(intent)) return
        val best = ActivityRecognitionResult.extractResult(intent)?.mostProbableActivity ?: return
        ActivityHub.readings.value = ActivityReading(TransportActivity.fromDetected(best.type), best.confidence)
    }
}

/** Wraps ActivityRecognitionClient; exposes the latest reading as a flow. */
class ActivityMonitor(private val context: Context) {
    val current: StateFlow<ActivityReading?> = ActivityHub.readings
    private val client = ActivityRecognition.getClient(context)
    private var started = false

    private fun pendingIntent(): PendingIntent {
        val intent = Intent(context, ActivityReceiver::class.java).setAction(ACTION)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(context, 0, intent, flags)
    }

    fun start(detectionIntervalMs: Long = 30_000L) {
        if (started) return
        if (Build.VERSION.SDK_INT >= 29 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED
        ) return
        client.requestActivityUpdates(detectionIntervalMs, pendingIntent())
            .addOnSuccessListener { started = true }
    }

    fun stop() {
        if (!started) return
        client.removeActivityUpdates(pendingIntent())
        started = false
    }

    companion object {
        const val ACTION = "dev.exe.bucketcapture.ACTIVITY_UPDATE"
    }
}
