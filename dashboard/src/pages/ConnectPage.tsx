import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { buildApkDownloadUrl, APK_FILENAME } from "../api/apk";

/**
 * Public (no-login) landing page the dashboard's device-activation link points
 * at: https://<domain>/connect?token=...&name=...
 *
 * Hand-off strategy, in order, with no browser permission prompt:
 *
 *  1. The token is appended to the APK download URL. The backend records
 *     (token, client IP, time) and the freshly installed app collects it with
 *     POST /api/devices/claim. This is the path that works after a sideload,
 *     where the clipboard used to be the only carrier - and where
 *     navigator.clipboard.writeText() triggered an "allow clipboard" prompt in
 *     some Android browsers and raced the navigation, losing the token.
 *
 *  2. If the app is already installed, a hidden iframe fires the
 *     spappmonitor:// deep link. An iframe is used on purpose: a top-level
 *     navigation to an unhandled scheme would replace this page and kill the
 *     download that just started.
 *
 * The "copy the code" button is still present, but it only runs on a real tap,
 * which is a user gesture and therefore never prompts.
 */
export default function ConnectPage() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const name = params.get("name") || "this device";
  const [copied, setCopied] = useState(false);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const downloadUrl = buildApkDownloadUrl(token);

  useEffect(() => {
    if (!token) return;

    // 1. Deep link first, through an iframe so a missing handler cannot
    //    navigate this page away.
    const t1 = window.setTimeout(() => {
      const appUrl = `spappmonitor://activate?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`;
      if (iframeRef.current) iframeRef.current.src = appUrl;
    }, 150);

    // 2. Then the download, which also records the claim for this IP.
    const t2 = window.setTimeout(() => {
      setDownloadStarted(true);
      window.location.replace(downloadUrl);
    }, 900);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [token, name, downloadUrl]);

  const copyCode = async () => {
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
      <iframe ref={iframeRef} title="app" className="hidden" aria-hidden="true" />
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
              onClick={copyCode}
              className="w-full rounded-md bg-primary px-3 py-2 text-xs font-medium text-white"
            >
              {copied ? "Copied ✓" : "Copy code"}
            </button>
          </div>
        )}

        <a
          href={downloadUrl}
          download={APK_FILENAME}
          className="inline-block text-xs text-primary hover:underline font-medium pt-1"
        >
          Download start aagala-na inga click pannunga
        </a>
      </div>
    </div>
  );
}
