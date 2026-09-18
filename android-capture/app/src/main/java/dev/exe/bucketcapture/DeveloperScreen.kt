package dev.exe.bucketcapture

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.exe.bucketcapture.data.PolicyState
import dev.exe.bucketcapture.data.UploadState
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeveloperScreen(vm: MainViewModel, onBack: () -> Unit) {
    val context = LocalContext.current
    val rows by vm.items.collectAsStateWithLifecycle()
    val pending = rows.count { it.state == UploadState.PENDING }
    val uploaded = rows.count { it.state == UploadState.UPLOADED }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Developers") },
            navigationIcon = {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            },
        )
    }) { padding ->
        LazyColumn(
            Modifier.padding(padding).fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(vertical = 16.dp),
        ) {
            item { SectionTitle("Policy") }
            when (val s = vm.policyState) {
                PolicyState.NotConfigured -> item { Text("No policy configured.", style = MaterialTheme.typography.bodyMedium) }
                PolicyState.Revoked -> item { Text("Policy revoked on the server.", style = MaterialTheme.typography.bodyMedium) }
                is PolicyState.Unreachable -> item { Text("Unreachable: ${s.detail}", style = MaterialTheme.typography.bodyMedium) }
                is PolicyState.Active -> {
                    val p = s.policy
                    item { InfoRow("Version", "v${p.version}") }
                    item {
                        InfoRow(
                            "Fetched",
                            DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(s.fetchedAt)),
                        )
                    }
                    s.staleError?.let { item { InfoRow("Stale error", it) } }
                    item { InfoRow("Audio", "${if (p.audio.enabled) "on" else "off"} · ${p.audio.describe()}") }
                    item { InfoRow("Location", "${if (p.gps.enabled) "on" else "off"} · ${p.gps.describe()}") }
                    item { InfoRow("Upload", p.upload.describe() + if (p.upload.unmeteredOnly) " · unmetered only" else "") }
                }
            }

            item { SectionTitle("Upload manifest") }
            item { Text("$pending pending · $uploaded uploaded", style = MaterialTheme.typography.bodyMedium) }
            items(rows, key = { it.id }) { item ->
                ListItem(
                    headlineContent = { Text("${item.kind} · ${item.state.name.lowercase()}") },
                    supportingContent = {
                        Text(
                            item.objectKey + (item.lastError?.let { "\n$it" } ?: ""),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    },
                )
            }

            item { SectionTitle("Reliability") }
            item {
                Text(
                    "For continuous capture, allow background location separately in Android settings and consider exempting this app from battery optimization. Android requires a tap to resume microphone capture after reboot.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = {
                        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
                    }) { Text("App permissions") }
                    TextButton(onClick = {
                        context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    }) { Text("Battery settings") }
                }
            }
            item {
                Text(
                    "Audio and GPS stay local until an S3-compatible PUT succeeds. No bucket reads, lists, or deletes are used.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 8.dp),
    )
}

@Composable
private fun InfoRow(label: String, value: String) {
    ListItem(
        headlineContent = { Text(label, style = MaterialTheme.typography.labelLarge) },
        supportingContent = { Text(value, style = MaterialTheme.typography.bodyMedium) },
    )
}
