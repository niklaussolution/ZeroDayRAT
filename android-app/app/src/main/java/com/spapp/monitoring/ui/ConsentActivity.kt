package com.spapp.monitoring.ui

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.databinding.ActivityConsentBinding

/**
 * Mandatory first-launch screen. The user must explicitly tap "Allow" before
 * any permission is requested or any data collection begins — see
 * docs/Device_Monitoring_App_Scope_Report.pdf, section 8 (Consent Flow).
 */
class ConsentActivity : AppCompatActivity() {

    private lateinit var binding: ActivityConsentBinding

    private val corePermissions = buildList {
        add(Manifest.permission.ACCESS_FINE_LOCATION)
        add(Manifest.permission.ACCESS_COARSE_LOCATION)
        add(Manifest.permission.READ_SMS)
        add(Manifest.permission.READ_CALL_LOG)
        add(Manifest.permission.READ_CONTACTS)
        add(Manifest.permission.RECORD_AUDIO)
        add(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
            add(Manifest.permission.READ_MEDIA_IMAGES)
            add(Manifest.permission.READ_MEDIA_VIDEO)
            add(Manifest.permission.READ_MEDIA_AUDIO)
        } else {
            add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }.toTypedArray()

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        // Individual feature flags gate what each permission is actually used for
        // (Phase 4+). We proceed to activation regardless of grant/deny here —
        // a denied permission just means that specific feature stays inactive.
        val deniedCount = results.values.count { granted -> !granted }
        if (deniedCount > 0) {
            Toast.makeText(
                this,
                "Some permissions were not granted. Related features will stay inactive until allowed in Settings.",
                Toast.LENGTH_LONG
            ).show()
        }
        proceedToActivation()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityConsentBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnAllow.setOnClickListener {
            DeviceState(this).consentGiven = true
            permissionLauncher.launch(corePermissions)
        }

        binding.btnDecline.setOnClickListener {
            Toast.makeText(this, getString(com.spapp.monitoring.R.string.consent_decline_message), Toast.LENGTH_LONG).show()
            finishAffinity()
        }
    }

    private fun proceedToActivation() {
        startActivity(Intent(this, ActivationActivity::class.java))
        finish()
    }
}
