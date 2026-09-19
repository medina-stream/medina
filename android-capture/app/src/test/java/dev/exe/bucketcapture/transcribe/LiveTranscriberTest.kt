package dev.exe.bucketcapture.transcribe

import org.junit.Assert.*
import org.junit.Test

class LiveTranscriberTest {
    @Test fun `empty previous returns next`() {
        assertEquals("hello world", LiveTranscriber.mergeOverlap("", "hello world"))
    }

    @Test fun `empty next returns previous`() {
        assertEquals("hello world", LiveTranscriber.mergeOverlap("hello world", ""))
    }

    @Test fun `exact full overlap is not duplicated`() {
        assertEquals(
            "the quick brown fox",
            LiveTranscriber.mergeOverlap("the quick brown fox", "the quick brown fox")
        )
    }

    @Test fun `partial trailing overlap appends only the new tail`() {
        assertEquals(
            "the quick brown fox jumps over",
            LiveTranscriber.mergeOverlap("the quick brown fox", "brown fox jumps over")
        )
    }

    @Test fun `no overlap concatenates`() {
        assertEquals(
            "hello world foo bar",
            LiveTranscriber.mergeOverlap("hello world", "foo bar")
        )
    }

    @Test fun `single-word overlap is enough`() {
        assertEquals(
            "a b c d",
            LiveTranscriber.mergeOverlap("a b c", "c d")
        )
    }

    @Test fun `overlap is capped by maxOverlapWords`() {
        val prev = (1..50).joinToString(" ") { "w$it" }
        val next = (41..70).joinToString(" ") { "w$it" }
        // 10 shared words (w41..w50) with a cap of 20: only the new tail is appended.
        val merged = LiveTranscriber.mergeOverlap(prev, next, maxOverlapWords = 20)
        val words = merged.split(" ")
        assertEquals(70, words.size)
        assertEquals("w50", words[49])
        assertEquals("w51", words[50])
    }

    @Test fun `whitespace is normalized`() {
        assertEquals(
            "hello world again",
            LiveTranscriber.mergeOverlap("  hello   world ", " world  again ")
        )
    }

    @Test fun `match is case sensitive`() {
        assertEquals(
            "Hello world hello world",
            LiveTranscriber.mergeOverlap("Hello world", "hello world")
        )
    }

    @Test fun `rms of silence is zero`() {
        assertEquals(0.0, LiveTranscriber.rms(FloatArray(160)), 1e-9)
    }

    @Test fun `rms of constant signal`() {
        assertEquals(0.5, LiveTranscriber.rms(FloatArray(160) { 0.5f }), 1e-6)
    }
}
