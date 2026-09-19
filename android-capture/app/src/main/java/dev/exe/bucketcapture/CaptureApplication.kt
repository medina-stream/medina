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
        // The user just looked at the app: make the freshest data move now.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = ForegroundSync.kick(this@CaptureApplication)
        })
    }
}
