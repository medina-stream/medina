package dev.exe.bucketcapture.capture

import com.google.android.gms.location.DetectedActivity
import org.junit.Assert.*
import org.junit.Test

class ActivityMonitorTest {
    @Test fun `detected types map to transport labels`() {
        assertEquals(TransportActivity.DRIVING, TransportActivity.fromDetected(DetectedActivity.IN_VEHICLE))
        assertEquals(TransportActivity.CYCLING, TransportActivity.fromDetected(DetectedActivity.ON_BICYCLE))
        assertEquals(TransportActivity.WALKING, TransportActivity.fromDetected(DetectedActivity.WALKING))
        assertEquals(TransportActivity.RUNNING, TransportActivity.fromDetected(DetectedActivity.RUNNING))
        assertEquals(TransportActivity.STILL, TransportActivity.fromDetected(DetectedActivity.STILL))
        assertEquals(TransportActivity.TILTING, TransportActivity.fromDetected(DetectedActivity.TILTING))
        assertEquals(TransportActivity.UNKNOWN, TransportActivity.fromDetected(DetectedActivity.UNKNOWN))
    }

    @Test fun `moving flag covers locomotion only`() {
        assertTrue(TransportActivity.WALKING.moving)
        assertTrue(TransportActivity.RUNNING.moving)
        assertTrue(TransportActivity.CYCLING.moving)
        assertTrue(TransportActivity.DRIVING.moving)
        assertFalse(TransportActivity.STILL.moving)
        assertFalse(TransportActivity.TILTING.moving)
        assertFalse(TransportActivity.UNKNOWN.moving)
    }

    @Test fun `labels are stable wire values`() {
        assertEquals("still", TransportActivity.STILL.label)
        assertEquals("walking", TransportActivity.WALKING.label)
        assertEquals("driving", TransportActivity.DRIVING.label)
        assertEquals("cycling", TransportActivity.CYCLING.label)
    }
}
