package dev.exe.bucketcapture

import android.Manifest
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
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
import kotlinx.coroutines.withTimeoutOrNull
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
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

    private val _syncing = MutableStateFlow<Set<String>>(emptySet())
    /** Item ids the user asked to sync now that are still pending upload. */
    val syncing: StateFlow<Set<String>> = _syncing

    /** Kick an upload pass and track this item until it flips to uploaded (checkmark) or fails. */
    fun syncNow(context: Context, item: UploadItem) {
        if (item.state != UploadState.PENDING || item.id in _syncing.value) return
        _syncing.value = _syncing.value + item.id
        val attemptAt = item.attemptCount
        SyncScheduler.schedule(context, explicit = true)
        viewModelScope.launch {
            withTimeoutOrNull(120_000) {
                items.first { list ->
                    val cur = list.find { it.id == item.id }
                    cur == null || cur.state == UploadState.UPLOADED || cur.attemptCount > attemptAt
                }
            }
            _syncing.value = _syncing.value - item.id
        }
    }

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
    fun showMessage(text: String?) { message = text }
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
                    is PolicyFetchResult.Success -> if (result.changed) "Policy updated to v${result.policy.version}" else null
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

private enum class Screen { Status, Settings, QrScanner }

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
        val context = LocalContext.current
        val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                screen = Screen.QrScanner
            } else {
                vm.showMessage("Camera permission is needed to scan the QR code")
            }
        }
        BackHandler(enabled = screen != Screen.Status) {
            screen = if (screen == Screen.QrScanner) Screen.Settings else Screen.Status
        }
        // First run: land on Settings until a policy URL exists.
        LaunchedEffect(vm.policyState) {
            if (vm.policyState is PolicyState.NotConfigured) screen = Screen.Settings
        }
        when (screen) {
            Screen.Status -> StatusScreen(vm, onOpenSettings = { screen = Screen.Settings })
            Screen.Settings -> SettingsScreen(
                vm,
                onBack = { screen = Screen.Status },
                onScanQr = {
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                        PackageManager.PERMISSION_GRANTED
                    ) {
                        screen = Screen.QrScanner
                    } else {
                        cameraPermission.launch(Manifest.permission.CAMERA)
                    }
                },
            )
            Screen.QrScanner -> QrScannerScreen(
                onScanned = { value ->
                    vm.updateUrl(value)
                    vm.saveUrl()
                    screen = Screen.Settings
                },
                onBack = { screen = Screen.Settings },
            )
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
        var showSyncSheet by remember { mutableStateOf(false) }

        val (dot, headline, subline) = when (val s = vm.policyState) {
            PolicyState.NotConfigured ->
                Triple(DotState.Off, "Not connected", "Add your Medina policy URL in Settings to begin.")
            PolicyState.Revoked ->
                Triple(DotState.Error, "Policy revoked", "This URL was revoked. Enter a new one in Settings.")
            is PolicyState.Unreachable ->
                Triple(DotState.Warn, "Server unreachable", s.detail)
            is PolicyState.Active -> Triple(
                if (desired) DotState.On else DotState.Off,
                null,
                s.staleError?.let { "Using cached policy" },
            )
        }
        val configured = vm.policyState is PolicyState.Active || vm.policyState is PolicyState.Unreachable

        Scaffold(topBar = {
            TopAppBar(
                title = {
                    val name = middleEllipsize(host ?: "Medina Capture")
                    Text(
                        text = name,
                        maxLines = 1,
                        style = when {
                            name.length > 26 -> MaterialTheme.typography.titleSmall
                            name.length > 20 -> MaterialTheme.typography.titleMedium
                            else -> MaterialTheme.typography.titleLarge
                        },
                    )
                },
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
                headline?.let { Text(it, style = MaterialTheme.typography.headlineSmall) }
                if (headline != null) Spacer(Modifier.height(8.dp))
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
                                        if (Build.VERSION.SDK_INT >= 29) add(Manifest.permission.ACTIVITY_RECOGNITION)
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
                    Spacer(Modifier.height(8.dp))
                } else {
                    Button(onClick = onOpenSettings) { Text("Open settings") }
                    Spacer(Modifier.height(8.dp))
                }
                val statusText = when (val s = vm.policyState) {
                    is PolicyState.Active ->
                        if (s.staleError != null) "Running on saved settings" else "Connected"
                    else -> subline
                }
                if (statusText != null) {
                    HomeTapRow(
                        label = "Status",
                        value = statusText,
                        valueColor = MaterialTheme.colorScheme.onSurface,
                        onClick = { showSyncSheet = true },
                    )
                }
                if (vm.policyState is PolicyState.Active) {
                    val inError = health.errorCount > 0
                    HomeTapRow(
                        label = "Issues",
                        value = if (inError) "${health.errorCount} upload error${if (health.errorCount == 1) "" else "s"}" else "Nominal",
                        valueColor = if (inError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                        onClick = { showSyncSheet = true },
                    )
                }
                if (showSyncSheet) SyncStateSheet(vm, onDismiss = { showSyncSheet = false })
                Spacer(Modifier.weight(1f))
            }
        }
    }
}

