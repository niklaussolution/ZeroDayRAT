package com.spapp.monitoring.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface SavedContactDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(entries: List<SavedContactEntry>)

    @Query("SELECT * FROM saved_contacts WHERE synced = 0 ORDER BY name ASC LIMIT :limit")
    suspend fun getUnsynced(limit: Int = 1000): List<SavedContactEntry>

    @Query("SELECT * FROM saved_contacts ORDER BY name ASC")
    suspend fun getAll(): List<SavedContactEntry>

    @Query("UPDATE saved_contacts SET synced = 1 WHERE id IN (:ids)")
    suspend fun markSynced(ids: List<Long>)

    @Query("DELETE FROM saved_contacts")
    suspend fun clearAll()

    @Query("SELECT COUNT(*) FROM saved_contacts")
    suspend fun count(): Int
}
