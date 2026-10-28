package dev.exe.bucketcapture

import dev.exe.bucketcapture.capture.AudioCapture
import dev.exe.bucketcapture.transcribe.LiveTranscriber

/**
 * Process-local live telemetry published by [dev.exe.bucketcapture.capture.CaptureService]
 * for the home screen. Same process only: written by the service's components,
 * read by the UI. Never persisted, never sent anywhere.
 */
object CaptureTelemetry {
    /** The live [AudioCapture] while the service runs; null when it isn't. */
    @Volatile var audio: AudioCapture? = null

    /**
     * The live [LiveTranscriber] while the service runs; null when it
     * isn't. The UI collects its liveText / spectrogramFrames flows.
     */
    @Volatile var liveTranscriber: LiveTranscriber? = null

    /**
     * Latest live-transcript text produced on-device. Empty when the live
     * transcriber isn't running or hasn't produced anything — the UI must
     * treat empty as "no transcript", never as a placeholder.
     */
    @Volatile var liveTranscriptLine: String = ""

    /**
     * The manifest id an upload pass is putting right now, or null
     * between items/passes. Written by UploadWorker, read by the home
     * screen's queue so the in-flight row can show a spinner. A marker,
     * not progress: no byte counts.
     */
    @Volatile var uploadingItemId: String? = null
}
