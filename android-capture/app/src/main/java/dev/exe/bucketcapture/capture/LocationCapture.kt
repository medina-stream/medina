package dev.exe.bucketcapture.capture

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Looper
import androidx.core.content.ContextCompat
import com.google.android.gms.location.*
import dev.exe.bucketcapture.data.LocationFix
import dev.exe.bucketcapture.data.PolicyGps
import dev.exe.bucketcapture.data.SpoolRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Adaptive location capture with two gears, switched by the OS activity
 * classifier:
 *
 * - STILL: balanced-power accuracy, slow interval. Cheap heartbeat.
 * - MOVING: high accuracy, fast interval. Real GPS while it buys information.
 *
 * Each fix is emitted as a `location.fix` device event (see
 * [SpoolRepository.emitLocationEvent]) rather than accumulated into sealed
 * batches. Every fix carries the current activity label so the server never
 * has to guess transport mode from GPS speed.
 */
class LocationCapture(private val context: Context, private val spool: SpoolRepository, private val scope: CoroutineScope, private val onError: (String) -> Unit) {
    private val client = LocationServices.getFusedLocationProviderClient(context)
    private var callback: LocationCallback? = null
    private var gearJob: Job? = null
    private var config: PolicyGps = PolicyGps()
    private var gear: Gear = Gear.STILL
    private var lastActivity: ActivityReading? = null

    private enum class Gear(val priority: Int) {
        STILL(Priority.PRIORITY_BALANCED_POWER_ACCURACY),
        MOVING(Priority.PRIORITY_HIGH_ACCURACY)
    }

    private fun intervalMs(gear: Gear): Long = when (gear) {
        Gear.STILL -> config.intervalSeconds * 1000L
        Gear.MOVING -> config.movingIntervalSeconds * 1000L
    }

    @SuppressLint("MissingPermission")
    fun start(gps: PolicyGps = config, activities: StateFlow<ActivityReading?>? = null) {
        if (callback != null) return
        config = gps
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            onError("Location permission is not granted"); return
        }
        gear = Gear.STILL
        requestUpdates()
        gearJob = activities?.let { flow ->
            scope.launch {
                flow.collect { reading ->
                    lastActivity = reading
                    if (config.adaptive) {
                        val want = if (reading != null && reading.confidence >= 50 && reading.activity.moving) Gear.MOVING else Gear.STILL
                        if (want != gear) {
                            gear = want
                            restartRequest()
                        }
                    }
                }
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun requestUpdates() {
        val request = LocationRequest.Builder(gear.priority, intervalMs(gear))
            .setMinUpdateDistanceMeters(config.minUpdateDistanceMeters.toFloat())
            .setMaxUpdateDelayMillis(intervalMs(gear) * 4).build()
        callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) { result.locations.forEach { l ->
                if (l.latitude in -90.0..90.0 && l.longitude in -180.0..180.0 && (!l.hasAccuracy() || l.accuracy <= config.minAccuracyMeters)) scope.launch {
                    spool.emitLocationEvent(
                        LocationFix(capturedAt = l.time, elapsedRealtimeNanos = l.elapsedRealtimeNanos,
                            latitude = l.latitude, longitude = l.longitude, accuracy = l.accuracy,
                            altitude = l.takeIf { it.hasAltitude() }?.altitude, speed = l.takeIf { it.hasSpeed() }?.speed,
                            bearing = l.takeIf { it.hasBearing() }?.bearing, isMock = l.isMock),
                        lastActivity
                    )
                }
            }}
        }
        client.requestLocationUpdates(request, callback!!, Looper.getMainLooper()).addOnFailureListener { onError("Location failed: ${it.message}") }
    }

    private fun restartRequest() {
        callback?.let { client.removeLocationUpdates(it) }
        callback = null
        requestUpdates()
    }

    fun stop() {
        gearJob?.cancel(); gearJob = null
        callback?.let { client.removeLocationUpdates(it) }; callback = null
    }

    fun restart(gps: PolicyGps, activities: StateFlow<ActivityReading?>? = null) { stop(); start(gps, activities) }
}
