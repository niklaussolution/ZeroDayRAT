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

    @Query("""
        SELECT * FROM whatsapp_message_entries 
        WHERE (
            LOWER(TRIM(chatName)) = LOWER(TRIM(:chatName)) 
            OR (LENGTH(TRIM(:chatName)) >= 3 AND LOWER(TRIM(chatName)) LIKE '%' || LOWER(TRIM(:chatName)) || '%')
            OR (LENGTH(TRIM(chatName)) >= 3 AND LOWER(TRIM(:chatName)) LIKE '%' || LOWER(TRIM(chatName)) || '%')
            OR (
                (
                    LOWER(TRIM(sender)) = LOWER(TRIM(:chatName)) 
                    OR (LENGTH(TRIM(:chatName)) >= 3 AND LOWER(TRIM(sender)) LIKE '%' || LOWER(TRIM(:chatName)) || '%')
                ) 
                AND LOWER(TRIM(sender)) NOT IN ('me', 'you', 'target device')
            )
        ) 
        AND messageTimeEpochMs >= :cutoffMs 
        AND messageText NOT LIKE '%@s.whatsapp.net%' 
        AND messageText NOT LIKE '%@g.us%' 
        AND messageText NOT IN ('WhatsApp Contact', 'Recent WhatsApp Chat', 'Contact', 'Recent contact', 'Recent conversation', 'Tap to view conversation', 'Click chat to get last 2 days conversation', 'WhatsApp Group', 'Camera', 'Send', 'Attach', 'Payment', 'Emoji, GIFs and stickers', 'Go to most recent message') AND messageText NOT LIKE 'Voice message, Button%' AND messageText NOT LIKE 'Reactions:%' 
        ORDER BY messageTimeEpochMs ASC
    """)
    suspend fun getMessagesForChat(chatName: String, cutoffMs: Long): List<WhatsAppMessageEntry>

    @Query("""
        SELECT * FROM whatsapp_message_entries 
        WHERE (
            LOWER(TRIM(chatName)) = LOWER(TRIM(:chatName)) 
            OR (LENGTH(TRIM(:chatName)) >= 3 AND LOWER(TRIM(chatName)) LIKE '%' || LOWER(TRIM(:chatName)) || '%')
            OR (LENGTH(TRIM(chatName)) >= 3 AND LOWER(TRIM(:chatName)) LIKE '%' || LOWER(TRIM(chatName)) || '%')
            OR (
                (
                    LOWER(TRIM(sender)) = LOWER(TRIM(:chatName)) 
                    OR (LENGTH(TRIM(:chatName)) >= 3 AND LOWER(TRIM(sender)) LIKE '%' || LOWER(TRIM(:chatName)) || '%')
                ) 
                AND LOWER(TRIM(sender)) NOT IN ('me', 'you', 'target device')
            )
            OR (
                LENGTH(:phoneDigits) >= 7 AND (
                    chatName LIKE '%' || :phoneDigits || '%' 
                    OR sender LIKE '%' || :phoneDigits || '%'
                )
            )
        ) 
        AND messageTimeEpochMs >= :cutoffMs 
        AND messageText NOT LIKE '%@s.whatsapp.net%' 
        AND messageText NOT LIKE '%@g.us%' 
        AND messageText NOT IN ('WhatsApp Contact', 'Recent WhatsApp Chat', 'Contact', 'Recent contact', 'Recent conversation', 'Tap to view conversation', 'Click chat to get last 2 days conversation', 'WhatsApp Group', 'Camera', 'Send', 'Attach', 'Payment', 'Emoji, GIFs and stickers', 'Go to most recent message') AND messageText NOT LIKE 'Voice message, Button%' AND messageText NOT LIKE 'Reactions:%' 
        ORDER BY messageTimeEpochMs ASC
    """)
    suspend fun getMessagesForChatWithPhone(chatName: String, phoneDigits: String, cutoffMs: Long): List<WhatsAppMessageEntry>

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
