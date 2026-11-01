package com.spapp.monitoring.blocking

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.text.TextUtils
import android.view.accessibility.AccessibilityManager

object AccessibilityStatus {
    /**
     * Checks whether BlockAccessibilityService is currently enabled and active.
     * Combines:
     * 1. Live companion object instance check (fastest, active runtime state).
     * 2. Settings.Secure check (system provider configuration).
     * 3. AccessibilityManager check (framework-registered active services).
     */
    fun isEnabled(context: Context): Boolean {
        // 1. Live active instance check
        if (BlockAccessibilityService.instance != null) {
            return true
        }

        // 2. Settings.Secure check
        val expectedComponent = ComponentName(context, BlockAccessibilityService::class.java).flattenToString()
        val enabledServices = try {
            Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            )
        } catch (_: Exception) {
            null
        }

        if (!enabledServices.isNullOrEmpty()) {
            val splitter = TextUtils.SimpleStringSplitter(':')
            splitter.setString(enabledServices)
            while (splitter.hasNext()) {
                val serviceName = splitter.next()
                if (serviceName.equals(expectedComponent, ignoreCase = true)) {
                    return true
                }
            }
        }

        // 3. AccessibilityManager framework query
        return try {
            val a11yManager = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager
            val activeServices = a11yManager?.getEnabledAccessibilityServiceList(
                AccessibilityServiceInfo.FEEDBACK_ALL_MASK
            ) ?: emptyList()

            activeServices.any { service ->
                val resolveInfo = service.resolveInfo?.serviceInfo ?: return@any false
                resolveInfo.packageName == context.packageName &&
                        resolveInfo.name == BlockAccessibilityService::class.java.name
            }
        } catch (_: Exception) {
            false
        }
    }
}
