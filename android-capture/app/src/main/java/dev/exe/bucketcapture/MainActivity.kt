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
import dev.exe.bucketcapture.data.PolicyFetchResult
import dev.exe.bucketcapture.data.PolicyState
import dev.exe.bucketcapture.data.UploadItem
import dev.exe.bucketcapture.upload.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date
import java.util.UUID

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as CaptureApplication
    val items: StateFlow<List<UploadItem>> = app.spool.items.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    var policyState by mutableStateOf<PolicyState>(app.policies.state()); private set
    var policyUrlField by mutableStateOf(app.policies.policyUrl); private set
    var message by mutableStateOf<String?>(null); private set
    var refreshing by mutableStateOf(false); private set
    var testing by mutableStateOf(false); private set
    val captureDesired: Boolean get() = app.getSharedPreferences("capture", android.content.Context.MODE_PRIVATE).getBoolean("desired", false)
    val usingLegacy: Boolean get() = app.policies.usingLegacySettings()

    init {
        viewModelScope.launch { app.spool.recover() }
        SyncScheduler.schedulePolicy(app)
        if (app.policies.hasPolicyUrl && !app.policies.isRevoked) refreshPolicy()
    }

    fun updateUrl(value: String) { policyUrlField = value }
    fun saveUrl() {
        app.policies.policyUrl = policyUrlField
        message = "Policy URL saved"
        refreshPolicy()
    }
    fun refreshPolicy() {
        if (refreshing) return
        refreshing = true
        viewModelScope.launch(Dispatchers.IO) {
            val result = app.policies.refresh()
            withContext(Dispatchers.Main) {
                policyState = app.policies.state()
                message = when (result) {
                    is PolicyFetchResult.Success -> if (result.changed) "Policy updated to v${result.policy.version}" else "Policy is up to date (v${result.policy.version})"
                    is PolicyFetchResult.Transient -> "Policy refresh failed: ${result.detail}"
                    PolicyFetchResult.Revoked -> "This policy URL was revoked on the server"
                }
                refreshing = false
            }
            if (result is PolicyFetchResult.Success && result.changed && captureDesired) {
                app.startService(Intent(app, CaptureService::class.java).setAction(CaptureService.ACTION_REPOLICY))
            }
            if (result is PolicyFetchResult.Success) SyncScheduler.schedule(app)
        }
    }
    fun test() {
        val settings = app.policies.bucketSettings()
        if (settings == null) { message = "No upload credentials: configure the policy URL first"; return }
        testing = true; message = "Writing zero-byte probe (it will remain in the bucket)…"
        viewModelScope.launch(Dispatchers.IO) {
            val key = "${settings.normalizedPrefix()}probe/${UUID.randomUUID()}"
            val text = when (val r = app.uploader.probe(settings, key)) {
                PutResult.Success -> "Probe PUT succeeded: $key"
                is PutResult.Retry -> "Temporary failure: ${r.detail}"
                is PutResult.ConfigurationError -> "Connection test failed: ${r.detail}"
            }
            withContext(Dispatchers.Main) { message = text; policyState = app.policies.state(); testing = false }
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
        var showSettings by remember { mutableStateOf(vm.policyState is PolicyState.NotConfigured || vm.policyState is PolicyState.Revoked) }
        Scaffold(topBar = { TopAppBar(title = { Text("Bucket Capture") }) }) { padding ->
            LazyColumn(Modifier.padding(padding).padding(16.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item { PolicyCard(vm) { showSettings = true } }
                item { DirectiveRows(vm) }
                item { Text("Direct, write-only capture", style = MaterialTheme.typography.titleLarge); Text("Audio and GPS stay local until an S3-compatible PUT succeeds. No bucket reads, lists, or deletes are used.") }
                item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { val p = buildList { add(Manifest.permission.RECORD_AUDIO); add(Manifest.permission.ACCESS_FINE_LOCATION); add(Manifest.permission.ACCESS_COARSE_LOCATION); if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS) }; request.launch(p.toTypedArray()) }) { Text("Start capture") }
                    OutlinedButton(onClick = { startService(Intent(this@MainActivity, CaptureService::class.java).setAction(CaptureService.ACTION_STOP)) }) { Text("Stop") }
                    OutlinedButton(onClick = { SyncScheduler.schedule(this@MainActivity, true) }) { Text("Sync now") }
                } }
                item { OutlinedButton(onClick = { showSettings = !showSettings }) { Text(if (showSettings) "Hide policy settings" else "Policy settings") } }
                if (showSettings) item { PolicyForm(vm) }
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

    @Composable private fun PolicyCard(vm: MainViewModel, onConfigure: () -> Unit) {
        val (title, detail) = when (val s = vm.policyState) {
            PolicyState.NotConfigured -> "No policy configured" to "Paste the policy URL from your Medina server to provision this device."
            is PolicyState.Unreachable -> "Policy unreachable" to s.detail
            is PolicyState.Active -> "Policy v${s.policy.version}" to buildString {
                append("Fetched ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(s.fetchedAt))}")
                if (vm.usingLegacy) append(" · uploads use on-device settings")
                s.staleError?.let { append("\nLast refresh failed: $it — using cached policy") }
            }
            PolicyState.Revoked -> "Policy revoked" to "The server rejected this policy URL. Paste a new one."
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(detail, style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = vm::refreshPolicy, enabled = !vm.refreshing) { Text(if (vm.refreshing) "Refreshing…" else "Refresh policy") }
                    if (vm.policyState is PolicyState.NotConfigured || vm.policyState is PolicyState.Revoked) {
                        Button(onClick = onConfigure) { Text("Configure") }
                    }
                }
                vm.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }

    @Composable private fun DirectiveRows(vm: MainViewModel) {
        val policy = (vm.policyState as? PolicyState.Active)?.policy
        if (policy == null) return
        val running = vm.captureDesired
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            DirectiveRow("Audio", when {
                !policy.audio.enabled -> "Disabled by policy"
                running -> "Capturing · ${policy.audio.describe()}"
                else -> "Stopped · ${policy.audio.describe()}"
            })
            DirectiveRow("Location", when {
                !policy.gps.enabled -> "Disabled by policy"
                running -> "Capturing · ${policy.gps.describe()}"
                else -> "Stopped · ${policy.gps.describe()}"
            })
            val upload = policy.upload
            DirectiveRow("Upload", when {
                !upload.isComplete() && vm.usingLegacy -> "On-device settings · legacy mode"
                !upload.isComplete() -> "No credentials in policy — uploads paused"
                else -> "${upload.describe()}${if (upload.unmeteredOnly) " · unmetered only" else ""}"
            })
        }
    }

    @Composable private fun DirectiveRow(label: String, detail: String) {
        ListItem(headlineContent = { Text(label) }, supportingContent = { Text(detail) })
    }

    @Composable private fun PolicyForm(vm: MainViewModel) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(vm.policyUrlField, vm::updateUrl, Modifier.fillMaxWidth(), label = { Text("Policy URL") },
                visualTransformation = PasswordVisualTransformation(), singleLine = true)
            Text("One URL provisions the whole device: what to capture and where to send it, including upload credentials. The URL is the credential — anyone holding it can fetch the policy.", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = vm::saveUrl) { Text("Save") }
                OutlinedButton(onClick = vm::test, enabled = !vm.testing) { Text("Test PUT") }
            }
            Text("Connection test creates a zero-byte probe object that cannot be removed by this write-only app.", style = MaterialTheme.typography.bodySmall)
        }
    }
}
