package dev.exe.bucketcapture.transcribe

import android.content.Context
import androidx.work.*
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
 */
class TranscribeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.Default) {
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
            val result = engine.transcribe(pcm)
            withContext(Dispatchers.IO) { spoolTranscript(app, item, result) }
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
    ) {
        val (id, key, file) = app.spool.newIdentity("transcript", "json")
        val segments = JSONArray()
        result.segments.forEach { s ->
            segments.put(JSONObject().put("start", s.startSec).put("end", s.endSec).put("text", s.text))
        }
        val payload = JSONObject()
            .put("schemaVersion", 1)
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
    }
}
