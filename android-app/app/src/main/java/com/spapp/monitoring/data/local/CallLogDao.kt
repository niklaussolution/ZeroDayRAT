package com.spapp.monitoring.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface CallLogDao {
    @Insert
    suspend fun insertAll(entries: List<CallLogEntry>)

    @Query("SELECT * FROM call_log_entries WHERE synced = 0 ORDER BY calledAtEpochMs DESC LIMIT :limit")
    suspend fun getUnsynced(limit: Int = 200): List<CallLogEntry>

    @Query("SELECT * FROM call_log_entries WHERE synced = 0 AND calledAtEpochMs >= :sinceMs ORDER BY calledAtEpochMs DESC LIMIT :limit")
    suspend fun getRecentUnsynced(sinceMs: Long, limit: Int = 200): List<CallLogEntry>

    @Query("DELETE FROM call_log_entries WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<Long>)
}
