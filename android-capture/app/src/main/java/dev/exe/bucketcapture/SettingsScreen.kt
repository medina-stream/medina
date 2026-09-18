package dev.exe.bucketcapture

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.QrCode
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.exe.bucketcapture.data.PolicyState
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: MainViewModel, onBack: () -> Unit, onScanQr: () -> Unit) {
    val context = LocalContext.current
    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Settings") },
            navigationIcon = {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            },
        )
    }) { padding ->
        LazyColumn(
            Modifier.padding(padding).fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 16.dp),
        ) {
            item {
                Text("Medina server", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = vm.policyUrlField,
                        onValueChange = vm::updateUrl,
                        modifier = Modifier.weight(1f),
                        label = { Text("Policy URL") },
                        visualTransformation = PasswordVisualTransformation(),
                        singleLine = true,
                    )
                    IconButton(onClick = onScanQr, modifier = Modifier.padding(top = 8.dp)) {
                        Icon(Icons.Filled.QrCode, contentDescription = "Scan QR")
                    }
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = vm::saveUrl) { Text("Save") }
                    OutlinedButton(onClick = vm::refreshPolicy, enabled = !vm.refreshing) {
                        Text(if (vm.refreshing) "Refreshing…" else "Refresh")
                    }
                    OutlinedButton(onClick = vm::test, enabled = !vm.testing) { Text("Check") }
                }
            }
            vm.message?.let { msg ->
                item { Text(msg, style = MaterialTheme.typography.bodySmall) }
            }
            item { HorizontalDivider(Modifier.padding(vertical = 4.dp)) }
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
            item { HorizontalDivider(Modifier.padding(vertical = 4.dp)) }
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
