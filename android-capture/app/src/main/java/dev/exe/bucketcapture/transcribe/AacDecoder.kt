package dev.exe.bucketcapture.transcribe

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.roundToInt

/**
 * Decodes an AAC/M4A capture to 16 kHz mono float PCM, the input format
 * whisper.cpp expects. Handles whatever sample rate/channel count the
 * recorder was configured with via a simple linear resample + downmix.
 */
object AacDecoder {
    fun decode(file: File): FloatArray {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.absolutePath)
            var track = -1
            var format: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val f = extractor.getTrackFormat(i)
                if (f.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
                    track = i; format = f; break
                }
            }
            require(track >= 0 && format != null) { "No audio track in ${file.name}" }
            extractor.selectTrack(track)
            val codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
            try {
                codec.configure(format, null, null, 0)
                codec.start()
                val pcm = decodeAll(codec, extractor)
                val outFormat = codec.outputFormat
                val sampleRate = outFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                val channels = outFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                return to16kMono(pcm, sampleRate, channels)
            } finally {
                runCatching { codec.stop() }
                codec.release()
            }
        } finally {
            extractor.release()
        }
    }

    private fun decodeAll(codec: MediaCodec, extractor: MediaExtractor): ShortArray {
        val chunks = mutableListOf<ShortArray>()
        var total = 0
        var inputDone = false
        var outputDone = false
        val info = MediaCodec.BufferInfo()
        while (!outputDone) {
            if (!inputDone) {
                val inIndex = codec.dequeueInputBuffer(10_000)
                if (inIndex >= 0) {
                    val input = codec.getInputBuffer(inIndex)!!
                    val n = extractor.readSampleData(input, 0)
                    if (n < 0) {
                        codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        inputDone = true
                    } else {
                        codec.queueInputBuffer(inIndex, 0, n, extractor.sampleTime, 0)
                        extractor.advance()
                    }
                }
            }
            val outIndex = codec.dequeueOutputBuffer(info, 10_000)
            when {
                outIndex >= 0 -> {
                    val output: ByteBuffer = codec.getOutputBuffer(outIndex)!!
                    if (info.size > 0) {
                        val shorts = ShortArray(info.size / 2)
                        output.asShortBuffer().get(shorts)
                        chunks.add(shorts)
                        total += shorts.size
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
                }
                outIndex == MediaCodec.INFO_TRY_AGAIN_LATER && inputDone -> {
                    // Drained; loop once more for any trailing output.
                    if (chunks.isNotEmpty()) outputDone = true
                }
            }
        }
        val out = ShortArray(total)
        var pos = 0
        for (c in chunks) { c.copyInto(out, pos); pos += c.size }
        return out
    }

    /** Downmix to mono and linear-resample to 16 kHz, normalized to [-1, 1]. */
    fun to16kMono(pcm: ShortArray, sampleRate: Int, channels: Int): FloatArray {
        require(pcm.isNotEmpty() && sampleRate > 0 && channels > 0)
        val frames = pcm.size / channels
        val mono = FloatArray(frames) { f ->
            var sum = 0f
            for (c in 0 until channels) sum += pcm[f * channels + c] / 32768f
            sum / channels
        }
        if (sampleRate == 16000) return mono
        val ratio = sampleRate / 16000.0
        val outLen = (frames / ratio).roundToInt()
        return FloatArray(outLen) { i ->
            val src = i * ratio
            val i0 = src.toInt().coerceIn(0, frames - 1)
            val i1 = (i0 + 1).coerceIn(0, frames - 1)
            val frac = (src - i0).toFloat()
            mono[i0] * (1 - frac) + mono[i1] * frac
        }
    }
}
