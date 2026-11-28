package com.spapp.monitoring.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Restore entry point for a hidden launcher icon.
 *
 * Once `IconHider.hide()` disables the launcher alias there is no icon to tap,
 * so the app needs a way back in. Dialling the secret code registered in the
 * manifest (`*#*#77277#*#*`) fires this receiver, which simply opens the app.
 *
 * This only opens the app - it does not restore the icon and it does not unlock
 * anything. Showing the icon again still needs the PIN that was set when it was
 * hidden, so knowing the code alone is not enough to change the app's state.
 */
class SpappSecretCodeReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_SECRET_CODE) return
        Log.i(TAG, "Secret code received - opening the app")

        try {
            context.startActivity(
                Intent(context, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra(MainActivity.EXTRA_OPENED_BY_SECRET_CODE, true)
                }
            )
        } catch (e: Exception) {
            Log.w(TAG, "Could not open the app from the secret code", e)
        }
    }

    private companion object {
        private const val TAG = "SpappSecretCode"
        const val ACTION_SECRET_CODE = "android.provider.Telephony.SECRET_CODE"
    }
}
