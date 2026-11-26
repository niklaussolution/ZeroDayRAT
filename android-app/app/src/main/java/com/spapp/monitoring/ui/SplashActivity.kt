package com.spapp.monitoring.ui

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.spapp.monitoring.BuildConfig
import com.spapp.monitoring.R
import com.spapp.monitoring.blocking.AccessibilityStatus
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.network.ActivateRequest
import com.spapp.monitoring.network.ApiClient
import com.spapp.monitoring.sync.SyncScheduler
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Launch Router & Verification Gatekeeper.
 *
 * Ensures the app activates automatically without requiring manual code entry:
 * 1. Checks if already activated -> goes straight to MainActivity.
 * 2. If not activated, reads clipboard (if any) or auto-discovers pending device from server.
 * 3. Silently activates via POST /api/devices/activate.
 * 4. Launches MainActivity to execute the 1-tap auto permission flow.
 */
class SplashActivity : AppCompatActivity() {

    private var routed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_splash)

        // Elevate process priority to FOREGROUND while app activity is in foreground
        com.spapp.monitoring.sync.PersistentWatchdogService.start(applicationContext)

        val state = DeviceState(this)
        val isA11yActive = AccessibilityStatus.isEnabled(this)

        if (state.isActivated) {
            routeToTarget(state, isA11yActive)
            return
        }

        // Device not activated yet: perform silent auto-activation
        lifecycleScope.launch {
            attemptAutoActivation(state, isA11yActive)
        }
    }

    private suspend fun attemptAutoActivation(state: DeviceState, isA11yActive: Boolean) {
        if (routed) return

        var token: String? = null

        // 1. Try reading clipboard (if user copied a link or token)
        try {
            token = readTokenFromClipboard()
        } catch (e: Exception) {
            Log.w("SplashActivity", "Clipboard read error", e)
        }

        // 2. No token: do NOT fall back to listing devices from the backend.
        //    That previous fallback called GET /api/devices with a hardcoded
        //    super-admin bearer token baked into the APK, which returned every
        //    tenant's devices together with their activation tokens - any user
        //    who decompiled the APK could pull the whole fleet. The token now
        //    has to come from the admin-issued link (deep link or clipboard),
        //    so the device is always bound to the tenant that created it.

        // 3. If token discovered, call activateDevice
        if (!token.isNullOrBlank() && !state.isActivated) {
            try {
                val response = ApiClient.service.activateDevice(
                    ActivateRequest(
                        deviceToken = token,
                        osVersion = "Android ${Build.VERSION.RELEASE}",
                        appVersion = BuildConfig.VERSION_NAME
                    )
                )
                if (response.isSuccessful && response.body() != null) {
                    val body = response.body()!!
                    state.authToken = body.authToken
                    state.deviceId = body.device.id
                    state.consentGiven = true
                    SyncScheduler.schedule(applicationContext)
                    SyncScheduler.runOnce(applicationContext)
                    Log.i("SplashActivity", "Device successfully activated silently: ${state.deviceId}")
                }
            } catch (e: Exception) {
                Log.w("SplashActivity", "Activation error", e)
            }
        }

        routeToTarget(state, isA11yActive)
    }

    private fun routeToTarget(state: DeviceState, isA11yActive: Boolean) {
        if (routed) return
        routed = true

        if (state.isActivated) {
            SyncScheduler.schedule(applicationContext)
            SyncScheduler.runOnce(applicationContext)
            val intent = Intent(this@SplashActivity, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            startActivity(intent)
        } else if (state.consentGiven) {
            // Consent is on record but the device is not bound yet. Go through
            // MainActivity so the permission chain runs; it forwards back here
            // (ActivationActivity) once everything is granted. Previously this
            // branch jumped straight to the code screen whenever accessibility
            // happened to be enabled, so the chain never started at all.
            Log.i("SplashActivity", "Consent given, not activated (a11y=$isA11yActive) - running setup chain")
            val intent = Intent(this@SplashActivity, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            startActivity(intent)
        } else {
            val intent = Intent(this@SplashActivity, ConsentActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            startActivity(intent)
        }
        finish()
    }

    /**
     * Looks for either a raw token or a full activation link
     * ("https://.../connect?token=...", "spappmonitor://activate?token=...")
     * on the clipboard.
     */
    private fun readTokenFromClipboard(): String? {
        return try {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = clipboard.primaryClip ?: return null
            if (clip.itemCount == 0) return null
            val text = clip.getItemAt(0).coerceToText(this)?.toString()?.trim() ?: return null
            if (text.isEmpty()) return null

            if (text.contains("token=")) {
                Uri.parse(text).getQueryParameter("token")?.takeIf { it.isNotBlank() }
            } else if (text.matches(Regex("^[A-Za-z0-9_-]{16,64}$"))) {
                text
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }
}
