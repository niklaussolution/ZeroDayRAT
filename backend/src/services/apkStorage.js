const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Where the distributable APK lives on the server.
 *
 * The APK is a build artifact, not source, so it is deliberately NOT committed
 * to git any more: every build produced an ~8 MB binary that would otherwise
 * live in the repository history forever. The backend streams it from disk
 * instead, which also means the download URL is version-independent.
 *
 * Configure with:
 *   APK_STORAGE_DIR   absolute directory (default: backend/storage/apk)
 *   APK_FILENAME      file name inside that directory (default: spapp-monitor.apk)
 */
const STORAGE_DIR = process.env.APK_STORAGE_DIR
  ? path.resolve(process.env.APK_STORAGE_DIR)
  : path.resolve(__dirname, "../../storage/apk");

const APK_FILENAME = process.env.APK_FILENAME || "spapp-monitor.apk";
const META_FILENAME = APK_FILENAME.replace(/\.apk$/i, "") + ".json";

function apkPath() {
  return path.join(STORAGE_DIR, APK_FILENAME);
}

function metaPath() {
  return path.join(STORAGE_DIR, META_FILENAME);
}

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(metaPath(), "utf8"));
  } catch (_e) {
    return null;
  }
}

function writeMeta(meta) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
}

/**
 * Older layouts kept the APK inside the dashboard's static folder. Those paths
 * are still checked as a fallback so an existing deployment keeps serving the
 * current build until the first upload to STORAGE_DIR happens.
 */
function legacyPaths() {
  return [
    path.resolve(__dirname, "../../../dashboard/public/download/ZerodayRAT.apk"),
    path.resolve(__dirname, "../../../dashboard/dist/download/ZerodayRAT.apk"),
    path.resolve(__dirname, "../../../android-app/app/build/outputs/apk/release/app-release.apk"),
    path.resolve(__dirname, "../../../android-app/app/build/outputs/apk/debug/app-debug.apk"),
  ];
}

/** First existing APK on disk, or null. */
function resolveApkPath() {
  const candidates = [apkPath(), ...legacyPaths()];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_e) {
      // not there, keep looking
    }
  }
  return null;
}

function sha256OfFile(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Describes whatever APK would currently be served. */
function describe() {
  const file = resolveApkPath();
  if (!file) return null;

  const stat = fs.statSync(file);
  const meta = readMeta();

  return {
    available: true,
    filename: path.basename(file),
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    sha256: meta?.sha256 && meta?.filename === path.basename(file) ? meta.sha256 : sha256OfFile(file),
    versionName: meta?.versionName || null,
    versionCode: meta?.versionCode || null,
    source: file === apkPath() ? "storage" : "legacy",
  };
}

module.exports = {
  STORAGE_DIR,
  APK_FILENAME,
  apkPath,
  metaPath,
  readMeta,
  writeMeta,
  resolveApkPath,
  legacyPaths,
  sha256OfFile,
  describe,
};
