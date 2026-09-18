package dev.exe.bucketcapture.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

enum class DotState { On, Off, Warn, Error }

/** The appliance indicator: a glowing dot. Green pulses while capturing. */
@Composable
fun StatusDot(state: DotState, modifier: Modifier = Modifier, diameter: Dp = 96.dp) {
    val dark = isSystemInDarkTheme()
    val base = when (state) {
        DotState.On -> if (dark) Color(0xFF66BB6A) else Color(0xFF43A047)
        DotState.Off -> MaterialTheme.colorScheme.outline
        DotState.Warn -> if (dark) Color(0xFFFFB74D) else Color(0xFFF9A825)
        DotState.Error -> if (dark) Color(0xFFEF5350) else Color(0xFFE53935)
    }
    val haloAlpha = if (state == DotState.On) {
        val t = rememberInfiniteTransition(label = "dot-pulse")
        val a by t.animateFloat(0.30f, 0.65f, infiniteRepeatable(tween(1600), RepeatMode.Reverse), label = "halo")
        a
    } else 0.22f

    Canvas(modifier.size(diameter)) {
        val center: Offset = this.center
        val radius = size.minDimension / 2f
        drawCircle(
            brush = Brush.radialGradient(
                0.0f to base.copy(alpha = haloAlpha),
                1.0f to base.copy(alpha = 0f),
                center = center,
                radius = radius,
            ),
            radius = radius,
            center = center,
        )
        drawCircle(color = base, radius = radius * 0.42f, center = center)
    }
}
