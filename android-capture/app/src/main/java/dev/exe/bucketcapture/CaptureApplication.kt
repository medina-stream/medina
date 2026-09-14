package dev.exe.bucketcapture

import android.app.Application
import dev.exe.bucketcapture.data.*
import dev.exe.bucketcapture.upload.S3Uploader

class CaptureApplication : Application() {
    val db by lazy { CaptureDatabase.open(this) }
    val settings by lazy { SettingsStore(this) }
    val spool by lazy { SpoolRepository(this, db, settings) }
    val uploader by lazy { S3Uploader() }
}
