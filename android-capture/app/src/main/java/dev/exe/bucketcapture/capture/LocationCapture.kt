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
import kotlinx.coroutines.launch

class LocationCapture(private val context: Context, private val spool: SpoolRepository, private val scope: CoroutineScope, private val onError: (String) -> Unit) {
    private val client = LocationServices.getFusedLocationProviderClient(context)
    private var callback: LocationCallback? = null
    private var config: PolicyGps = PolicyGps()
    @SuppressLint("MissingPermission")
    fun start(gps: PolicyGps = config) {
        if (callback != null) return
        config = gps
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            onError("Location permission is not granted"); return
        }
        val request = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, config.intervalSeconds * 1000L)
            .setMinUpdateDistanceMeters(config.minUpdateDistanceMeters.toFloat())
            .setMaxUpdateDelayMillis(config.intervalSeconds * 4000L).build()
        callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) { result.locations.forEach { l ->
                if (l.latitude in -90.0..90.0 && l.longitude in -180.0..180.0 && (!l.hasAccuracy() || l.accuracy <= config.minAccuracyMeters)) scope.launch {
                    spool.addFix(LocationFix(capturedAt = l.time, elapsedRealtimeNanos = l.elapsedRealtimeNanos,
                        latitude = l.latitude, longitude = l.longitude, accuracy = l.accuracy,
                        altitude = l.takeIf { it.hasAltitude() }?.altitude, speed = l.takeIf { it.hasSpeed() }?.speed,
                        bearing = l.takeIf { it.hasBearing() }?.bearing, isMock = l.isMock))
                }
            }}
        }
        client.requestLocationUpdates(request, callback!!, Looper.getMainLooper()).addOnFailureListener { onError("Location failed: ${it.message}") }
    }
    fun stop() { callback?.let { client.removeLocationUpdates(it) }; callback = null }
    fun restart(gps: PolicyGps) { stop(); start(gps) }
}
