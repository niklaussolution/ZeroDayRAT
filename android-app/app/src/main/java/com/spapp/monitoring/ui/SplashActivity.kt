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
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.network.ActivateRequest
import com.spapp.monitoring.network.ApiClient
import kotlinx.coroutines.launch

/**
 * Routes to the consent screen on first launch, or straight to the main
 * status screen once the device has already been activated.
 *
 * Before routing, makes one silent attempt to activate using a token found
 * on the clipboard — the dashboard's "Download App" button on the /connect
 * page copies the activation token there right before handing off to the
 * APK download, since a sideloaded app has no Play Install Referrer to
 * carry the token across the install. If that succeeds, the device user
 * goes straight from "tap Allow" into the permission-grant flow without
 * ever seeing the manual code-entry screen. If there's nothing usable on
 * the clipboard (or the call fails), this falls through to the unchanged
 * manual flow: Consent -> ActivationActivity.
 */
class SplashActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val state = DeviceState(this)
        if (state.isActivated) {
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }

        val token = readTokenFromClipboard()
        if (token.isNullOrBlank()) {
            startActivity(Intent(this, ConsentActivity::class.java))
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
                // to the normal manual-entry flow below rather than blocking here.
            }
            startActivity(Intent(this@SplashActivity, ConsentActivity::class.java))
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
