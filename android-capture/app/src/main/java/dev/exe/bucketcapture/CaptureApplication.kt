package dev.exe.bucketcapture

import android.app.Application
import dev.exe.bucketcapture.data.*
import dev.exe.bucketcapture.upload.S3Uploader

class CaptureApplication : Application() {
    val db by lazy { CaptureDatabase.open(this) }
    val policies by lazy { PolicyStore(this) }
    val spool by lazy { SpoolRepository(this, db, policies) }
    val uploader by lazy { S3Uploader() }
}
