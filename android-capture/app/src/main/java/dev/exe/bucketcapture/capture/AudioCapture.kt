package dev.exe.bucketcapture.capture

import android.media.MediaRecorder
import android.os.Build
import dev.exe.bucketcapture.data.PolicyAudio
import dev.exe.bucketcapture.data.SpoolRepository
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.time.Instant

class AudioCapture(private val spool: SpoolRepository, private val scope: CoroutineScope, private val onError: (String) -> Unit) {
    private var recorder: MediaRecorder? = null
    private var current: Pending? = null
    private var rollover: Job? = null
    private var config: PolicyAudio = PolicyAudio()
    /** Serializes seal/start transitions: the boundary rollover runs on the
     * service scope, while an early roll (see [rollNow]) can arrive from
     * any thread via the foreground sync kick. */
    private val transitionMutex = Mutex()
    private data class Pending(val id: String, val key: String, val partial: File, val final: File, val startedAtMs: Long)

    /** The segment currently recording, if any. */
    data class SegmentInfo(val id: String, val startedAtMs: Long)
    val currentSegment: SegmentInfo? get() = current?.let { SegmentInfo(it.id, it.startedAtMs) }

    /**
     * Peak mic amplitude (0..32767) since the last call, or 0 when not
     * recording. Read-only: safe to poll from the UI for a live level meter.
     */
    fun currentAmplitude(): Int = runCatching { recorder?.maxAmplitude ?: 0 }.getOrDefault(0)
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

        /**
         * Youngest a segment may be for an early roll to be worth sealing
         * it. Below this the segment will roll at the boundary soon anyway,
         * and MediaRecorder dislikes being stopped in its first moments.
         */
        const val MIN_EARLY_ROLL_AGE_MS = 30_000L

        /** Pure for testing: has a segment started at [startedAtMs] been
         * recording long enough at [nowMs] for an early roll? */
        fun earlyRollDue(startedAtMs: Long, nowMs: Long): Boolean =
            nowMs - startedAtMs >= MIN_EARLY_ROLL_AGE_MS
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
            rollover = scope.launch { delay(millisToNextBoundary(System.currentTimeMillis(), segmentMs)); rollLocked() }
        } catch (e: Exception) { recorder?.release(); recorder = null; onError("Audio start failed: ${e.message}") }
    }
    suspend fun stop() {
        transitionMutex.withLock {
            rollover?.cancel(); rollover = null; seal()
        }
    }

    /** Boundary rollover: seal the finished segment, start the next. */
    private suspend fun rollLocked() {
        transitionMutex.withLock {
            rollover = null
            seal()
            startSegment()
        }
    }

    /**
     * Seal the in-progress segment right now and immediately start the
     * next one, so the freshest recording becomes uploadable without
     * waiting for the clock-aligned rollover (the foreground sync kick
     * uses this). The follow-on segment still ends at the next boundary —
     * [startSegment] computes its delay from now — so clock alignment is
     * preserved and the boundary rollover that follows is undisturbed.
     * The early-sealed segment keeps its content-hash capture id, like
     * any other segment; the server ingests arbitrary lengths.
     *
     * No-op when not recording, or when the segment is younger than
     * [MIN_EARLY_ROLL_AGE_MS]. Safe to call from any thread.
     */
    suspend fun rollNow() {
        val item = current ?: return
        if (!earlyRollDue(item.startedAtMs, System.currentTimeMillis())) return
        transitionMutex.withLock {
            val cur = current ?: return@withLock
            if (!earlyRollDue(cur.startedAtMs, System.currentTimeMillis())) return@withLock
            rollover?.cancel(); rollover = null
            seal()
            startSegment()
        }
    }

    /** Callers must hold [transitionMutex]. */
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
