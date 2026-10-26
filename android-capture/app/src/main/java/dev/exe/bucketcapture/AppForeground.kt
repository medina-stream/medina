package dev.exe.bucketcapture

/**
 * Process-wide "is the app in the foreground" state, driven by
 * ProcessLifecycleOwner in [CaptureApplication].
 *
 * On-device transcription (whisper.cpp) is CPU- and battery-hungry, so it is
 * gated on this state: it only runs while the user actually has the app open.
 * Recording and uploading are NOT gated — they keep running in the
 * background; only transcription waits for the foreground.
 */
object AppForeground {
    @Volatile
    var isForeground: Boolean = false
        private set

    fun setForeground(foreground: Boolean) {
        isForeground = foreground
    }

    /** Transcription may proceed only in the foreground. Pure for testing. */
    fun transcriptionAllowed(): Boolean = isForeground
}
