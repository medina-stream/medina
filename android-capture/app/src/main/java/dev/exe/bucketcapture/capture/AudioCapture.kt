package dev.exe.bucketcapture.capture

import android.media.MediaRecorder
import android.os.Build
import dev.exe.bucketcapture.data.PolicyAudio
import dev.exe.bucketcapture.data.SpoolRepository
import kotlinx.coroutines.*
import java.io.File
import java.time.Instant

class AudioCapture(private val spool: SpoolRepository, private val scope: CoroutineScope, private val onError: (String) -> Unit) {
    private var recorder: MediaRecorder? = null
    private var current: Pending? = null
    private var rollover: Job? = null
    private var config: PolicyAudio = PolicyAudio()
    private data class Pending(val id: String, val key: String, val partial: File, val final: File, val startedAtMs: Long)

    /** The segment currently recording, if any. */
    data class SegmentInfo(val id: String, val startedAtMs: Long)
    val currentSegment: SegmentInfo? get() = current?.let { SegmentInfo(it.id, it.startedAtMs) }
    /** Fired synchronously whenever a new segment starts (initial start and every rollover). */
    var onSegmentStart: ((SegmentInfo) -> Unit)? = null

    companion object {
        /**
         * Milliseconds from [nowMs] until the next multiple-of-[segmentMs] epoch
         * boundary. Segments therefore start on wall-clock boundaries (:00, :15,
         * :30, :45 for 15-minute segments); a capture that starts mid-segment
         * records a truncated first segment, then full aligned segments.
         */
        fun millisToNextBoundary(nowMs: Long, segmentMs: Long): Long {
            val r = nowMs % segmentMs
            return if (r == 0L) segmentMs else segmentMs - r
        }
    }

    fun start(audio: PolicyAudio = config) { if (recorder != null) return; config = audio; startSegment() }
    suspend fun restart(audio: PolicyAudio) { stop(); start(audio) }
    private fun startSegment() {
        if (spool.freeBytes() < 512L * 1024 * 1024) { onError("Audio stopped: less than 512 MiB free"); return }
        val nowMs = System.currentTimeMillis()
        val (id, key, final) = spool.newIdentity("audio", "m4a", Instant.ofEpochMilli(nowMs))
        val partial = File(final.parentFile, "$id.recording")
        try {
            @Suppress("DEPRECATION") val r = MediaRecorder().apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioChannels(config.channels); setAudioSamplingRate(config.sampleRateHz); setAudioEncodingBitRate(config.bitrateBps)
                setOutputFile(partial.absolutePath); prepare(); start()
            }
            current = Pending(id, key, partial, final, nowMs); recorder = r
            onSegmentStart?.invoke(SegmentInfo(id, nowMs))
            val segmentMs = config.segmentSeconds * 1000L
            rollover = scope.launch { delay(millisToNextBoundary(System.currentTimeMillis(), segmentMs)); seal(); startSegment() }
        } catch (e: Exception) { recorder?.release(); recorder = null; onError("Audio start failed: ${e.message}") }
    }
    suspend fun stop() { rollover?.cancel(); rollover = null; seal() }
    private suspend fun seal() {
        val r = recorder ?: return; val item = current ?: return
        recorder = null; current = null
        try {
            r.stop(); r.release()
            withContext(Dispatchers.IO) {
                if (!item.partial.isFile || item.partial.length() == 0L) error("empty recording")
                item.partial.inputStream().use { it.fd.sync() }
                check(item.partial.renameTo(item.final)) { "atomic rename failed" }
                spool.enqueue(item.id, item.key, "audio", item.final, "audio/mp4")
            }
        } catch (e: Exception) { runCatching { r.release() }; onError("Audio finalize failed; partial retained: ${e.message}") }
    }
}
