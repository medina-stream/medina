package dev.exe.bucketcapture.transcribe

import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sin

/**
 * Pure-Kotlin mel spectrogram for the home screen's live waterfall.
 *
 * Takes a window of 16 kHz mono PCM (float, -1..1), applies a Hann window
 * and a radix-2 FFT, averages the magnitude spectrum into mel-scaled bins,
 * and maps each bin to 0..1 via a fixed dB window so the UI can render
 * intensity directly. No native code, no allocation-heavy paths: one frame
 * costs one 2048-point FFT, trivial next to whisper.
 *
 * Everything here is pure and deterministic for unit testing.
 */
object Spectrogram {
    /** FFT window length: 2048 samples = 128 ms at 16 kHz. Power of two. */
    const val FFT_SIZE = 2048

    /** Number of mel bins per frame (rows in the waterfall). */
    const val BIN_COUNT = 56

    const val MIN_FREQ_HZ = 50.0
    const val MAX_FREQ_HZ = 8000.0

    /** dB window mapped onto 0..1. A full-scale sine peaks near +54 dB
     * after Hann coherent gain; ordinary speech lands mid-window; digital
     * silence sits far below the floor. */
    private const val DB_FLOOR = 0.0
    private const val DB_CEIL = 54.0

    private val hann = DoubleArray(FFT_SIZE) { i ->
        0.5 - 0.5 * cos(2.0 * Math.PI * i / (FFT_SIZE - 1))
    }

    /**
     * One spectral frame from the last [FFT_SIZE] samples of [pcm]
     * (zero-padded on the left when [pcm] is shorter). Returns
     * [BIN_COUNT] intensities in 0..1, lowest frequency first.
     */
    fun frame(pcm: FloatArray, sampleRate: Int = LiveTranscriber.SAMPLE_RATE): FloatArray {
        val mags = magnitudeSpectrum(pcm)
        val edges = melBinEdgesHz(sampleRate)
        val out = FloatArray(BIN_COUNT)
        for (bin in 0 until BIN_COUNT) {
            val lo = edges[bin]
            val hi = edges[bin + 1]
            var sum = 0.0
            var count = 0
            // FFT bin k sits at k * sampleRate / FFT_SIZE Hz; only the
            // positive half of the spectrum is returned by magnitudeSpectrum.
            var k = ((lo * FFT_SIZE) / sampleRate).toInt()
            if (k < 1) k = 1
            while (k < mags.size && k * sampleRate.toDouble() / FFT_SIZE < hi) {
                sum += mags[k]
                count++
                k++
            }
            val avg = if (count > 0) sum / count else 0.0
            val db = 20.0 * log10(avg + 1e-9)
            out[bin] = ((db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)).coerceIn(0.0, 1.0).toFloat()
        }
        return out
    }

    /**
     * Magnitude spectrum of the Hann-windowed last [FFT_SIZE] samples of
     * [pcm]: FFT_SIZE/2 values, index k = magnitude at
     * k * sampleRate / FFT_SIZE Hz.
     */
    fun magnitudeSpectrum(pcm: FloatArray): DoubleArray {
        val re = DoubleArray(FFT_SIZE)
        val im = DoubleArray(FFT_SIZE)
        val offset = pcm.size - FFT_SIZE
        for (i in 0 until FFT_SIZE) {
            val s = if (offset + i >= 0 && offset + i < pcm.size) pcm[offset + i].toDouble() else 0.0
            re[i] = s * hann[i]
        }
        fft(re, im)
        return DoubleArray(FFT_SIZE / 2) { k -> Math.hypot(re[k], im[k]) }
    }

    /**
     * [BIN_COUNT]+1 mel-spaced band edges in Hz, from [MIN_FREQ_HZ] to
     * min([MAX_FREQ_HZ], Nyquist). Pure; recomputed per call (cheap) so
     * tests can inspect the mapping directly.
     */
    fun melBinEdgesHz(sampleRate: Int): DoubleArray {
        val hi = minOf(MAX_FREQ_HZ, sampleRate / 2.0)
        val loMel = hzToMel(MIN_FREQ_HZ)
        val hiMel = hzToMel(hi)
        return DoubleArray(BIN_COUNT + 1) { i ->
            melToHz(loMel + (hiMel - loMel) * i / BIN_COUNT)
        }
    }

    fun hzToMel(hz: Double): Double = 2595.0 * log10(1.0 + hz / 700.0)

    fun melToHz(mel: Double): Double = 700.0 * (10.0.pow(mel / 2595.0) - 1.0)

    /** In-place iterative radix-2 Cooley–Tukey FFT. Lengths must be powers of two. */
    private fun fft(re: DoubleArray, im: DoubleArray) {
        val n = re.size
        require(n > 0 && (n and (n - 1)) == 0) { "FFT length must be a power of two" }
        // Bit-reversal permutation.
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while ((j and bit) != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j or bit
            if (i < j) {
                var t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
        }
        var len = 2
        while (len <= n) {
            val ang = -2.0 * Math.PI / len
            val wr = cos(ang)
            val wi = sin(ang)
            var i = 0
            while (i < n) {
                var cwr = 1.0
                var cwi = 0.0
                for (k in 0 until len / 2) {
                    val ur = re[i + k]
                    val ui = im[i + k]
                    val vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi
                    val vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr
                    re[i + k] = ur + vr
                    im[i + k] = ui + vi
                    re[i + k + len / 2] = ur - vr
                    im[i + k + len / 2] = ui - vi
                    val nwr = cwr * wr - cwi * wi
                    cwi = cwr * wi + cwi * wr
                    cwr = nwr
                }
                i += len
            }
            len = len shl 1
        }
    }
}
