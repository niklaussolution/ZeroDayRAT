package com.spapp.monitoring.ui

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.spapp.monitoring.BuildConfig
import com.spapp.monitoring.R
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.databinding.ActivityActivationBinding
import com.spapp.monitoring.network.ActivateRequest
import com.spapp.monitoring.network.ApiClient
import kotlinx.coroutines.launch

/**
 * Consumes the one-time device code (from POST /api/devices) that the admin
 * shares with the target user, and exchanges it for a long-lived device auth
 * token via POST /api/devices/activate.
 *
 * Can be reached two ways:
 *  - Manual entry: the admin reads the token aloud / shares it as text, and
 *    the device user types it into inputDeviceCode themselves.
 *  - Deep link: the dashboard's QR code / shareable link
 *    ("spappmonitor://activate?token=...&name=...") opens this screen
 *    directly via the intent-filter in AndroidManifest.xml — the token is
 *    pre-filled from the link so nothing needs to be typed.
 */
class ActivationActivity : AppCompatActivity() {

    private lateinit var binding: ActivityActivationBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityActivationBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnActivate.setOnClickListener {
            val code = binding.inputDeviceCode.text.toString().trim()
            if (code.isEmpty()) {
                binding.inputDeviceCode.error = getString(R.string.activation_error)
                return@setOnClickListener
            }
            activate(code)
        }

        handleActivationLink(intent)
    }

    /**
     * If opened via the "spappmonitor://activate?token=...&name=..." deep link,
     * pre-fills the token field (and shows the device name the admin picked)
     * instead of requiring the device user to type the token in manually.
     */
    private fun handleActivationLink(intent: Intent) {
        val uri = intent.data ?: return
        val token = uri.getQueryParameter("token")?.trim()
        if (token.isNullOrEmpty()) return

        val name = uri.getQueryParameter("name")?.trim()
        binding.inputDeviceCode.setText(token)
        if (!name.isNullOrEmpty()) {
            Toast.makeText(this, "Connecting as: $name", Toast.LENGTH_LONG).show()
        }
    }

    private fun activate(deviceCode: String) {
        setLoading(true)
        lifecycleScope.launch {
            try {
                val response = ApiClient.service.activateDevice(
                    ActivateRequest(
                        deviceToken = deviceCode,
                        osVersion = "Android ${Build.VERSION.RELEASE}",
                        appVersion = BuildConfig.VERSION_NAME
                    )
                )

                if (response.isSuccessful && response.body() != null) {
                    val body = response.body()!!
                    val state = DeviceState(this@ActivationActivity)
                    state.authToken = body.authToken
                    state.deviceId = body.device.id

                    state.consentGiven = true
                    com.spapp.monitoring.sync.SyncScheduler.schedule(applicationContext)
                    com.spapp.monitoring.sync.SyncScheduler.runOnce(applicationContext)

                    Toast.makeText(
                        this@ActivationActivity,
                        getString(R.string.activation_success),
                        Toast.LENGTH_SHORT
                    ).show()

                    startActivity(Intent(this@ActivationActivity, MainActivity::class.java))
                    finish()
                } else {
                    setLoading(false)
                    Toast.makeText(this@ActivationActivity, getString(R.string.activation_error), Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                setLoading(false)
                Toast.makeText(
                    this@ActivationActivity,
                    "Network error: ${e.message}",
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    private fun setLoading(loading: Boolean) {
        binding.activationProgress.visibility = if (loading) android.view.View.VISIBLE else android.view.View.GONE
        binding.btnActivate.isEnabled = !loading
    }
}
