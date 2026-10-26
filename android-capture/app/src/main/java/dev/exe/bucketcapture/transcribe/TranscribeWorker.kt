package dev.exe.bucketcapture.transcribe

import android.content.Context
import androidx.work.*
import dev.exe.bucketcapture.AppForeground
import dev.exe.bucketcapture.CaptureApplication
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant

/**
 * Best-effort on-device transcription of one sealed audio segment. Decodes the
 * AAC capture to 16 kHz mono PCM, runs whisper.cpp, and spools the result as
 * a `transcript` upload item so the ingest pipeline can treat it as a
 * first-look transcript for the journal — the server still produces the
 * canonical transcript itself.
 *
 * A marker file per audio id records completed transcriptions; failures do
 * not retry forever (a corrupt file would never succeed).
 *
 * Foreground-gated: on-device transcription only runs while the app is in
 * the foreground (see AppForeground). WorkManager may start this worker
 * after the user has already left the app, so a backgrounded attempt defers
 * via Result.retry() instead of transcribing — the work stays queued and
 * lands on a later attempt that finds the app foregrounded. The gate is
 * checked again after decoding, just before the whisper run; a run already
 * inside the (uninterruptible) JNI call when the app backgrounds finishes,
 * but no new run starts in the background.
 */
class TranscribeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.Default) {
        // Transcription is foreground-only: defer (don't fail, don't
        // transcribe) while the app is in the background.
        if (!AppForeground.transcriptionAllowed()) return@withContext Result.retry()
        val app = applicationContext as CaptureApplication
        val audioId = inputData.getString(KEY_AUDIO_ID)
            ?: return@withContext Result.failure(workDataOf("error" to "Missing audio id"))
        if (isTranscribed(app, audioId)) return@withContext Result.success()
        val item = app.db.manifest().getById(audioId)
            ?: return@withContext Result.failure(workDataOf("error" to "Audio item not found"))
        val file = File(item.localPath)
        if (item.kind != "audio" || !file.isFile || file.length() == 0L) {
            return@withContext Result.failure(workDataOf("error" to "Audio payload missing"))
        }
        val engine = WhisperEngine.get(ModelManager.modelFile(app).absolutePath)
            ?: return@withContext Result.failure(workDataOf("error" to "Transcription engine unavailable"))
        try {
            val pcm = withContext(Dispatchers.IO) { AacDecoder.decode(file) }
            if (pcm.isEmpty()) return@withContext Result.failure(workDataOf("error" to "Decoded audio empty"))
            // Re-check the gate: the app may have been backgrounded while we
            // were setting up. Defer rather than start whisper in background.
            if (!AppForeground.transcriptionAllowed()) return@withContext Result.retry()
            val result = engine.transcribe(pcm)
            // The capture id is the sha256 of the audio bytes -- the same
            // content identity the server ingest derives -- so the pipeline
            // can file this transcript without downloading the audio.
            val captureId = withContext(Dispatchers.IO) { sha256(file) }
            withContext(Dispatchers.IO) { spoolTranscript(app, item, result, captureId) }
            markTranscribed(app, audioId)
            // Fresh transcript: move it now under the same rules as other payloads.
            dev.exe.bucketcapture.upload.SyncScheduler.schedule(app)
            Result.success()
        } catch (e: Exception) {
            Result.failure(workDataOf("error" to "Transcription failed: ${e.message}"))
        }
    }

    private suspend fun spoolTranscript(
        app: CaptureApplication,
        audio: dev.exe.bucketcapture.data.UploadItem,
        result: WhisperEngine.Result,
        captureId: String,
    ) {
        val (id, key, file) = app.spool.newIdentity("transcript", "json")
        val segments = JSONArray()
        result.segments.forEach { s ->
            segments.put(JSONObject().put("start", s.startSec).put("end", s.endSec).put("text", s.text))
        }
        val payload = JSONObject()
            .put("schemaVersion", 1)
            .put("captureId", captureId)
            .put("audioId", audio.id)
            .put("audioKey", audio.objectKey)
            .put("capturedAt", Instant.ofEpochMilli(audio.createdAt).toString())
            .put("engine", "whisper.cpp")
            .put("model", "ggml-tiny.en")
            .put("language", "en")
            .put("segments", segments)
            .put("text", result.text)
            .toString()
        val tmp = File(file.parentFile, "$id.tmp")
        tmp.writeText(payload)
        check(tmp.renameTo(file)) { "Could not finalize transcript" }
        app.spool.enqueue(id, key, "transcript", file, "application/json")
    }

    companion object {
        const val KEY_AUDIO_ID = "audioId"
        private const val UNIQUE_PREFIX = "transcribe-"

        fun markerFile(context: Context, audioId: String): File =
            File(context.filesDir, "transcript_markers/$audioId").apply { parentFile?.mkdirs() }

        fun isTranscribed(context: Context, audioId: String): Boolean = markerFile(context, audioId).isFile

        private fun markTranscribed(context: Context, audioId: String) {
            runCatching { markerFile(context, audioId).createNewFile() }
        }

        fun schedule(context: Context, audioId: String) {
            val request = OneTimeWorkRequestBuilder<TranscribeWorker>()
                .setInputData(workDataOf(KEY_AUDIO_ID to audioId))
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(UNIQUE_PREFIX + audioId, ExistingWorkPolicy.KEEP, request)
        }

        /** Hex sha256 of a file's bytes. */
        fun sha256(file: File): String {
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
