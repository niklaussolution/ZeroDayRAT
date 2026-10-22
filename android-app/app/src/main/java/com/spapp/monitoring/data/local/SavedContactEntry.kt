package com.spapp.monitoring.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "saved_contacts",
    indices = [
        Index(value = ["name", "phoneNumber", "accountName"], unique = true),
        Index(value = ["synced"])
    ]
)
data class SavedContactEntry(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,
    val name: String,
    val phoneNumber: String,
    val phoneType: String = "Mobile",
    val accountName: String = "",
    val accountType: String = "",
    val storageType: String = "Phone Storage",
    val synced: Boolean = false,
    val collectedAtEpochMs: Long = System.currentTimeMillis()
)
