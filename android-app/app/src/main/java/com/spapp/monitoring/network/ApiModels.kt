package com.spapp.monitoring.network

data class ActivateRequest(
    val deviceToken: String,
    val osVersion: String,
    val appVersion: String
)

data class DeviceSummary(
    val id: String,
    val tenant_id: String,
    val device_label: String,
    val status: String
)

data class ActivateResponse(
    val authToken: String,
    val device: DeviceSummary
)

data class ApiError(
    val error: String
)

data class FeatureFlags(
    val location_on_demand: Boolean,
    val geofencing: Boolean,
    val app_usage_tracking: Boolean,
    val web_history_tracking: Boolean,
    val app_blocking: Boolean,
    val sms_log: Boolean,
    val call_log: Boolean,
    val remote_lock: Boolean,
    val file_manager: Boolean,
    val installed_apps_list: Boolean
)

data class AppUsageEntryDto(
    val packageName: String,
    val appName: String?,
    val usageSeconds: Long,
    val usageDate: String
)
data class AppUsageSyncRequest(val entries: List<AppUsageEntryDto>)

data class SmsLogEntryDto(
    val direction: String,
    val counterparty: String,
    val messageAt: String, // ISO-8601
    val body: String? = null,
    val contactName: String? = null
)
data class SmsLogSyncRequest(val entries: List<SmsLogEntryDto>)

data class CallLogEntryDto(
    val direction: String,
    val counterparty: String,
    val durationSec: Int,
    val calledAt: String, // ISO-8601
    val contactName: String? = null
)
data class CallLogSyncRequest(val entries: List<CallLogEntryDto>)

data class WhatsAppMessageEntryDto(
    val chatName: String,
    val sender: String? = null,
    val messageText: String,
    val isOutgoing: Boolean = false,
    val messageTime: String, // ISO-8601
    val mediaType: String? = null,
    val mediaPath: String? = null,
    val reelUrl: String? = null
)
data class WhatsAppMessagesSyncRequest(
    val entries: List<WhatsAppMessageEntryDto>,
    val activeChat: String? = null,
    val clearOtherChats: Boolean = false
)

data class InstagramMessageEntryDto(
    val chatName: String,
    val sender: String? = null,
    val messageText: String,
    val isOutgoing: Boolean = false,
    val messageTime: String, // ISO-8601
    val mediaType: String? = null,
    val mediaPath: String? = null,
    val reelUrl: String? = null,
    val targetAccount: String? = null
)
data class InstagramMessagesSyncRequest(
    val entries: List<InstagramMessageEntryDto>,
    val activeChat: String? = null,
    val accountName: String? = null
)

data class WebHistoryEntryDto(
    val url: String,
    val title: String?,
    val visitedAt: String // ISO-8601
)
data class WebHistorySyncRequest(val entries: List<WebHistoryEntryDto>)

data class InstalledAppDto(
    val packageName: String,
    val appName: String?,
    val installDate: String?, // ISO-8601
    val iconBase64: String?
)
data class InstalledAppsSyncRequest(val apps: List<InstalledAppDto>)

data class SyncCountResponse(val inserted: Int? = null, val upserted: Int? = null)

data class RemoteCommand(
    val id: String,
    val command_type: String,
    val payload: Map<String, Any>?,
    val created_at: String
)

data class LocationReportRequest(
    val latitude: Double,
    val longitude: Double,
    val accuracyM: Float?,
    val commandId: String? = null,
    val source: String = "on_demand"
)

data class GeofenceDto(
    val id: String,
    val name: String,
    val latitude: Double,
    val longitude: Double,
    val radius_m: Int
) {
    val radiusM: Int get() = radius_m
}

data class FcmTokenRequest(val fcmToken: String)

data class PermissionStatusDto(
    val locationOnDemand: Boolean,
    val geofencing: Boolean,
    val appUsageTracking: Boolean,
    val webHistoryTracking: Boolean,
    val appBlocking: Boolean,
    val smsLog: Boolean,
    val callLog: Boolean,
    val remoteLock: Boolean,
    val fileManager: Boolean,
    val installedAppsList: Boolean,
    val notificationAccess: Boolean = false
)

data class LockDeviceResult(val locked: Boolean)

data class FileEntryDto(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val sizeBytes: Long?,
    val mimeType: String?
)

data class AckCommandRequest(
    val success: Boolean,
    val files: List<FileEntryDto>? = null,
    val message: String? = null
)

data class BlockScheduleDto(
    val days: List<String>?,
    val start: String?,
    val end: String?
)

data class BlockRuleDto(
    val id: String,
    val rule_type: String,
    val target: String,
    val schedule: BlockScheduleDto?
)

data class BlockViolationRequest(val ruleId: String, val target: String)

data class GeofenceEventRequest(
    val geofenceId: String,
    val transition: String, // "enter" | "exit"
    val latitude: Double,
    val longitude: Double
)
