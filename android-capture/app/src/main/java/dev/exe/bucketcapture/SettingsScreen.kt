package dev.exe.bucketcapture

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: MainViewModel, onBack: () -> Unit, onOpenDevelopers: () -> Unit) {
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
                OutlinedTextField(
                    value = vm.policyUrlField,
                    onValueChange = vm::updateUrl,
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Policy URL") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                )
            }
            item {
                Text(
                    "One URL provisions the whole device: what to capture and where to send it, including upload credentials. The URL is the credential — anyone holding it can fetch the policy.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = vm::saveUrl) { Text("Save") }
                    OutlinedButton(onClick = vm::refreshPolicy, enabled = !vm.refreshing) {
                        Text(if (vm.refreshing) "Refreshing…" else "Refresh")
                    }
                    OutlinedButton(onClick = vm::test, enabled = !vm.testing) { Text("Test PUT") }
                }
            }
            vm.message?.let { msg ->
                item { Text(msg, style = MaterialTheme.typography.bodySmall) }
            }
            item { HorizontalDivider(Modifier.padding(vertical = 4.dp)) }
            item {
                ListItem(
                    headlineContent = { Text("Developers") },
                    supportingContent = { Text("Policy details, upload manifest, diagnostics") },
                    trailingContent = { Icon(Icons.Filled.ChevronRight, contentDescription = null) },
                    modifier = Modifier.clickable(onClick = onOpenDevelopers),
                )
            }
        }
    }
}
