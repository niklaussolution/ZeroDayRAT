import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Public (no-login) landing page the dashboard's device-activation QR code /
 * shareable link points to: https://<domain>/connect?token=...&name=...
 *
 * If the app is already installed, Android intercepts this https URL via the
 * intent-filter on ActivationActivity (see AndroidManifest.xml) and opens
 * straight into the app with the token pre-filled — this page never
 * actually renders in that case. This page is the fallback shown when the
 * app isn't installed yet, or the OS doesn't offer the app-open prompt.
 */
export default function ConnectPage() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const name = params.get("name") || "this device";
  const [copied, setCopied] = useState(false);

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

        <div className="text-left bg-gray-50 border rounded p-3 text-sm mb-4">
          <p className="font-medium mb-2">If nothing happened:</p>
          <ol className="list-decimal list-inside text-gray-600 space-y-1">
            <li>Install the app on this phone (if not done already).</li>
            <li>Open the app and grant the requested permissions.</li>
            <li>Come back and tap this link again.</li>
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