/** Truncate from the middle so a long hostname always fits on one line, e.g. "very-long-hos…name". */
private fun middleEllipsize(s: String, maxChars: Int = 28): String {
    if (s.length <= maxChars) return s
    val keep = maxChars - 1 // one char for "…"
    val head = keep / 2
    return s.take(head) + "…" + s.takeLast(keep - head)
}

/** A full-width tappable row on the home screen: small label, value, chevron. */
@Composable
private fun HomeTapRow(label: String, value: String, valueColor: Color, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(2.dp))
            Text(value, style = MaterialTheme.typography.bodyLarge, color = valueColor)
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** "Today 14:00–14:15": segment start comes from the UTC stamp in the object key;
 * end is start + the 15-minute segment length. Falls back to createdAt. */
private val KEY_STAMP = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'")
private fun recordingRange(item: UploadItem): String {
    val zone = ZoneId.systemDefault()
    val end = runCatching {
        val stamp = item.objectKey.substringAfterLast('/').substringBefore('-')
        ZonedDateTime.of(LocalDateTime.parse(stamp, KEY_STAMP), ZoneOffset.UTC)
            .withZoneSameInstant(zone)
    }.getOrElse {
        ZonedDateTime.ofInstant(Instant.ofEpochMilli(item.createdAt), zone)
    }
    val start = end.minusMinutes(15)
    val day = when (start.toLocalDate()) {
        LocalDate.now(zone) -> "Today"
        LocalDate.now(zone).minusDays(1) -> "Yesterday"
        else -> start.format(DateTimeFormatter.ofPattern("MMM d"))
    }
    val tf = DateTimeFormatter.ofPattern("HH:mm")
    return "$day ${start.format(tf)}–${end.format(tf)}"
}

private fun formatBytes(bytes: Long): String = when {
    bytes >= 1_000_000 -> "%.1fMB".format(bytes / 1_000_000.0)
    bytes >= 1_000 -> "%.0fKB".format(bytes / 1_000.0)
    else -> "${bytes}B"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SyncStateSheet(vm: MainViewModel, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val health by vm.health.collectAsStateWithLifecycle()
    val items by vm.items.collectAsStateWithLifecycle()
    val syncingIds by vm.syncing.collectAsStateWithLifecycle()
    val inError = health.errorCount > 0
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Sync state", style = MaterialTheme.typography.titleLarge)
            Text(
                text = if (inError) "${health.errorCount} upload error${if (health.errorCount == 1) "" else "s"}" else "Nominal",
                style = MaterialTheme.typography.titleMedium,
                color = if (inError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            )
            Text(
                "${health.pending} pending · ${health.uploaded} uploaded · ${health.errorCount} with errors",
                style = MaterialTheme.typography.bodyMedium,
            )
            health.lastError?.let {
                Text(
                    "Last error: $it",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedButton(onClick = { SyncScheduler.schedule(context, true) }) { Text("Sync now") }
            HorizontalDivider(Modifier.padding(vertical = 4.dp))
            Text("Recordings", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            items.filter { it.kind == "audio" }.take(15).forEach { item ->
                ListItem(
                    headlineContent = { Text(recordingRange(item)) },
                    supportingContent = { Text(formatBytes(item.byteCount)) },
                    trailingContent = {
                        when {
                            item.state == UploadState.UPLOADED -> Icon(
                                Icons.Filled.Check,
                                contentDescription = "Synced",
                                tint = MaterialTheme.colorScheme.primary,
                            )
                            item.id in syncingIds -> CircularProgressIndicator(
                                Modifier.size(24.dp),
                                strokeWidth = 2.dp,
                            )
                            else -> TextButton(onClick = { vm.syncNow(context, item) }) {
                                Text("Sync now")
                            }
                        }
                    },
                )
            }
        }
    }
}
