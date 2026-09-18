package dev.exe.bucketcapture.capture

import android.media.MediaRecorder
import android.os.Build
import dev.exe.bucketcapture.data.PolicyAudio
import dev.exe.bucketcapture.data.SpoolRepository
import kotlinx.coroutines.*
import java.io.File

class AudioCapture(private val spool: SpoolRepository, private val scope: CoroutineScope, private val onError: (String) -> Unit) {
    private var recorder: MediaRecorder? = null
    private var current: Pending? = null
    private var rollover: Job? = null
    private var config: PolicyAudio = PolicyAudio()
    private data class Pending(val id: String, val key: String, val partial: File, val final: File)

    fun start(audio: PolicyAudio = config) { if (recorder != null) return; config = audio; startSegment() }
    suspend fun restart(audio: PolicyAudio) { stop(); start(audio) }
    private fun startSegment() {
        if (spool.freeBytes() < 512L * 1024 * 1024) { onError("Audio stopped: less than 512 MiB free"); return }
        val (id, key, final) = spool.newIdentity("audio", "m4a")
        val partial = File(final.parentFile, "$id.recording")
        try {
            @Suppress("DEPRECATION") val r = MediaRecorder().apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioChannels(config.channels); setAudioSamplingRate(config.sampleRateHz); setAudioEncodingBitRate(config.bitrateBps)
                setOutputFile(partial.absolutePath); prepare(); start()
            }
            current = Pending(id, key, partial, final); recorder = r
            rollover = scope.launch { delay(config.segmentSeconds * 1000L); seal(); startSegment() }
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
