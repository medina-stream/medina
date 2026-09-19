package dev.exe.bucketcapture.data

import android.content.Context
import android.os.StatFs
import android.util.Base64
import androidx.room.withTransaction
import dev.exe.bucketcapture.upload.SyncScheduler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

class SpoolRepository(private val context: Context, private val db: CaptureDatabase, private val policies: PolicyStore) {
    val items = db.manifest().observeAll()
    val pendingCount = db.manifest().pendingCount()
    fun directory(kind: String, now: Instant = Instant.now()): File = File(context.filesDir,
        "spool/$kind/${DateTimeFormatter.ofPattern("yyyy/MM/dd").withZone(ZoneOffset.UTC).format(now)}").apply { mkdirs() }
    fun newIdentity(kind: String, extension: String, now: Instant = Instant.now()): Triple<String, String, File> {
        val id = UUID.randomUUID().toString()
        val date = DateTimeFormatter.ofPattern("yyyy/MM/dd").withZone(ZoneOffset.UTC).format(now)
        val stamp = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC).format(now)
        val key = "${policies.uploadPrefix()}${installationId()}/$kind/$date/$stamp-$id.$extension"
        return Triple(id, key, File(directory(kind, now), "$id.$extension"))
    }
    /**
     * Identity for a live (provisional) transcript: the object key is stable
     * per segment (`<segmentUuid>.live.json`) so each 30s tick overwrites the
     * previous partial instead of accumulating objects. The manifest row id
     * is likewise stable per segment; see [upsertLiveTranscript].
     */
    fun newLiveTranscriptIdentity(segmentUuid: String, now: Instant = Instant.now()): Triple<String, String, File> {
        val id = "live-$segmentUuid"
        val date = DateTimeFormatter.ofPattern("yyyy/MM/dd").withZone(ZoneOffset.UTC).format(now)
        val key = "${policies.uploadPrefix()}${installationId()}/transcript/$date/$segmentUuid.live.json"
        return Triple(id, key, File(directory("transcript", now), "$id.json"))
    }

    /**
     * Insert-or-refresh the live transcript row for a segment. Each tick
     * replaces the payload and re-pends the row so the new text uploads;
     * the stable id keeps one row per segment instead of one per tick.
     */
    suspend fun upsertLiveTranscript(id: String, key: String, file: File) = withContext(Dispatchers.IO) {
        require(file.isFile && file.length() > 0) { "Payload is empty" }
        val now = System.currentTimeMillis()
        if (db.manifest().getById(id) == null) {
            db.manifest().insert(UploadItem(id, key, "transcript", file.absolutePath, "application/json", file.length(), md5(file), now))
        } else {
            db.manifest().refreshPayload(id, file.absolutePath, file.length(), md5(file), now)
        }
        // Fresh partial: start moving it now instead of waiting for the next trigger.
        SyncScheduler.schedule(context)
    }

    suspend fun enqueue(id: String, key: String, kind: String, file: File, type: String) = withContext(Dispatchers.IO) {
        require(file.isFile && file.length() > 0) { "Payload is empty" }
        db.manifest().insert(UploadItem(id, key, kind, file.absolutePath, type, file.length(), md5(file), System.currentTimeMillis()))
        // Fresh payload: start moving it now instead of waiting for the next trigger.
        SyncScheduler.schedule(context)
    }
    suspend fun addFix(fix: LocationFix) { db.locations().insert(fix); if (db.locations().count() >= 100) sealLocations() }
    /**
     * Emit one `location.fix` device event per fix (docs/events-plan.md).
     * Each fix becomes its own tiny JSON object under `events/<install>/…`
     * instead of accumulating into sealed location batches, so the server
     * sees location in ~real time. The activity label rides along so the
     * server never guesses transport mode from GPS speed.
     */
    suspend fun emitLocationEvent(fix: LocationFix, activity: dev.exe.bucketcapture.capture.ActivityReading?) = withContext(Dispatchers.IO) {
        val id = UUID.randomUUID().toString()
        val now = Instant.now()
        val date = DateTimeFormatter.ofPattern("yyyy/MM/dd").withZone(ZoneOffset.UTC).format(now)
        val stamp = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC).format(now)
        val key = "${policies.uploadPrefix()}${installationId()}/events/$date/$stamp-$id.json"
        val dir = File(context.filesDir, "spool/events/$date").apply { mkdirs() }
        val file = File(dir, "$id.json")
        val envelope = JSONObject()
            .put("schemaVersion", 1)
            .put("id", id)
            .put("device", installationId())
            .put("seq", nextEventSeq())
            .put("at", now.toString())
            .put("type", "location.fix")
            .put("payload", JSONObject()
                .put("lat", fix.latitude)
                .put("lon", fix.longitude)
                .put("accuracyM", fix.accuracy)
                .putOpt("speedMps", fix.speed)
                .putOpt("bearingDeg", fix.bearing)
                .put("mock", fix.isMock)
                .put("activity", JSONObject()
                    .put("type", activity?.activity?.label ?: "unknown")
                    .put("confidence", activity?.confidence ?: 0)))
        file.outputStream().use { it.write(envelope.toString().toByteArray()); it.fd.sync() }
        db.manifest().insert(UploadItem(id, key, "event", file.absolutePath, "application/json", file.length(), md5(file), System.currentTimeMillis()))
        // Fresh fix: start moving it now instead of waiting for the next trigger.
        SyncScheduler.schedule(context)
    }

    /** Monotonic per-device event sequence, persisted across restarts. */
    private fun nextEventSeq(): Long {
        val prefs = context.getSharedPreferences("device-events", Context.MODE_PRIVATE)
        val next = prefs.getLong("seq", 0L) + 1
        prefs.edit().putLong("seq", next).apply()
        return next
    }
    suspend fun sealLocations() = withContext(Dispatchers.IO) {
        val fixes = db.locations().oldest(100); if (fixes.isEmpty()) return@withContext
        val (id, key, file) = newIdentity("location", "json")
        val entries = JSONArray()
        fixes.forEach { f -> entries.put(JSONObject().put("timestamp", Instant.ofEpochMilli(f.capturedAt).toString())
            .put("elapsedRealtimeNanos", f.elapsedRealtimeNanos).put("latitude", f.latitude).put("longitude", f.longitude)
            .put("accuracy", f.accuracy).putOpt("altitude", f.altitude).putOpt("speed", f.speed).putOpt("bearing", f.bearing).put("mock", f.isMock)) }
        val payload = JSONObject().put("schemaVersion", 1).put("locations", entries).toString().toByteArray()
        val temp = File(file.parentFile, "$id.tmp")
        temp.outputStream().use { it.write(payload); it.fd.sync() }
        check(temp.renameTo(file)) { "Could not finalize location batch" }
        val item = UploadItem(id, key, "location", file.absolutePath, "application/json", file.length(), md5(file), System.currentTimeMillis())
        db.withTransaction { db.manifest().insert(item); db.locations().delete(fixes.map { it.id }) }
        SyncScheduler.schedule(context)
    }
    suspend fun recover() = withContext(Dispatchers.IO) {
        val root = File(context.filesDir, "spool")
        root.walkTopDown().filter { it.isFile && (it.extension == "recording" || it.extension == "tmp") }.forEach { partial ->
            val quarantine = File(context.filesDir, "spool/quarantine").apply { mkdirs() }
            partial.renameTo(File(quarantine, "${System.currentTimeMillis()}-${partial.name}"))
        }
        root.walkTopDown().filter { it.isFile && it.extension in setOf("m4a", "json") }.forEach { file ->
            if (db.manifest().countPath(file.absolutePath) == 0) {
                if (file.extension == "m4a" && file.length() > 0) {
                    val id = file.nameWithoutExtension
                    val relative = file.relativeTo(File(root, "audio")).invariantSeparatorsPath
                    val datePath = relative.substringBeforeLast('/')
                    val stamp = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC).format(Instant.ofEpochMilli(file.lastModified()))
                    val key = "${policies.uploadPrefix()}${installationId()}/audio/$datePath/$stamp-$id.m4a"
                    runCatching { enqueue(id, key, "audio", file, "audio/mp4") }
                } else {
                    // A location file becomes visible before its Room transaction. If
                    // no row exists, the source fixes are still authoritative.
                    file.delete()
                }
            }
        }
        db.manifest().uploadedWithFiles().forEach { item ->
            val file = File(item.localPath); if (!file.exists() || file.delete()) db.manifest().cleared(item.id)
        }
        db.manifest().prune(System.currentTimeMillis() - 90L * 24 * 60 * 60 * 1000)
    }
    fun freeBytes() = StatFs(context.filesDir.absolutePath).availableBytes
    fun installationId(): String {
        val p = context.getSharedPreferences("identity", Context.MODE_PRIVATE)
        return p.getString("installation_id", null) ?: UUID.randomUUID().toString().also { p.edit().putString("installation_id", it).apply() }
    }
    companion object {
        fun md5(file: File): String { val digest = MessageDigest.getInstance("MD5"); FileInputStream(file).use { input ->
            val buffer = ByteArray(64 * 1024); while (true) { val read = input.read(buffer); if (read < 0) break; digest.update(buffer, 0, read) }
        }; return Base64.encodeToString(digest.digest(), Base64.NO_WRAP) }
    }
}
