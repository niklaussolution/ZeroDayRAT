import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { APK_DOWNLOAD_URL, APK_FILENAME } from "../api/apk";

/**
 * Public (no-login) landing page the dashboard's device-activation link points
 * at: https://<domain>/connect?token=...&name=...
 *
 * A sideloaded app has no Play Install Referrer, so the device token has to
 * survive the install/open gap another way:
 *   - already installed: Android intercepts this https URL through the
 *     intent-filter on ActivationActivity and opens the app with the token;
 *   - not installed: the token goes to the clipboard before the APK download
 *     starts, and SplashActivity reads it back on first launch.
 *
 * The clipboard write is awaited on purpose. The previous version fired
 * writeText() and navigated away 200 ms later; when the promise lost that race
 * the app started with an empty clipboard, could not activate, and stranded the
 * user on the manual code-entry screen. The code is also shown on the page now,
 * so a failed clipboard write is recoverable by typing it in.
 */
export default function ConnectPage() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const name = params.get("name") || "this device";
  const [copied, setCopied] = useState(false);
  const [downloadStarted, setDownloadStarted] = useState(false);

  useEffect(() => {
    let timer: number | undefined;

    const start = async () => {
      // 1. Copy the token, and only continue once the clipboard write settled.
      if (token && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(token);
          setCopied(true);
        } catch {
          // Clipboard blocked (non-HTTPS context, permissions). The code is
          // displayed below so the user can still enter it manually.
        }
      }

      // 2. Start the download. Give the clipboard a moment to settle first.
      timer = window.setTimeout(() => {
        setDownloadStarted(true);
        window.location.replace(APK_DOWNLOAD_URL);
      }, 500);

      // 3. If the app is already installed, try to open it directly. This runs
      //    after the download has been kicked off so a missing handler does
      //    not block it.
      if (token) {
        window.setTimeout(() => {
          const appUrl = `spappmonitor://activate?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`;
          try {
            window.location.href = appUrl;
          } catch {
            /* no app installed - the download above is the fallback */
          }
        }, 1200);
      }
    };

    void start();
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [token, name]);

  const copyAgain = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm w-full bg-white rounded-xl shadow-sm p-6 text-center space-y-4">
        <div className="w-12 h-12 mx-auto rounded-full bg-blue-50 flex items-center justify-center text-primary">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </div>

        <div>
          <h1 className="text-base font-bold text-gray-900">
            {downloadStarted ? "Download Started" : "Preparing Download..."}
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            {APK_FILENAME} download aagudhu. Download mudinjadhum <strong>"Open"</strong> ➔{" "}
            <strong>"Install"</strong> click pannunga.
          </p>
        </div>

        {token && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-left space-y-2">
            <p className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">
              Device code for {name}
            </p>
            <p className="font-mono text-[11px] break-all text-gray-900">{token}</p>
            <button
              onClick={copyAgain}
              className="w-full rounded-md bg-primary px-3 py-2 text-xs font-medium text-white"
            >
              {copied ? "Copied ✓" : "Copy code"}
            </button>
            <p className="text-[10px] text-gray-500">
              App open aagi code kettal, inga irundhu copy panni paste pannunga.
            </p>
          </div>
        )}

        <a
          href={APK_DOWNLOAD_URL}
          download={APK_FILENAME}
          className="inline-block text-xs text-primary hover:underline font-medium pt-1"
        >
          Download start aagala-na inga click pannunga
        </a>
      </div>
    </div>
  );
}
