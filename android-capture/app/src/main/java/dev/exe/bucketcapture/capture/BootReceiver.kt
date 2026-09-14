package dev.exe.bucketcapture.capture

import android.app.*
import android.content.*
import androidx.core.app.NotificationCompat
import dev.exe.bucketcapture.MainActivity
import dev.exe.bucketcapture.R
import dev.exe.bucketcapture.upload.SyncScheduler

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        SyncScheduler.schedule(context)
        if (!context.getSharedPreferences("capture", Context.MODE_PRIVATE).getBoolean("desired", false)) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Capture recovery", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(context, 3, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify(1002, NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_capture)
            .setContentTitle("Resume Bucket Capture").setContentText("Tap to resume audio and location after restart")
            .setAutoCancel(true).setContentIntent(open).build())
    }
    companion object { private const val CHANNEL = "recovery" }
}
