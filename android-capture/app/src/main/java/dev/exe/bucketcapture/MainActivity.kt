package dev.exe.bucketcapture

import android.Manifest
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat.startForegroundService
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dev.exe.bucketcapture.capture.CaptureService
import dev.exe.bucketcapture.data.PolicyFetchResult
import dev.exe.bucketcapture.data.PolicyState
import dev.exe.bucketcapture.data.UploadItem
import dev.exe.bucketcapture.data.UploadState
import dev.exe.bucketcapture.ui.DotState
import dev.exe.bucketcapture.ui.StatusDot
import dev.exe.bucketcapture.ui.theme.BucketCaptureTheme
import dev.exe.bucketcapture.upload.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

data class HealthSummary(val pending: Int, val uploaded: Int, val errorCount: Int, val lastError: String?)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as CaptureApplication
    val items: StateFlow<List<UploadItem>> = app.spool.items.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val health: StateFlow<HealthSummary> = items.map { list ->
        val errored = list.filter { it.lastError != null }
        HealthSummary(
            pending = list.count { it.state == UploadState.PENDING },
            uploaded = list.count { it.state == UploadState.UPLOADED },
            errorCount = errored.size,
            lastError = errored.maxByOrNull { it.createdAt }?.lastError,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HealthSummary(0, 0, 0, null))

    private val prefs = app.getSharedPreferences("capture", Context.MODE_PRIVATE)
    private val _desired = MutableStateFlow(prefs.getBoolean("desired", false))
    val desired: StateFlow<Boolean> = _desired
    private val prefListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == "desired") _desired.value = prefs.getBoolean("desired", false)
    }

    var policyState by mutableStateOf<PolicyState>(app.policies.state()); private set
    var policyUrlField by mutableStateOf(app.policies.policyUrl); private set
    var message by mutableStateOf<String?>(null); private set
    var refreshing by mutableStateOf(false); private set
    var testing by mutableStateOf(false); private set

    val hostname: String? get() = hostOf(policyUrlField)

    init {
        prefs.registerOnSharedPreferenceChangeListener(prefListener)
        viewModelScope.launch { app.spool.recover() }
        SyncScheduler.schedulePolicy(app)
        if (app.policies.hasPolicyUrl && !app.policies.isRevoked) refreshPolicy()
    }

    override fun onCleared() { prefs.unregisterOnSharedPreferenceChangeListener(prefListener) }

    fun startCaptureService() =
        startForegroundService(app, Intent(app, CaptureService::class.java).setAction(CaptureService.ACTION_START))
    fun stopCaptureService() =
        app.startService(Intent(app, CaptureService::class.java).setAction(CaptureService.ACTION_STOP))

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
            if (result is PolicyFetchResult.Success && result.changed && _desired.value) {
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

private fun hostOf(url: String): String? {
    if (url.isBlank()) return null
    return runCatching { android.net.Uri.parse(url).host?.takeIf { it.isNotBlank() } }.getOrNull()
}

private enum class Screen { Status, Settings, Developers }

class MainActivity : ComponentActivity() {
    private val model: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { BucketCaptureTheme { Root(model) } }
    }

    @Composable
    private fun Root(vm: MainViewModel) {
        var screen by remember { mutableStateOf(Screen.Status) }
        BackHandler(enabled = screen != Screen.Status) {
            screen = if (screen == Screen.Developers) Screen.Settings else Screen.Status
        }
        // First run: land on Settings until a policy URL exists.
        LaunchedEffect(vm.policyState) {
            if (vm.policyState is PolicyState.NotConfigured) screen = Screen.Settings
        }
        when (screen) {
            Screen.Status -> StatusScreen(vm, onOpenSettings = { screen = Screen.Settings })
            Screen.Settings -> SettingsScreen(vm, onBack = { screen = Screen.Status }, onOpenDevelopers = { screen = Screen.Developers })
            Screen.Developers -> DeveloperScreen(vm, onBack = { screen = Screen.Settings })
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun StatusScreen(vm: MainViewModel, onOpenSettings: () -> Unit) {
        val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result[Manifest.permission.RECORD_AUDIO] == true &&
                (result[Manifest.permission.ACCESS_FINE_LOCATION] == true || result[Manifest.permission.ACCESS_COARSE_LOCATION] == true)) {
                vm.startCaptureService()
            }
        }
        val desired by vm.desired.collectAsStateWithLifecycle()
        val health by vm.health.collectAsStateWithLifecycle()
        val host = remember(vm.policyUrlField) { hostOf(vm.policyUrlField) }

        val (dot, headline, subline) = when (val s = vm.policyState) {
            PolicyState.NotConfigured ->
                Triple(DotState.Off, "Not connected", "Add your Medina policy URL in Settings to begin.")
            PolicyState.Revoked ->
                Triple(DotState.Error, "Policy revoked", "This URL was revoked. Enter a new one in Settings.")
            is PolicyState.Unreachable ->
                Triple(DotState.Warn, "Server unreachable", s.detail)
            is PolicyState.Active -> Triple(
                if (desired) DotState.On else DotState.Off,
                if (desired) "Capture on" else "Capture off",
                s.staleError?.let { "Using cached policy" },
            )
        }
        val configured = vm.policyState is PolicyState.Active || vm.policyState is PolicyState.Unreachable

        Scaffold(topBar = {
            TopAppBar(
                title = { Text(host ?: "Medina Capture") },
                actions = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings")
                    }
                },
            )
        }) { padding ->
            Column(
                Modifier.padding(padding).fillMaxSize().padding(horizontal = 24.dp),
                horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.weight(1f))
                StatusDot(dot)
                Spacer(Modifier.height(20.dp))
                Text(headline, style = MaterialTheme.typography.headlineSmall)
                if (subline != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(subline, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (vm.policyState is PolicyState.Active) {
                    Spacer(Modifier.height(12.dp))
                    val anomaly = when {
                        health.errorCount > 0 -> "${health.errorCount} upload error${if (health.errorCount == 1) "" else "s"} · ${health.lastError?.take(80)}"
                        health.pending > 0 -> "${health.pending} pending upload${if (health.pending == 1) "" else "s"}"
                        else -> "Everything uploaded"
                    }
                    Text(
                        anomaly,
                        style = MaterialTheme.typography.labelLarge,
                        color = if (health.errorCount > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(24.dp))
                if (configured) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Switch(
                            checked = desired,
                            onCheckedChange = { on ->
                                if (on) {
                                    val perms = buildList {
                                        add(Manifest.permission.RECORD_AUDIO)
                                        add(Manifest.permission.ACCESS_FINE_LOCATION)
                                        add(Manifest.permission.ACCESS_COARSE_LOCATION)
                                        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
                                    }
                                    request.launch(perms.toTypedArray())
                                } else {
                                    vm.stopCaptureService()
                                }
                            },
                        )
                        Spacer(Modifier.width(12.dp))
                        Text(
                            if (desired) "Enabled" else "Disabled",
                            style = MaterialTheme.typography.titleMedium,
                        )
                    }
                } else {
                    Button(onClick = onOpenSettings) { Text("Open settings") }
                }
                Spacer(Modifier.weight(1f))
            }
        }
    }
}
