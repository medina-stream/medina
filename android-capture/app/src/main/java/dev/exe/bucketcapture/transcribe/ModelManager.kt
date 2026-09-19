package dev.exe.bucketcapture.transcribe

import android.content.Context
import androidx.work.*
import dev.exe.bucketcapture.CaptureApplication
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * On-device transcription model (whisper.cpp ggml). Downloaded once on
 * unmetered wifi into the app's private files dir — never bundled, so the
 * APK stays lean. tiny.en (~75 MB) is the speed/quality tradeoff for a
 * first-look transcript; the server pipeline still produces the canonical
 * transcript.
 */
object ModelManager {
    const val MODEL_NAME = "ggml-tiny.en.bin"
    const val MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"
    private const val MIN_BYTES = 10_000_000L

    fun modelFile(context: Context): File =
        File(context.filesDir, "models/$MODEL_NAME").apply { parentFile?.mkdirs() }

    fun isPresent(context: Context): Boolean {
        val f = modelFile(context)
        return f.isFile && f.length() > MIN_BYTES
    }

    fun scheduleDownload(context: Context) {
        val request = OneTimeWorkRequestBuilder<ModelDownloadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 5, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork("whisper-model", ExistingWorkPolicy.KEEP, request)
    }
}

class ModelDownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val app = applicationContext as CaptureApplication
        if (ModelManager.isPresent(app)) return@withContext Result.success()
        val target = ModelManager.modelFile(app)
        val tmp = File(target.parentFile, "${ModelManager.MODEL_NAME}.part")
        try {
            val client = OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS).readTimeout(5, TimeUnit.MINUTES).build()
            client.newCall(Request.Builder().url(ModelManager.MODEL_URL).build()).execute().use { response ->
                if (!response.isSuccessful) {
                    return@withContext if (response.code in 500..599) Result.retry()
                    else Result.failure(workDataOf("error" to "Model download HTTP ${response.code}"))
                }
                val body = response.body ?: return@withContext Result.retry()
                tmp.outputStream().use { out -> body.byteStream().copyTo(out) }
            }
            check(tmp.length() > 0) { "Downloaded model is empty" }
            check(tmp.renameTo(target)) { "Could not finalize model file" }
            Result.success()
        } catch (e: Exception) {
            runCatching { tmp.delete() }
            Result.retry()
        }
    }
}
