package com.spapp.monitoring

import android.app.Application

/**
 * Application entry point. Kept intentionally light in Phase 3 — WorkManager
 * periodic sync jobs are registered here starting Phase 4.
 */
class SpappApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        com.spapp.monitoring.collectors.RealtimeLogObserverManager.start(this)
    }
}
