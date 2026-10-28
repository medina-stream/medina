package dev.exe.bucketcapture.transcribe

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.sin

class SpectrogramTest {
    private fun sine(freqHz: Double, seconds: Double = 1.0, amplitude: Double = 0.5): FloatArray {
        val n = (LiveTranscriber.SAMPLE_RATE * seconds).toInt()
        return FloatArray(n) { i ->
            (amplitude * sin(2.0 * Math.PI * freqHz * i / LiveTranscriber.SAMPLE_RATE)).toFloat()
        }
    }

    @Test fun `mel edges span the speech band and strictly increase`() {
        val edges = Spectrogram.melBinEdgesHz(LiveTranscriber.SAMPLE_RATE)
        assertEquals(Spectrogram.BIN_COUNT + 1, edges.size)
        assertEquals(Spectrogram.MIN_FREQ_HZ, edges.first(), 1e-9)
        assertEquals(Spectrogram.MAX_FREQ_HZ, edges.last(), 1e-6)
        for (i in 1 until edges.size) {
            assertTrue("edge $i must exceed edge ${i - 1}", edges[i] > edges[i - 1])
        }
    }

    @Test fun `mel round trip is lossless`() {
        for (hz in listOf(50.0, 200.0, 1000.0, 3400.0, 8000.0)) {
            assertEquals(hz, Spectrogram.melToHz(Spectrogram.hzToMel(hz)), 1e-6)
        }
    }

    @Test fun `fft peaks at the sine frequency`() {
        // 1000 Hz is exactly FFT bin 128 at 16 kHz with a 2048-point FFT.
        val mags = Spectrogram.magnitudeSpectrum(sine(1000.0))
        val peak = mags.indices.maxByOrNull { mags[it] }!!
        assertEquals(128, peak)
    }

    @Test fun `frame peaks in the mel bin containing the sine frequency`() {
        val freq = 1000.0
        val frame = Spectrogram.frame(sine(freq))
        assertEquals(Spectrogram.BIN_COUNT, frame.size)
        val edges = Spectrogram.melBinEdgesHz(LiveTranscriber.SAMPLE_RATE)
        val expectedBin = (0 until Spectrogram.BIN_COUNT).first { freq >= edges[it] && freq < edges[it + 1] }
        val peakBin = frame.indices.maxByOrNull { frame[it] }!!
        assertEquals(expectedBin, peakBin)
        assertTrue("peak bin should be clearly hot", frame[peakBin] > 0.5f)
    }

    @Test fun `low sine peaks below high sine`() {
        val low = Spectrogram.frame(sine(200.0))
        val high = Spectrogram.frame(sine(4000.0))
        val lowPeak = low.indices.maxByOrNull { low[it] }!!
        val highPeak = high.indices.maxByOrNull { high[it] }!!
        assertTrue(lowPeak < highPeak)
    }

    @Test fun `silence is all zeros`() {
        val frame = Spectrogram.frame(FloatArray(Spectrogram.FFT_SIZE))
        assertTrue(frame.all { it == 0f })
    }

    @Test fun `short input is padded, not crashed`() {
        val frame = Spectrogram.frame(sine(1000.0, seconds = 0.05))
        assertEquals(Spectrogram.BIN_COUNT, frame.size)
    }
}
