package dev.exe.bucketcapture.transcribe

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import dev.exe.bucketcapture.data.SpoolRepository
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import kotlin.math.sqrt

/**
 * Live on-device transcription. While audio capture runs, a parallel PCM tap
 * on the mic feeds whisper.cpp every 30 seconds: each tick transcribes the
 * last ~35s of audio (5s overlap for word-boundary continuity), merges the
 * new text into the segment's accumulated transcript, and spools a
 * `.live.json` first-look. The server files it as a provisional transcript
 * keyed by segment UUID, so the journal reflects speech within about a
 * minute; when the segment seals, the batch TranscribeWorker's full-file
 * transcript replaces it.
 *
 * Chunked full transcription (not whisper.cpp's VAD streaming) keeps the JNI
 * surface to the existing transcribe() call and degrades gracefully: a
 * failed tick just means the next tick's overlap covers the gap.
 */
class LiveTranscriber(
    private val context: Context,
    private val spool: SpoolRepository,
    private val scope: CoroutineScope,
) {
    private val stateLock = Any()
    private var segmentUuid: String? = null
    private var segmentStartMs: Long = 0L
    private val accumulatedSegments = mutableListOf<WhisperEngine.Segment>()
    private var accumulatedText = ""
    private var lastUploadedText: String? = null
    private var updateSeq = 0

    private val ringLock = Any()
    private val ring = ShortArray(SAMPLE_RATE * RING_SEC)
    private var ringStart = 0
    private var ringCount = 0
    private var totalSamples = 0L

    @Volatile private var running = false
    private var record: AudioRecord? = null
    private var readerJob: Job? = null
    private var tickerJob: Job? = null

    /** A new segment started recording: reset accumulation (safe to call before start()). */
    fun onSegment(uuid: String, startMs: Long) {
        synchronized(stateLock) {
            if (segmentUuid == uuid) return
            segmentUuid = uuid
            segmentStartMs = startMs
            accumulatedSegments.clear()
            accumulatedText = ""
            lastUploadedText = null
            updateSeq = 0
        }
        synchronized(ringLock) { ringStart = 0; ringCount = 0; totalSamples = 0 }
    }

    /** Idempotent. The model gate is checked per tick so a download that lands mid-capture picks up live transcription automatically. */
    fun start() {
        if (running) return
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuf <= 0) return
        val rec = try {
            @Suppress("DEPRECATION")
            AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuf * 4)
        } catch (_: Exception) { return }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return }
        running = true
        record = rec
        try { rec.startRecording() } catch (_: Exception) { stop(); return }
        readerJob = scope.launch(Dispatchers.IO) { readLoop(rec) }
        tickerJob = scope.launch(Dispatchers.Default) {
            while (isActive) { delay(TICK_MS); runCatching { tick() } }
        }
    }

    fun stop() {
        running = false
        readerJob?.cancel(); tickerJob?.cancel()
        readerJob = null; tickerJob = null
        runCatching { record?.stop() }
        record?.release(); record = null
        synchronized(stateLock) {
            segmentUuid = null
            accumulatedSegments.clear()
            accumulatedText = ""
            lastUploadedText = null
            updateSeq = 0
        }
        synchronized(ringLock) { ringStart = 0; ringCount = 0; totalSamples = 0 }
    }

    private suspend fun readLoop(rec: AudioRecord) {
        val buf = ShortArray(4096)
        while (running) {
            val n = try { rec.read(buf, 0, buf.size) } catch (_: Exception) { -1 }
            if (n > 0) push(buf, n) else delay(100)
        }
    }

    private fun push(samples: ShortArray, n: Int) = synchronized(ringLock) {
        for (i in 0 until n) {
            ring[(ringStart + ringCount) % ring.size] = samples[i]
            if (ringCount < ring.size) ringCount++ else ringStart = (ringStart + 1) % ring.size
        }
        totalSamples += n
    }

    private fun snapshot(seconds: Int): FloatArray = synchronized(ringLock) {
        val n = minOf(ringCount, seconds * SAMPLE_RATE)
        FloatArray(n) { i -> ring[(ringStart + ringCount - n + i) % ring.size] / 32768f }
    }

    private suspend fun tick() {
        val uuid = synchronized(stateLock) { segmentUuid } ?: return
        if (!ModelManager.isPresent(context)) return
        val pcm = snapshot(WINDOW_SEC)
        if (pcm.size < SAMPLE_RATE * MIN_WINDOW_SEC) return
        if (rms(pcm) < ENERGY_THRESHOLD) return
        val engine = WhisperEngine.get(ModelManager.modelFile(context).absolutePath) ?: return
        val result = try { engine.transcribe(pcm) } catch (_: Exception) { return }
        if (result.text.isBlank()) return
        val windowStartSec = (totalSamples - pcm.size) / SAMPLE_RATE.toDouble()
        val merged: String
        val seq: Int
        val segments: List<WhisperEngine.Segment>
        synchronized(stateLock) {
            if (segmentUuid != uuid) return
            merged = mergeOverlap(accumulatedText, result.text)
            if (merged == lastUploadedText) return
            val lastEnd = accumulatedSegments.lastOrNull()?.endSec ?: 0.0
            for (s in result.segments) {
                val absStart = s.startSec + windowStartSec
                if (absStart > lastEnd - SEGMENT_OVERLAP_TOL_SEC) {
                    accumulatedSegments.add(WhisperEngine.Segment(absStart, s.endSec + windowStartSec, s.text))
                }
            }
            accumulatedText = merged
            updateSeq += 1
            seq = updateSeq
            segments = accumulatedSegments.toList()
        }
        spoolLive(uuid, seq, segments, merged)
    }

    private suspend fun spoolLive(
        uuid: String,
        seq: Int,
        segments: List<WhisperEngine.Segment>,
        text: String,
    ) {
        val startMs = synchronized(stateLock) { segmentStartMs }
        val (id, key, file) = spool.newLiveTranscriptIdentity(uuid)
        val arr = JSONArray()
        segments.forEach { s -> arr.put(JSONObject().put("start", s.startSec).put("end", s.endSec).put("text", s.text)) }
        val payload = JSONObject()
            .put("schemaVersion", 1)
            .put("live", true)
            .put("segmentUuid", uuid)
            .put("installId", spool.installationId())
            .put("capturedAt", Instant.ofEpochMilli(startMs).toString())
            .put("engine", "whisper.cpp")
            .put("model", "ggml-tiny.en")
            .put("language", "en")
            .put("updateSeq", seq)
            .put("segments", arr)
            .put("text", text)
            .toString()
        withContext(Dispatchers.IO) {
            val tmp = File(file.parentFile, "${file.nameWithoutExtension}.tmp")
            tmp.writeText(payload)
            check(tmp.renameTo(file)) { "Could not finalize live transcript" }
            spool.upsertLiveTranscript(id, key, file)
        }
        synchronized(stateLock) { lastUploadedText = text }
    }

    companion object {
        const val SAMPLE_RATE = 16000
        const val TICK_MS = 30_000L
        const val WINDOW_SEC = 35
        private const val RING_SEC = 45
        private const val MIN_WINDOW_SEC = 5
        private const val ENERGY_THRESHOLD = 0.015
        private const val SEGMENT_OVERLAP_TOL_SEC = 1.0
        private const val MAX_OVERLAP_WORDS = 40

        /**
         * Append [next] to [previous], dropping the longest trailing run of
         * [previous]'s words that exactly repeats at the head of [next]
         * (the 5s audio overlap is transcribed twice). Pure for testing.
         */
        fun mergeOverlap(previous: String, next: String, maxOverlapWords: Int = MAX_OVERLAP_WORDS): String {
            val prev = previous.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            val words = next.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (prev.isEmpty()) return words.joinToString(" ")
            if (words.isEmpty()) return prev.joinToString(" ")
            val limit = minOf(maxOverlapWords, prev.size, words.size)
            var overlap = 0
            for (k in limit downTo 1) {
                if (prev.takeLast(k) == words.take(k)) { overlap = k; break }
            }
            return (prev + words.drop(overlap)).joinToString(" ")
        }

        fun rms(pcm: FloatArray): Double {
            if (pcm.isEmpty()) return 0.0
            var sum = 0.0
            for (s in pcm) sum += s * s
            return sqrt(sum / pcm.size)
        }
    }
}
