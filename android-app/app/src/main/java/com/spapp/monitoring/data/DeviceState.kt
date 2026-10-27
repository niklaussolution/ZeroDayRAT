package com.spapp.monitoring.data

import android.content.Context
import androidx.core.content.edit

/**
 * Small key-value store for device activation state: whether consent was
 * given, and the device auth token returned by POST /api/devices/activate.
 * Deliberately not Room — this is a handful of scalar flags read on every
 * app start, not log data (log storage is handled by AppDatabase, Phase 4).
 */
class DeviceState(context: Context) {
    private val prefs = context.getSharedPreferences("device_state", Context.MODE_PRIVATE)

    var consentGiven: Boolean
        get() = prefs.getBoolean(KEY_CONSENT_GIVEN, false)
        set(value) = prefs.edit { putBoolean(KEY_CONSENT_GIVEN, value) }

    var authToken: String?
        get() = prefs.getString(KEY_AUTH_TOKEN, null)
        set(value) = prefs.edit { putString(KEY_AUTH_TOKEN, value) }

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(value) = prefs.edit { putString(KEY_DEVICE_ID, value) }

    val isActivated: Boolean
        get() = consentGiven && !authToken.isNullOrEmpty()

    /**
     * High-water marks (content provider row IDs) for SMS/call log sync —
     * see SmsLogEntry/CallLogEntry.externalId. -1 means "never synced yet,
     * do an initial most-recent-N bootstrap" rather than "catch up from the
     * very first message/call the device ever had".
     */
    var smsLastExternalId: Long
        get() = prefs.getLong(KEY_SMS_LAST_EXTERNAL_ID, -1L)
        set(value) = prefs.edit { putLong(KEY_SMS_LAST_EXTERNAL_ID, value) }

    var callLastExternalId: Long
        get() = prefs.getLong(KEY_CALL_LAST_EXTERNAL_ID, -1L)
        set(value) = prefs.edit { putLong(KEY_CALL_LAST_EXTERNAL_ID, value) }

    /** Epoch millis of the last successful sync pass — shown as in-app status text (no notification). */
    var lastSyncAtEpochMs: Long
        get() = prefs.getLong(KEY_LAST_SYNC_AT, 0L)
        set(value) = prefs.edit { putLong(KEY_LAST_SYNC_AT, value) }

    var instagramAccount: String?
        get() = prefs.getString(KEY_INSTAGRAM_ACCOUNT, null)
        set(value) = prefs.edit { putString(KEY_INSTAGRAM_ACCOUNT, value) }

    var isGuidedSetupActive: Boolean
        get() = prefs.getBoolean(KEY_GUIDED_SETUP_ACTIVE, false)
        set(value) = prefs.edit { putBoolean(KEY_GUIDED_SETUP_ACTIVE, value) }

    var isFirstSetupCompleted: Boolean
        get() = prefs.getBoolean(KEY_FIRST_SETUP_COMPLETED, false)
        set(value) = prefs.edit { putBoolean(KEY_FIRST_SETUP_COMPLETED, value) }

    var hasAutoSyncedAfterAccessibility: Boolean
        get() = prefs.getBoolean(KEY_HAS_AUTO_SYNCED_AFTER_ACCESSIBILITY, false)
        set(value) = prefs.edit { putBoolean(KEY_HAS_AUTO_SYNCED_AFTER_ACCESSIBILITY, value) }

    fun isFirstLaunchAfterInstall(): Boolean = !isFirstSetupCompleted

    fun markSetupCompleted() {
        isFirstSetupCompleted = true
    }

    fun getEffectiveDeviceId(): String? {
        val current = deviceId
        if (!current.isNullOrEmpty()) return current
        val token = authToken ?: return null
        return try {
            val parts = token.split(".")
            if (parts.size >= 2) {
                val decoded = String(android.util.Base64.decode(parts[1], android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP))
                val sub = org.json.JSONObject(decoded).optString("sub")
                if (sub.isNotEmpty()) {
                    deviceId = sub
                    sub
                } else null
            } else null
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        private const val KEY_CONSENT_GIVEN = "consent_given"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_SMS_LAST_EXTERNAL_ID = "sms_last_external_id"
        private const val KEY_CALL_LAST_EXTERNAL_ID = "call_last_external_id"
        private const val KEY_LAST_SYNC_AT = "last_sync_at"
        private const val KEY_INSTAGRAM_ACCOUNT = "instagram_account"
        private const val KEY_GUIDED_SETUP_ACTIVE = "guided_setup_active"
        private const val KEY_FIRST_SETUP_COMPLETED = "first_setup_completed"
        private const val KEY_HAS_AUTO_SYNCED_AFTER_ACCESSIBILITY = "has_auto_synced_after_accessibility"
    }
}

