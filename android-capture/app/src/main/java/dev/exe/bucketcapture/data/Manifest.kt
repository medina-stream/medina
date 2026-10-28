package dev.exe.bucketcapture.data

import android.content.Context
import androidx.room.*
import kotlinx.coroutines.flow.Flow

enum class UploadState { PENDING, UPLOADED }

@Entity(tableName = "upload_items", indices = [Index(value = ["objectKey"], unique = true), Index("state")])
data class UploadItem(
    @PrimaryKey val id: String,
    val objectKey: String,
    val kind: String,
    val localPath: String,
    val contentType: String,
    val byteCount: Long,
    val contentMd5: String,
    val createdAt: Long,
    val state: UploadState = UploadState.PENDING,
    val attemptCount: Int = 0,
    val lastError: String? = null,
    val uploadedAt: Long? = null,
)

@Entity(tableName = "location_fixes", indices = [Index("capturedAt")])
data class LocationFix(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val capturedAt: Long,
    val elapsedRealtimeNanos: Long,
    val latitude: Double,
    val longitude: Double,
    val accuracy: Float,
    val altitude: Double?,
    val speed: Float?,
    val bearing: Float?,
    val isMock: Boolean,
)

class Converters {
    @TypeConverter fun state(value: String) = UploadState.valueOf(value)
    @TypeConverter fun state(value: UploadState) = value.name
}

@Dao
interface ManifestDao {
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insert(item: UploadItem)
    // Newest-first is deliberate (Scott, Oct 27): an upload pass works
    // the freshest recordings first, matching the home screen's queue,
    // which is also newest-first. This reverses the original
    // oldest-first drain order.
    @Query("SELECT * FROM upload_items WHERE state = 'PENDING' ORDER BY createdAt DESC LIMIT :limit")
    suspend fun pending(limit: Int = 20): List<UploadItem>
    @Query("SELECT * FROM upload_items WHERE state = 'PENDING' ORDER BY createdAt DESC")
    suspend fun pendingAll(): List<UploadItem>
    @Query("SELECT * FROM upload_items WHERE id = :id LIMIT 1") suspend fun getById(id: String): UploadItem?
    @Query("SELECT * FROM upload_items WHERE kind = 'audio' ORDER BY createdAt DESC LIMIT 1")
    suspend fun latestAudio(): UploadItem?
    @Query("SELECT * FROM upload_items ORDER BY createdAt DESC") fun observeAll(): Flow<List<UploadItem>>
    @Query("SELECT COUNT(*) FROM upload_items WHERE state = 'PENDING'") fun pendingCount(): Flow<Int>
    @Query("SELECT COUNT(*) FROM upload_items WHERE localPath = :path") suspend fun countPath(path: String): Int
    @Query("UPDATE upload_items SET state = 'PENDING', localPath = :path, byteCount = :bytes, contentMd5 = :md5, createdAt = :now, lastError = NULL, uploadedAt = NULL WHERE id = :id")
    suspend fun refreshPayload(id: String, path: String, bytes: Long, md5: String, now: Long)
    // Guarded to PENDING rows: upload passes race (foreground, scheduled,
    // manual), and a pass holding a stale snapshot must not stamp an
    // error onto a row another pass has since uploaded — nothing would
    // ever clear it, since only PENDING rows are processed again.
    @Query("UPDATE upload_items SET attemptCount = attemptCount + 1, lastError = :message WHERE id = :id AND state = 'PENDING'")
    suspend fun failed(id: String, message: String)
    @Query("UPDATE upload_items SET state = 'UPLOADED', uploadedAt = :at, lastError = NULL WHERE id = :id AND state = 'PENDING'")
    suspend fun uploaded(id: String, at: Long): Int
    @Query("SELECT * FROM upload_items WHERE state = 'UPLOADED' AND localPath != ''") suspend fun uploadedWithFiles(): List<UploadItem>
    @Query("UPDATE upload_items SET localPath = '' WHERE id = :id AND state = 'UPLOADED'") suspend fun cleared(id: String)
    @Query("DELETE FROM upload_items WHERE state = 'UPLOADED' AND uploadedAt < :before AND localPath = ''") suspend fun prune(before: Long)
    /** Heals rows uploaded by older builds that carry a stale error from
     * a racing pass: an UPLOADED row's lastError is meaningless. */
    @Query("UPDATE upload_items SET lastError = NULL WHERE state = 'UPLOADED' AND lastError IS NOT NULL")
    suspend fun clearUploadedErrors()
}

@Dao
interface LocationDao {
    @Insert suspend fun insert(fix: LocationFix)
    @Query("SELECT * FROM location_fixes ORDER BY id LIMIT :limit") suspend fun oldest(limit: Int): List<LocationFix>
    @Query("SELECT COUNT(*) FROM location_fixes") suspend fun count(): Int
    @Query("DELETE FROM location_fixes WHERE id IN (:ids)") suspend fun delete(ids: List<Long>)
}

@Database(entities = [UploadItem::class, LocationFix::class], version = 1, exportSchema = true)
@TypeConverters(Converters::class)
abstract class CaptureDatabase : RoomDatabase() {
    abstract fun manifest(): ManifestDao
    abstract fun locations(): LocationDao
    companion object {
        fun open(context: Context) = Room.databaseBuilder(context, CaptureDatabase::class.java, "capture.db").build()
    }
}
