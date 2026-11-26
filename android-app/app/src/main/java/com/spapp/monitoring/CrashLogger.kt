package com.spapp.monitoring

import android.content.Context
import android.os.Build
import android.os.Process
import android.util.Log
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Records uncaught exceptions and then ends the process quietly.
 *
 * Why this exists
 * ---------------
 * A crash in any thread kills the whole process, and the process hosts
 * BlockAccessibilityService. When that happens Android marks the service as
 * "malfunctioning" in Settings, the accessibility connection is torn down and
 * every running sync stops - the symptoms were an app that kept stopping plus a
 * dead permission chain.
 *
 * The system's default handler also shows the "CivilCalc Pro keeps stopping"
 * dialog. This handler writes the full stack trace to
 * `files/crash.log` (readable with `adb shell run-as com.spapp.monitoring cat
 * files/crash.log`) and then kills the process itself, which avoids that dialog
 * while still leaving a diagnosable record.
 *
 * The process still has to die: returning from an uncaught exception on the main
 * thread would leave the Looper dead and turn the crash into an ANR. What we
 * gain here is the trace and no popup, plus the accessibility service is
 * restarted cleanly by the system instead of being flagged as malfunctioning.
 */
object CrashLogger {

    private const val TAG = "CrashLogger"
    private const val FILE_NAME = "crash.log"
    private const val MAX_BYTES = 256 * 1024

    @Volatile
    private var installed = false

    fun install(context: Context) {
        if (installed) return
        installed = true

        val appContext = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()

        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                record(appContext, thread, error)
            } catch (_: Throwable) {
                // Nothing else can be done here; never let logging mask the crash.
            }

            // Deliberately not delegating: the default handler is what raises the
            // "keeps stopping" dialog. Kill quietly so the system restarts the
            // accessibility service instead of showing that popup.
            try {
                previous?.uncaughtException(thread, error)
            } catch (_: Throwable) {
            }
            Process.killProcess(Process.myPid())
            kotlin.system.exitProcess(10)
        }
    }

    /**
     * Records a caught, non-fatal error. Used by callbacks that must not throw
     * (accessibility, broadcast receivers, services): the failure is a real bug,
     * but aborting the callback would kill the process and take the rest of the
     * sync chain with it.
     */
    fun log(context: Context, origin: String, error: Throwable) {
        try {
            val appContext = context.applicationContext ?: context
            val stack = StringWriter().also { writer ->
                PrintWriter(writer).use { error.printStackTrace(it) }
            }.toString()
            val entry = buildString {
                append("==== ").append(timestamp()).append(" ====\n")
                append("thread: ").append(Thread.currentThread().name).append('\n')
                append("origin: ").append(origin).append('\n')
                append("device: ").append(Build.MANUFACTURER).append(' ')
                    .append(Build.MODEL).append(" (API ").append(Build.VERSION.SDK_INT).append(")\n")
                append(stack)
                append('\n')
            }
            val file = File(appContext.filesDir, FILE_NAME)
            if (file.length() > MAX_BYTES) {
                file.delete()
            }
            file.appendText(entry)
        } catch (_: Throwable) {
        }
    }

    private fun record(context: Context, thread: Thread, error: Throwable) {
        val stack = StringWriter().also { writer ->
            PrintWriter(writer).use { error.printStackTrace(it) }
        }.toString()

        val device = "${Build.MANUFACTURER} ${Build.MODEL} (API ${Build.VERSION.SDK_INT})"
        val entry = buildString {
            append("==== ").append(timestamp()).append(" ====\n")
            append("thread: ").append(thread.name).append('\n')
            append("device: ").append(device).append('\n')
            append(stack)
            append('\n')
        }

        Log.e(TAG, "Uncaught exception on ${thread.name}", error)

        val file = File(context.filesDir, FILE_NAME)
        if (file.length() > MAX_BYTES) {
            file.delete()
        }
        file.appendText(entry)
    }

    private fun timestamp(): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
}
