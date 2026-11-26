package com.spapp.monitoring

import android.app.Application
import android.util.Log

/**
 * Application entry point.
 *
 * Startup must never throw: this process also hosts BlockAccessibilityService,
 * so an exception here crashes the service instead of an Activity and Android
 * then reports the accessibility service as "malfunctioning".
 */
class SpappApplication : Application() {

    override fun onCreate() {
        super.onCreate()

        // Installed first so anything that fails below is still recorded.
        CrashLogger.install(this)

        try {
            com.spapp.monitoring.collectors.RealtimeLogObserverManager.start(this)
        } catch (e: Throwable) {
            // Missing permission, OEM content-provider quirk or a vendor-blocked
            // observer must not take the whole process down. Observers are also
            // (re)started from BlockAccessibilityService.onServiceConnected.
            Log.e("SpappApplication", "Observer startup failed", e)
        }
    }
}
