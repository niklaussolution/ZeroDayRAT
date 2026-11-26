import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { APK_DOWNLOAD_URL, APK_FILENAME } from "../api/apk";

/**
 * Public (no-login) landing page the dashboard's device-activation QR code /
 * shareable link points to: https://<domain>/connect?token=...&name=...
 *
 * If the app is already installed, Android intercepts this https URL via the
 * intent-filter on ActivationActivity (see AndroidManifest.xml) and opens
 * straight into the app with the token pre-filled. If it's not installed
 * yet, "Download App" below copies the token to the clipboard first — a
 * sideloaded app has no Play Install Referrer to carry the token across the
 * install/open gap, so SplashActivity reads it back from the clipboard on
 * first launch instead (see SplashActivity.kt) and activates silently
 * before the device user ever sees a code-entry screen.
 */
export default function ConnectPage() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const name = params.get("name") || "this device";

  useEffect(() => {
    // 1. Silent token copy to clipboard if available
    if (token && navigator.clipboard) {
      navigator.clipboard.writeText(token).catch(() => {});
    }

    // 2. Try waking app if already installed
    if (token) {
      const appUrl = `spappmonitor://activate?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`;
      window.location.href = appUrl;
    }

    // 3. Immediately trigger direct APK download without waiting for any button click!
    const timer = setTimeout(() => {
      window.location.replace(APK_DOWNLOAD_URL);
    }, 200);

    return () => clearTimeout(timer);
  }, [token, name]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm w-full bg-white rounded-xl shadow-sm p-6 text-center space-y-4">
        <div className="w-12 h-12 mx-auto rounded-full bg-blue-50 flex items-center justify-center animate-bounce text-primary">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </div>
        <div>
          <h1 className="text-base font-bold text-gray-900">Direct Download Starting...</h1>
          <p className="text-xs text-gray-500 mt-1">
            {APK_FILENAME} download aagudhu. Download mudinjadhum <strong>"Open"</strong> ➔ <strong>"Install"</strong> click pannunga.
          </p>
        </div>
        <a
          href={APK_DOWNLOAD_URL}
          download={APK_FILENAME}
          className="inline-block text-xs text-primary hover:underline font-medium pt-2"
        >
          Download start aagala-na inga click pannunga
        </a>
      </div>
    </div>
  );
}
