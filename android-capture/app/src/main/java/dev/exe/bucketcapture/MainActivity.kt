package dev.exe.bucketcapture

import android.Manifest
import android.app.Application
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.ContextCompat.startForegroundService
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.exe.bucketcapture.capture.CaptureService
import dev.exe.bucketcapture.data.BucketSettings
import dev.exe.bucketcapture.data.UploadItem
import dev.exe.bucketcapture.upload.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.util.UUID

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as CaptureApplication
    val items: StateFlow<List<UploadItem>> = app.spool.items.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    var settings by mutableStateOf(app.settings.load()); private set
    var message by mutableStateOf<String?>(null); private set
    var testing by mutableStateOf(false); private set
    init { viewModelScope.launch { app.spool.recover() } }
    fun update(value: BucketSettings) { settings = value }
    fun save() { app.settings.save(settings); message = "Settings saved"; SyncScheduler.schedule(app) }
    fun test() { app.settings.save(settings); testing = true; message = "Writing zero-byte probe (it will remain in the bucket)…"
        viewModelScope.launch { val key = "${settings.normalizedPrefix()}probe/${UUID.randomUUID()}"
            message = when (val r = app.uploader.probe(settings, key)) { PutResult.Success -> "Probe PUT succeeded: $key"; is PutResult.Retry -> "Temporary failure: ${r.detail}"; is PutResult.ConfigurationError -> "Connection test failed: ${r.detail}" }
            testing = false
        }
    }
}

class MainActivity : ComponentActivity() {
    private val model: MainViewModel by viewModels()
    override fun onCreate(savedInstanceState: android.os.Bundle?) { super.onCreate(savedInstanceState); setContent { MaterialTheme { Screen(model) } } }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable private fun Screen(vm: MainViewModel) {
        val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result[Manifest.permission.RECORD_AUDIO] == true &&
                (result[Manifest.permission.ACCESS_FINE_LOCATION] == true || result[Manifest.permission.ACCESS_COARSE_LOCATION] == true)) {
                startForegroundService(this, Intent(this, CaptureService::class.java).setAction(CaptureService.ACTION_START))
            }
        }
        val rows by vm.items.collectAsStateWithLifecycle()
        var showSettings by remember { mutableStateOf(!vm.settings.isComplete()) }
        Scaffold(topBar = { TopAppBar(title = { Text("Bucket Capture") }) }) { padding ->
            LazyColumn(Modifier.padding(padding).padding(16.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item { Text("Direct, write-only capture", style = MaterialTheme.typography.titleLarge); Text("Audio and GPS stay local until an S3-compatible PUT succeeds. No bucket reads, lists, or deletes are used.") }
                item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { val p = buildList { add(Manifest.permission.RECORD_AUDIO); add(Manifest.permission.ACCESS_FINE_LOCATION); add(Manifest.permission.ACCESS_COARSE_LOCATION); if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS) }; request.launch(p.toTypedArray()) }) { Text("Start capture") }
                    OutlinedButton(onClick = { startService(Intent(this@MainActivity, CaptureService::class.java).setAction(CaptureService.ACTION_STOP)) }) { Text("Stop") }
                    OutlinedButton(onClick = { SyncScheduler.schedule(this@MainActivity, true) }) { Text("Sync now") }
                } }
                item { OutlinedButton(onClick = { showSettings = !showSettings }) { Text(if (showSettings) "Hide bucket settings" else "Bucket settings") } }
                if (showSettings) item { SettingsForm(vm) }
                item { Text("Reliability", style = MaterialTheme.typography.titleMedium); Text("For continuous capture, allow background location separately in Android settings and consider exempting this app from battery optimization. Android requires a tap to resume microphone capture after reboot.")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }) { Text("App permissions") }
                        TextButton(onClick = { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }) { Text("Battery settings") }
                    }
                }
                item { Text("Local manifest", style = MaterialTheme.typography.titleMedium); Text("${rows.count { it.state.name == "PENDING" }} pending · ${rows.count { it.state.name == "UPLOADED" }} uploaded") }
                items(rows, key = { it.id }) { item -> ListItem(headlineContent = { Text(item.kind + " · " + item.state.name.lowercase()) }, supportingContent = { Text(item.objectKey + (item.lastError?.let { "\n$it" } ?: "")) }) }
            }
        }
    }

    @Composable private fun SettingsForm(vm: MainViewModel) {
        val s = vm.settings
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Field("HTTPS endpoint", s.endpoint) { vm.update(s.copy(endpoint = it)) }
            Field("Bucket", s.bucket) { vm.update(s.copy(bucket = it)) }
            Field("Region", s.region) { vm.update(s.copy(region = it)) }
            Field("Access key", s.accessKey) { vm.update(s.copy(accessKey = it)) }
            OutlinedTextField(s.secretKey, { vm.update(s.copy(secretKey = it)) }, Modifier.fillMaxWidth(), label = { Text("Secret key") }, visualTransformation = PasswordVisualTransformation(), singleLine = true)
            Field("Optional key prefix", s.prefix) { vm.update(s.copy(prefix = it)) }
            Row { Checkbox(s.unmeteredOnly, { vm.update(s.copy(unmeteredOnly = it)) }); Text("Prefer unmetered network", Modifier.padding(top = 12.dp)) }
            Text("Credentials are encrypted with Android Keystore. Connection test creates a zero-byte probe object that cannot be removed by this write-only app.", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Button(onClick = vm::save) { Text("Save") }; OutlinedButton(onClick = vm::test, enabled = !vm.testing) { Text("Test PUT") } }
            vm.message?.let { Text(it) }
        }
    }
    @Composable private fun Field(label: String, value: String, update: (String) -> Unit) = OutlinedTextField(value, update, Modifier.fillMaxWidth(), label = { Text(label) }, singleLine = true)
}
