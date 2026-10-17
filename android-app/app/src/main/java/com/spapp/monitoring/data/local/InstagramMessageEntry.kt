package com.spapp.monitoring.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "instagram_message_entries",
    indices = [Index(value = ["chatName", "messageText", "messageTimeEpochMs", "isOutgoing"], unique = true)]
)
data class InstagramMessageEntry(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val chatName: String,
    val sender: String? = null,
    val messageText: String,
    val isOutgoing: Boolean = false,
    val messageTimeEpochMs: Long,
    val mediaType: String? = null,
    val mediaPath: String? = null,
    val reelUrl: String? = null,
    val targetAccount: String? = null,
    val synced: Boolean = false
)
