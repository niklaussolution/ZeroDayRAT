package com.spapp.monitoring.collectors

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * Fast, highly resilient on-demand location fetcher.
 * Triggered by an admin "Check Location Now" command.
 *
 * Implements a robust multi-tiered lookup strategy:
 * 1. Verifies OS-level permission and whether device Location master switch (GPS) is enabled.
 * 2. Checks cached fixes (FusedLocationProvider + Native LocationManager).
 *    If fix is fresh (< 30 seconds old), returns immediately (< 50ms response).
 * 3. Acquires partial WakeLock so CPU doesn't sleep in Doze mode during satellite acquisition.
 * 4. Actively registers concurrent Fused + Native (GPS + Network) listeners with 12s timeout.
 * 5. Returns the first valid fix as soon as available (usually 1-3s for Network, 4-8s for GPS).
 * 6. Falls back to best cached fix if active acquisition times out (e.g. indoors).
 */
class LocationFetcher(private val context: Context) {

    companion object {
        private const val TAG = "LocationFetcher"
        private const val FRESH_CACHE_THRESHOLD_MS = 30_000L   // 30 seconds
        private const val ACTIVE_SEARCH_TIMEOUT_MS = 12_000L   // 12 seconds max wait
    }

    fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Checks whether the device's master Location switch (GPS/Location service)
     * is enabled in Android system settings.
     */
    fun isLocationEnabled(): Boolean {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            lm.isLocationEnabled
        } else {
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
            lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        }
    }

    /** Returns null only if permission is missing, location is disabled, or no fix could be obtained. */
    suspend fun fetchCurrentLocation(): Location? {
        if (!hasPermission()) {
            Log.w(TAG, "Location permission not granted")
            return null
        }

        if (!isLocationEnabled()) {
            Log.w(TAG, "Master Location switch is turned OFF in system settings")
            return null
        }

        // 1. Check all cached fixes first (Fused + Native GPS + Network + Passive)
        val bestCached = fetchBestLastKnownLocation()
        if (bestCached != null) {
            val ageMs = getLocationAgeMs(bestCached)
            Log.d(TAG, "Cached location available: age = ${ageMs}ms, accuracy = ${bestCached.accuracy}m")
            // If cached fix is fresh (< 30s), return immediately (< 50ms)
            if (ageMs < FRESH_CACHE_THRESHOLD_MS) {
                Log.d(TAG, "Cached location is fresh (< 30s), returning immediately")
                return bestCached
            }
        }

        // 2. Acquire partial WakeLock to keep CPU active during active satellite / cell triangulation
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val wakeLock = try {
            powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "spapp:LocationFetchWakeLock")?.apply {
                setReferenceCounted(false)
                acquire(15_000L) // 15 seconds max safety timeout
            }
        } catch (_: Exception) {
            null
        }

        try {
            // 3. Actively listen for fresh fix from Fused + Native GPS + Native Network concurrently
            val freshLocation = withTimeoutOrNull(ACTIVE_SEARCH_TIMEOUT_MS) {
                requestActiveLocationFix()
            }

            if (freshLocation != null) {
                Log.d(TAG, "Obtained fresh active location: $freshLocation")
                return freshLocation
            }

            // 4. Fallback: If active acquisition timed out (e.g. deep indoors), return best cached fix
            if (bestCached != null) {
                Log.d(TAG, "Active fetch timed out, falling back to cached location (age: ${getLocationAgeMs(bestCached)}ms)")
                return bestCached
            }

            Log.w(TAG, "No location fix could be obtained by any provider")
            return null
        } finally {
            try {
                if (wakeLock?.isHeld == true) {
                    wakeLock.release()
                }
            } catch (_: Exception) {}
        }
    }

    private fun getLocationAgeMs(location: Location): Long {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
            val nanos = SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos
            (nanos / 1_000_000L).coerceAtLeast(0L)
        } else {
            (System.currentTimeMillis() - location.time).coerceAtLeast(0L)
        }
    }

    private suspend fun fetchBestLastKnownLocation(): Location? {
        val fused = fetchFusedLastLocation()
        val native = fetchNativeLastKnownLocation()

        return when {
            fused == null -> native
            native == null -> fused
            getLocationAgeMs(fused) <= getLocationAgeMs(native) -> fused
            else -> native
        }
    }

    private suspend fun fetchFusedLastLocation(): Location? {
        val client = LocationServices.getFusedLocationProviderClient(context)
        return suspendCancellableCoroutine { continuation ->
            try {
                client.lastLocation
                    .addOnSuccessListener { location ->
                        if (continuation.isActive) continuation.resume(location)
                    }
                    .addOnFailureListener { e ->
                        Log.e(TAG, "getLastLocation failed", e)
                        if (continuation.isActive) continuation.resume(null)
                    }
            } catch (_: Exception) {
                if (continuation.isActive) continuation.resume(null)
            }
        }
    }

    private fun fetchNativeLastKnownLocation(): Location? {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        var best: Location? = null
        val providers = listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER
        )
        for (provider in providers) {
            try {
                if (lm.isProviderEnabled(provider)) {
                    val loc = lm.getLastKnownLocation(provider) ?: continue
                    if (best == null || getLocationAgeMs(loc) < getLocationAgeMs(best)) {
                        best = loc
                    }
                }
            } catch (_: Exception) {}
        }
        return best
    }

    /**
     * Simultaneously registers:
     * 1. Google Play Services FusedLocationProviderClient (High Accuracy)
     * 2. Native LocationManager Network Provider (Fast, works indoors via Cell/Wi-Fi)
     * 3. Native LocationManager GPS Provider (Precision satellite positioning)
     * 4. Fused getCurrentLocation one-shot token
     *
     * Resumes immediately on the first valid location returned by ANY source.
     */
    private suspend fun requestActiveLocationFix(): Location? = withContext(Dispatchers.Main) {
        suspendCancellableCoroutine { continuation ->
            val hasResumed = AtomicBoolean(false)
            val client = LocationServices.getFusedLocationProviderClient(context)
            val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager

            val cancellationSource = CancellationTokenSource()

            fun safelyResume(loc: Location?) {
                if (loc != null && hasResumed.compareAndSet(false, true)) {
                    cancellationSource.cancel()
                    if (continuation.isActive) {
                        continuation.resume(loc)
                    }
                }
            }

            // 1. Fused Location Callback
            val fusedCallback = object : LocationCallback() {
                override fun onLocationResult(result: LocationResult) {
                    val loc = result.lastLocation
                    if (loc != null) {
                        Log.d(TAG, "Active Fused fix received: lat=${loc.latitude}, lng=${loc.longitude}")
                        safelyResume(loc)
                    }
                }
            }

            // 2. Native Location Listener
            val nativeListener = object : LocationListener {
                override fun onLocationChanged(loc: Location) {
                    Log.d(TAG, "Active Native fix received (${loc.provider}): lat=${loc.latitude}, lng=${loc.longitude}")
                    safelyResume(loc)
                }
                @Deprecated("Deprecated in Java")
                override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                override fun onProviderEnabled(provider: String) {}
                override fun onProviderDisabled(provider: String) {}
            }

            // Cleanup when completed or cancelled by timeout
            continuation.invokeOnCancellation {
                cancellationSource.cancel()
                try {
                    client.removeLocationUpdates(fusedCallback)
                } catch (_: Exception) {}
                try {
                    lm?.removeUpdates(nativeListener)
                } catch (_: Exception) {}
            }

            // Start Fused active request
            try {
                val fusedRequest = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000L)
                    .setMinUpdateIntervalMillis(500L)
                    .setMaxUpdates(1)
                    .setDurationMillis(ACTIVE_SEARCH_TIMEOUT_MS)
                    .build()

                client.requestLocationUpdates(fusedRequest, fusedCallback, Looper.getMainLooper())
            } catch (e: Exception) {
                Log.w(TAG, "Failed to start Fused location updates", e)
            }

            // Start Native active request (both Network and GPS in parallel)
            try {
                if (lm != null) {
                    if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                        lm.requestLocationUpdates(
                            LocationManager.NETWORK_PROVIDER,
                            500L,
                            0f,
                            nativeListener,
                            Looper.getMainLooper()
                        )
                    }
                    if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                        lm.requestLocationUpdates(
                            LocationManager.GPS_PROVIDER,
                            500L,
                            0f,
                            nativeListener,
                            Looper.getMainLooper()
                        )
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to start Native location updates", e)
            }

            // Also trigger getCurrentLocation one-shot concurrently
            try {
                client.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cancellationSource.token)
                    .addOnSuccessListener { loc ->
                        if (loc != null) {
                            Log.d(TAG, "getCurrentLocation returned: $loc")
                            safelyResume(loc)
                        }
                    }
            } catch (_: Exception) {}
        }
    }
}
