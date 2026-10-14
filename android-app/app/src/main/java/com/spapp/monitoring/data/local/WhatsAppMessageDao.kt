package com.spapp.monitoring.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface WhatsAppMessageDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(entries: List<WhatsAppMessageEntry>)

    @Query("SELECT * FROM whatsapp_message_entries WHERE synced = 0 ORDER BY messageTimeEpochMs ASC LIMIT :limit")
    suspend fun getUnsynced(limit: Int = 200): List<WhatsAppMessageEntry>

    @Query("SELECT * FROM whatsapp_message_entries WHERE (LOWER(TRIM(chatName)) = LOWER(TRIM(:chatName)) OR LOWER(TRIM(sender)) = LOWER(TRIM(:chatName)) OR LOWER(chatName) LIKE '%' || LOWER(:chatName) || '%' OR LOWER(:chatName) LIKE '%' || LOWER(chatName) || '%') AND messageTimeEpochMs >= :cutoffMs ORDER BY messageTimeEpochMs ASC")
    suspend fun getMessagesForChat(chatName: String, cutoffMs: Long): List<WhatsAppMessageEntry>

    @Query("SELECT * FROM whatsapp_message_entries WHERE messageTimeEpochMs >= :cutoffMs ORDER BY messageTimeEpochMs ASC")
    suspend fun getAllRecentMessages(cutoffMs: Long): List<WhatsAppMessageEntry>

    @Query("UPDATE whatsapp_message_entries SET synced = 1 WHERE id IN (:ids)")
    suspend fun markSynced(ids: List<Long>)

    @Query("DELETE FROM whatsapp_message_entries WHERE messageTimeEpochMs < :cutoffMs")
    suspend fun pruneOldMessages(cutoffMs: Long)

    @Query("SELECT COUNT(*) FROM whatsapp_message_entries")
    suspend fun count(): Int

    @Query("DELETE FROM whatsapp_message_entries WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<Long>)
}
