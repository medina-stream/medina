package dev.exe.bucketcapture.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import dev.exe.bucketcapture.data.PolicyApk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.time.Duration

/** A user-facing install failure: the message is shown verbatim in the UI. */
class UpdateInstallException(message: String) : Exception(message)

/**
 * Downloads a policy-advertised build and hands it to the system
 * package installer. The file is verified against the policy's SHA-256
 * and size before the installer ever sees it; a mismatch discards the
 * download. Runs only from an explicit Install tap, on any network —
 * the user is standing here asking for it.
 */
class UpdateInstaller(private val context: Context) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(Duration.ofSeconds(15))
        .readTimeout(Duration.ofSeconds(120))
        .build()

    suspend fun downloadAndInstall(apk: PolicyApk, onPhase: (String) -> Unit): Result<Unit> =
        withContext(Dispatchers.IO) {
            val dir = File(context.cacheDir, "updates").apply { mkdirs() }
            val partial = File(dir, "${apk.stamp}.apk.part")
            val target = File(dir, "${apk.stamp}.apk")
            val result = runCatching {
                onPhase("Downloading…")
                val digest = MessageDigest.getInstance("SHA-256")
                var total = 0L
                val request = Request.Builder().url(apk.url).build()
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        throw UpdateInstallException("Download failed (HTTP ${response.code})")
                    }
                    val body = response.body
                        ?: throw UpdateInstallException("Download failed (empty response)")
                    body.byteStream().use { input ->
                        partial.outputStream().use { out ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buffer)
                                if (n < 0) break
                                digest.update(buffer, 0, n)
                                out.write(buffer, 0, n)
                                total += n
                            }
                        }
                    }
                }
                onPhase("Verifying…")
                if (total != apk.sizeBytes) {
                    throw UpdateInstallException(
                        "Download size mismatch (${total} of ${apk.sizeBytes} bytes) — discarded"
                    )
                }
                val sha256 = digest.digest().joinToString("") { "%02x".format(it) }
                if (sha256 != apk.sha256) {
                    throw UpdateInstallException("Download checksum mismatch — discarded")
                }
                if (!partial.renameTo(target)) {
                    throw UpdateInstallException("Could not stage the downloaded update")
                }
                withContext(Dispatchers.Main) { launchInstaller(target) }
            }
            if (result.isFailure) partial.delete()
            result
        }

    private fun launchInstaller(file: File) {
        if (!context.packageManager.canRequestPackageInstalls()) {
            // The grant belongs to the system UI; send the user to its
            // toggle and let them tap Install again afterwards.
            val settings = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { context.startActivity(settings) }
            throw UpdateInstallException(
                "Allow installs from this app in Settings, then tap Install again"
            )
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}
