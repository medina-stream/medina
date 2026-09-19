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
    @Query("SELECT * FROM upload_items WHERE state = 'PENDING' ORDER BY createdAt LIMIT :limit")
    suspend fun pending(limit: Int = 20): List<UploadItem>
    @Query("SELECT * FROM upload_items WHERE state = 'PENDING' ORDER BY createdAt")
    suspend fun pendingAll(): List<UploadItem>
    @Query("SELECT * FROM upload_items WHERE id = :id LIMIT 1") suspend fun getById(id: String): UploadItem?
    @Query("SELECT * FROM upload_items WHERE kind = 'audio' ORDER BY createdAt DESC LIMIT 1")
    suspend fun latestAudio(): UploadItem?
    @Query("SELECT * FROM upload_items ORDER BY createdAt DESC") fun observeAll(): Flow<List<UploadItem>>
    @Query("SELECT COUNT(*) FROM upload_items WHERE state = 'PENDING'") fun pendingCount(): Flow<Int>
    @Query("SELECT COUNT(*) FROM upload_items WHERE localPath = :path") suspend fun countPath(path: String): Int
    @Query("UPDATE upload_items SET attemptCount = attemptCount + 1, lastError = :message WHERE id = :id")
    suspend fun failed(id: String, message: String)
    @Query("UPDATE upload_items SET state = 'UPLOADED', uploadedAt = :at, lastError = NULL WHERE id = :id AND state = 'PENDING'")
    suspend fun uploaded(id: String, at: Long): Int
    @Query("SELECT * FROM upload_items WHERE state = 'UPLOADED' AND localPath != ''") suspend fun uploadedWithFiles(): List<UploadItem>
    @Query("UPDATE upload_items SET localPath = '' WHERE id = :id AND state = 'UPLOADED'") suspend fun cleared(id: String)
    @Query("DELETE FROM upload_items WHERE state = 'UPLOADED' AND uploadedAt < :before AND localPath = ''") suspend fun prune(before: Long)
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
