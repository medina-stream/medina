package dev.exe.bucketcapture.transcribe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AacDecoderTest {
    @Test fun `16k mono passes through normalized`() {
        val pcm = shortArrayOf(0, 16384, -16384, 32767)
        val out = AacDecoder.to16kMono(pcm, 16000, 1)
        assertEquals(4, out.size)
        assertEquals(0f, out[0], 1e-6f)
        assertEquals(0.5f, out[1], 1e-6f)
        assertEquals(-0.5f, out[2], 1e-6f)
        assertTrue(out[3] > 0.99f)
    }

    @Test fun `stereo downmixes to mono average`() {
        val pcm = shortArrayOf(32767, -32767)
        val out = AacDecoder.to16kMono(pcm, 16000, 2)
        assertEquals(1, out.size)
        assertEquals(0f, out[0], 1e-6f)
    }

    @Test fun `8k upsamples to 16k`() {
        val pcm = ShortArray(80) { 16384 }
        val out = AacDecoder.to16kMono(pcm, 8000, 1)
        assertEquals(160, out.size)
        assertTrue(out.all { it > 0.49f && it < 0.51f })
    }
}
