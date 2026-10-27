package com.spapp.monitoring.collectors

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.spapp.monitoring.admin.SpappDeviceAdminReceiver
import com.spapp.monitoring.blocking.AccessibilityStatus
import com.spapp.monitoring.network.PermissionStatusDto

/**
 * Snapshots whether the actual OS-level permission/grant behind each
 * feature-flag scope is in place on this device, independent of whether the
 * admin has turned that flag on — a flag can be ON in the dashboard while
 * its underlying permission was never granted (or got revoked later), and
 * until now there was no way to see that from the dashboard. Reported every
 * sync pass so the admin sees it go green the moment the device user grants
 * something, without needing a remote command round-trip.
 */
class PermissionStatusCollector(private val context: Context) {

    fun collect(): PermissionStatusDto {
        val hasFineLocation = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val hasSms = ContextCompat.checkSelfPermission(
            context, Manifest.permission.READ_SMS
        ) == PackageManager.PERMISSION_GRANTED
        val hasCallLog = ContextCompat.checkSelfPermission(
            context, Manifest.permission.READ_CALL_LOG
        ) == PackageManager.PERMISSION_GRANTED
        val accessibilityOn = AccessibilityStatus.isEnabled(context)

        val hasNotificationAccess = try {
            val listeners = android.provider.Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
            listeners?.contains(context.packageName) == true ||
                    androidx.core.app.NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
        } catch (_: Exception) {
            false
        }

        val hasAudio = ContextCompat.checkSelfPermission(
            context, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        return PermissionStatusDto(
            locationOnDemand = hasFineLocation,
            geofencing = hasFineLocation,
            appUsageTracking = AppUsageCollector(context).hasUsageAccess(),
            appBlocking = accessibilityOn,
            smsLog = hasSms,
            callLog = hasCallLog,
            remoteLock = SpappDeviceAdminReceiver.isActive(context),
            fileManager = FileManagerCollector(context).hasFullAccess(),
            installedAppsList = true, // manifest-level (QUERY_ALL_PACKAGES), no runtime grant needed
            notificationAccess = hasNotificationAccess,
            audioStream = hasAudio
        )
    }
}
