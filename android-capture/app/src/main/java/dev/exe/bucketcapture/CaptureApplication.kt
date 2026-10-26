package dev.exe.bucketcapture

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.exe.bucketcapture.data.*
import dev.exe.bucketcapture.upload.ForegroundSync
import dev.exe.bucketcapture.upload.S3Uploader

class CaptureApplication : Application() {
    val db by lazy { CaptureDatabase.open(this) }
    val policies by lazy { PolicyStore(this) }
    val spool by lazy { SpoolRepository(this, db, policies) }
    val uploader by lazy { S3Uploader() }

    override fun onCreate() {
        super.onCreate()
        // Track foreground state process-wide: on-device transcription is
        // gated on it (see AppForeground), and uploads move fastest then.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                AppForeground.setForeground(true)
                // The user just looked at the app: make the freshest data move now.
                ForegroundSync.kick(this@CaptureApplication)
            }

            override fun onStop(owner: LifecycleOwner) {
                AppForeground.setForeground(false)
            }
        })
    }
}
