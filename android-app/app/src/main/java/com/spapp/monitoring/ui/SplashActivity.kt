package com.spapp.monitoring.ui

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.spapp.monitoring.BuildConfig
import com.spapp.monitoring.blocking.AccessibilityStatus
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.network.ActivateRequest
import com.spapp.monitoring.network.ApiClient
import com.spapp.monitoring.sync.SyncScheduler
import kotlinx.coroutines.launch

/**
 * Launch Router & Verification Gatekeeper.
 *
 * Conditional Onboarding Execution Paths:
 * - Path A (Accessibility Service Enabled):
 *   Bypasses the manual/sequential consent onboarding screens entirely.
 *   Automatically marks consent as given, and if activated (via existing token
 *   or clipboard token), routes directly to MainActivity.
 *
 * - Path B (Accessibility Service Not Enabled):
 *   Falls back to the sequential onboarding workflow (ConsentActivity -> Settings).
 */
class SplashActivity : AppCompatActivity() {

    private var routed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val state = DeviceState(this)
        val isA11yActive = AccessibilityStatus.isEnabled(this)

        if (isA11yActive) {
            // Path A: Accessibility permission is already active on the device.
            state.consentGiven = true

            if (state.isActivated) {
                // Device already activated: bypass onboarding completely and go to MainActivity
                routed = true
                SyncScheduler.schedule(applicationContext)
                val intent = Intent(this, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                }
                startActivity(intent)
                finish()
                return
            }
        } else if (state.isActivated) {
            // Standard re-open for activated device
            routed = true
            val intent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            startActivity(intent)
            finish()
            return
        }

        // Not yet activated: wait for onWindowFocusChanged to read the clipboard.
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || routed) return
        routed = true

        val state = DeviceState(this)
        val isA11yActive = AccessibilityStatus.isEnabled(this)
        if (isA11yActive) {
            state.consentGiven = true
        }

        val token = readTokenFromClipboard()
        if (token.isNullOrBlank()) {
            // If accessibility is already active, skip ConsentActivity and open ActivationActivity directly.
            // Otherwise, fall back to ConsentActivity.
            val targetClass = if (isA11yActive) ActivationActivity::class.java else ConsentActivity::class.java
            val intent = Intent(this, targetClass).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            startActivity(intent)
            finish()
            return
        }

        lifecycleScope.launch {
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
                }
            } catch (_: Exception) {
                // No network yet, or an invalid/already-used token — fall through
            }

            if (isA11yActive && state.isActivated) {
                // Path A: Accessibility active & device now activated -> Go directly to MainActivity!
                SyncScheduler.schedule(applicationContext)
                val intent = Intent(this@SplashActivity, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                }
                startActivity(intent)
            } else if (isA11yActive) {
                // Accessibility active but activation token failed: go directly to code entry
                val intent = Intent(this@SplashActivity, ActivationActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                }
                startActivity(intent)
            } else {
                // Path B: Accessibility not active, fall back to sequential consent flow
                val intent = Intent(this@SplashActivity, ConsentActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                }
                startActivity(intent)
            }
            finish()
        }
    }

    /**
     * Looks for either a raw token or a full activation link
     * ("https://.../connect?token=...", "spappmonitor://activate?token=...")
     * on the clipboard, left there by the dashboard's download button.
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
