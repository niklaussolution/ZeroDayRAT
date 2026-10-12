package com.spapp.monitoring.ui

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.format.DateUtils
import android.util.Log
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.messaging.FirebaseMessaging
import com.spapp.monitoring.R
import com.spapp.monitoring.admin.SpappDeviceAdminReceiver
import com.spapp.monitoring.blocking.AccessibilityStatus
import com.spapp.monitoring.collectors.AppUsageCollector
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.databinding.ActivityMainBinding
import com.spapp.monitoring.fcm.FcmTokenSync
import com.spapp.monitoring.geofence.GeofenceManager
import com.spapp.monitoring.sync.SyncScheduler

/**
 * Status screen shown after the device is activated. Kicks off the periodic
 * background sync (Phase 4/5) and offers the special-access grants that
 * can't be requested as part of the initial consent-flow permission batch:
 * Usage Access and Background Location (see Phase 3/5), plus Device Admin
 * activation for Remote Lock (Phase 6) — all of these require their own
 * explicit system dialog, never silent.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var usageCollector: AppUsageCollector
    private lateinit var geofenceManager: GeofenceManager

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { refreshPermissionButtons() }

    private val backgroundLocationLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { refreshPermissionButtons() }

    private val deviceAdminLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { refreshPermissionButtons() }

    private val batteryExemptionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { refreshPermissionButtons() }

    private val contactsPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { refreshPermissionButtons() }

    private val statusHandler = Handler(Looper.getMainLooper())
    private val statusUpdater = object : Runnable {
        override fun run() {
            updateSyncStatusText()
            statusHandler.postDelayed(this, STATUS_REFRESH_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        usageCollector = AppUsageCollector(this)
        geofenceManager = GeofenceManager(this)

        SyncScheduler.schedule(applicationContext)
        uploadCurrentFcmToken()
        com.spapp.monitoring.collectors.RealtimeLogObserverManager.start(applicationContext)

        binding.btnGrantCameraPermission.setOnClickListener {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }

        binding.btnGrantUsageAccess.setOnClickListener {
            startActivity(usageCollector.usageAccessSettingsIntent())
        }

        binding.btnGrantBackgroundLocation.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                backgroundLocationLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            }
        }

        binding.btnEnableRemoteLock.setOnClickListener {
            deviceAdminLauncher.launch(SpappDeviceAdminReceiver.activationIntent(this))
        }

        binding.btnEnableAccessibility.setOnClickListener {
            androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle(R.string.accessibility_dialog_title)
                .setMessage(R.string.accessibility_dialog_message)
                .setPositiveButton(R.string.go_to_settings) { _, _ ->
                    try {
                        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    } catch (e: Exception) {
                        Log.e(TAG, "Cannot open accessibility settings", e)
                    }
                }
                .setNeutralButton(R.string.open_app_info) { _, _ ->
                    openAppInfoSettings()
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }

        binding.btnOpenAppInfo.setOnClickListener {
            openAppInfoSettings()
        }

        binding.btnEnableAppBlocking.setOnClickListener {
            binding.btnEnableAccessibility.performClick()
        }

        binding.btnGrantFileAccess.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            }
        }

        binding.btnGrantBatteryExemption.setOnClickListener {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            batteryExemptionLauncher.launch(intent)
        }

        binding.btnGrantAutostart.setOnClickListener {
            openAutostartSettings()
        }

        // Kept available in every build, not just debug — on OEM ROMs (MIUI in
        // particular) the periodic WorkManager schedule and FCM pushes are both
        // unreliable in the background even with battery exemption granted, so
        // the admin/user needs a manual way to force an immediate sync.
        binding.btnSyncNow.setOnClickListener {
            com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext)
            SyncScheduler.runOnce(applicationContext)
        }
    }

    /**
     * MIUI (and several other OEM ROMs) silently kill WorkManager jobs in the
     * background unless the app is also allowlisted in the vendor's own
     * "Autostart"/"Auto-launch" screen — there is no standard Android API for
     * this, only vendor-specific activities that may not exist on a given ROM
     * build, so every attempt is wrapped and falls back to the generic
     * app-info screen instead of crashing or doing nothing.
     */
    private fun openAutostartSettings() {
        val candidates = listOf(
            Intent().setComponent(
                ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
            ),
            Intent().setComponent(
                ComponentName("com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity")
            ),
            Intent().setComponent(
                ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity")
            ),
            Intent().setComponent(
                ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")
            ),
            Intent().setComponent(
                ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")
            ),
        )
        for (intent in candidates) {
            try {
                startActivity(intent)
                return
            } catch (e: Exception) {
                // Not this OEM/ROM — try the next, then fall back below.
            }
        }
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            Log.e(TAG, "No autostart or app-info settings screen available", e)
        }
    }

    override fun onResume() {
        super.onResume()
        if (androidx.core.content.ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.READ_CONTACTS
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            contactsPermissionLauncher.launch(Manifest.permission.READ_CONTACTS)
        }
        refreshPermissionButtons()
        statusUpdater.run()
        uploadCurrentFcmToken()
    }

    override fun onPause() {
        super.onPause()
        statusHandler.removeCallbacks(statusUpdater)
    }

    /**
     * No persistent notification by design — this on-screen text is the only
     * visible sign that background sync is happening, so it has to actually
     * reflect reality (last successful SyncRunner pass), not just a static
     * "active" label.
     */
    private fun updateSyncStatusText() {
        val lastSync = DeviceState(this).lastSyncAtEpochMs
        binding.statusText.text = if (lastSync == 0L) {
            getString(R.string.sync_status_never)
        } else {
            val relative = DateUtils.getRelativeTimeSpanString(
                lastSync, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS
            )
            getString(R.string.sync_status_last_synced, relative)
        }
    }

    private fun uploadCurrentFcmToken() {
        // Previously had no failure handling or logging at all — if Play
        // Services wasn't ready yet (common on first launch, and on some
        // OEM ROMs like MIUI where Play Services init is delayed/throttled),
        // this failed completely silently and the device never got an FCM
        // token registered, permanently falling back to poll-only delivery.
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token ->
                Log.d(TAG, "FCM token fetched: $token")
                FcmTokenSync.enqueueUpload(applicationContext, token)
            }
            .addOnFailureListener { e ->
                Log.e(TAG, "FCM token fetch failed", e)
            }
    }

    companion object {
        private const val TAG = "MainActivity"
        private const val STATUS_REFRESH_MS = 30_000L
    }

    private fun openAppInfoSettings() {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        } catch (e: Exception) {
            Log.e(TAG, "No app-info settings screen available", e)
        }
    }

    private fun refreshPermissionButtons() {
        // Accessibility Service Status
        val isSettingEnabled = AccessibilityStatus.isEnabled(this)
        val isServiceRunning = com.spapp.monitoring.blocking.BlockAccessibilityService.instance != null
        val isAccessibilityActive = isSettingEnabled && isServiceRunning

        if (isAccessibilityActive) {
            binding.tvAccessibilityBadge.text = "ACTIVE ✓"
            binding.tvAccessibilityBadge.setTextColor(androidx.core.content.ContextCompat.getColor(this, R.color.success))
            binding.tvAccessibilityBadge.setBackgroundColor(androidx.core.content.ContextCompat.getColor(this, R.color.success_bg))
            binding.tvAccessibilityDesc.text = "Accessibility Service is active and monitoring."
            binding.btnEnableAccessibility.text = "Accessibility Active (Tap to re-check)"
            binding.btnEnableAccessibility.setBackgroundColor(androidx.core.content.ContextCompat.getColor(this, R.color.primary))
            binding.btnOpenAppInfo.visibility = android.view.View.GONE
        } else {
            binding.tvAccessibilityBadge.text = "NOT ENABLED ✕"
            binding.tvAccessibilityBadge.setTextColor(androidx.core.content.ContextCompat.getColor(this, R.color.danger))
            binding.tvAccessibilityBadge.setBackgroundColor(androidx.core.content.ContextCompat.getColor(this, R.color.danger_bg))
            binding.tvAccessibilityDesc.text = getString(R.string.accessibility_card_desc)
            binding.btnEnableAccessibility.text = getString(R.string.enable_accessibility)
            binding.btnEnableAccessibility.setBackgroundColor(androidx.core.content.ContextCompat.getColor(this, R.color.accent))
            binding.btnOpenAppInfo.visibility = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) android.view.View.VISIBLE else android.view.View.GONE
        }

        val hasCameraPermission = androidx.core.content.ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
        binding.btnGrantCameraPermission.visibility =
            if (hasCameraPermission) android.view.View.GONE else android.view.View.VISIBLE

        binding.btnGrantUsageAccess.visibility =
            if (usageCollector.hasUsageAccess()) android.view.View.GONE else android.view.View.VISIBLE

        // Only relevant on Android 10+; below that, fine location alone covers geofencing.
        val needsBackgroundLocation = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !geofenceManager.hasPermission()
        binding.btnGrantBackgroundLocation.visibility =
            if (needsBackgroundLocation) android.view.View.VISIBLE else android.view.View.GONE

        binding.btnEnableRemoteLock.visibility =
            if (SpappDeviceAdminReceiver.isActive(this)) android.view.View.GONE else android.view.View.VISIBLE

        val hasFullFileAccess = Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()
        binding.btnGrantFileAccess.visibility =
            if (hasFullFileAccess) android.view.View.GONE else android.view.View.VISIBLE

        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        val hasBatteryExemption = powerManager.isIgnoringBatteryOptimizations(packageName)
        binding.btnGrantBatteryExemption.visibility =
            if (hasBatteryExemption) android.view.View.GONE else android.view.View.VISIBLE

        // No public API to check autostart allowlist status on any OEM, so this
        // stays visible whenever battery exemption also still needs granting —
        // on MIUI the two are usually set together during initial setup.
        binding.btnGrantAutostart.visibility =
            if (hasBatteryExemption) android.view.View.GONE else android.view.View.VISIBLE

        val anyOtherNeeded = !hasCameraPermission ||
                !usageCollector.hasUsageAccess() ||
                needsBackgroundLocation ||
                !SpappDeviceAdminReceiver.isActive(this) ||
                !hasFullFileAccess ||
                !hasBatteryExemption
        binding.tvOtherPermissionsHeader.visibility =
            if (anyOtherNeeded) android.view.View.VISIBLE else android.view.View.GONE
    }
}
