package dev.exe.bucketcapture.transcribe

import org.json.JSONObject

/**
 * On-device transcription via whisper.cpp (JNI). The model file is downloaded
 * separately on unmetered wifi (see ModelManager); the native library is
 * bundled with the app.
 *
 * One engine per process; transcription calls are serialized.
 */
class WhisperEngine private constructor(private val ctxHandle: Long) {
    data class Segment(val startSec: Double, val endSec: Double, val text: String)
    data class Result(val segments: List<Segment>, val text: String)

    @Synchronized
    fun transcribe(pcm16kMono: FloatArray, threads: Int = 4): Result {
        val json = transcribeNative(ctxHandle, pcm16kMono, threads)
            ?: error("whisper.cpp transcription failed")
        val root = JSONObject(json)
        val segments = mutableListOf<Segment>()
        val arr = root.getJSONArray("segments")
        for (i in 0 until arr.length()) {
            val s = arr.getJSONObject(i)
            segments.add(Segment(s.getDouble("start"), s.getDouble("end"), s.getString("text")))
        }
        return Result(segments, root.getString("text"))
    }

    fun close() {
        if (ctxHandle != 0L) freeNative(ctxHandle)
    }

    private external fun initNative(modelPath: String): Long
    private external fun transcribeNative(ctxHandle: Long, pcm: FloatArray, nThreads: Int): String?
    private external fun freeNative(ctxHandle: Long)

    companion object {
        private val nativeLoaded: Boolean =
            runCatching { System.loadLibrary("whisper_jni"); true }.getOrDefault(false)

        @Volatile private var instance: WhisperEngine? = null

        /** Shared engine, or null when the native lib/model is missing or init fails. */
        @Synchronized
        fun get(modelPath: String): WhisperEngine? {
            if (!nativeLoaded) return null
            instance?.let { return it }
            return try {
                val probe = WhisperEngine(0L)
                val handle = probe.initNative(modelPath)
                if (handle == 0L) null else WhisperEngine(handle).also { instance = it }
            } catch (e: UnsatisfiedLinkError) {
                null
            }
        }

        @Synchronized
        fun reset() {
            instance?.close()
            instance = null
        }
    }
}
