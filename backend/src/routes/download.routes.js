const express = require("express");
const fs = require("fs");
const path = require("path");
const apkStorage = require("../services/apkStorage");
const { requireAuth, requireSuperAdmin } = require("../middleware/auth.middleware");

const router = express.Router();

const APK_MIME = "application/vnd.android.package-archive";

/**
 * GET /api/download/apk
 *
 * Public, unauthenticated stream of the current build. This is the URL the
 * device-activation link ultimately points at, so it has to work before the
 * device has any token.
 *
 * res.sendFile() runs on `send`, which handles Range requests, ETag and
 * Last-Modified for us - a 9 MB download over a flaky mobile connection can
 * therefore resume instead of restarting.
 */
router.get("/apk", (req, res) => {
  const file = apkStorage.resolveApkPath();

  if (!file) {
    return res.status(404).json({
      error: "No APK published yet",
      hint: "Upload a build with POST /api/download/apk (super-admin) or copy it to APK_STORAGE_DIR.",
    });
  }

  // Direct downloads come from a different origin (the dashboard on Vercel),
  // so opt this response out of helmet's same-origin resource policy.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Content-Type", APK_MIME);
  res.setHeader("Content-Disposition", `attachment; filename="${apkStorage.APK_FILENAME}"`);
  // Serving a build that changed since the last request must not be served
  // from a stale browser cache; the ETag still makes repeat downloads cheap.
  res.setHeader("Cache-Control", "no-cache");

  res.sendFile(file, { headers: { "Content-Type": APK_MIME } }, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: "Failed to stream APK" });
    }
  });
});

/**
 * GET /api/download/apk/info
 *
 * Version + hash metadata, used by the dashboard to show which build is live
 * and by the app to decide whether an update is available.
 */
router.get("/apk/info", (req, res) => {
  const info = apkStorage.describe();
  if (!info) {
    return res.status(404).json({ available: false, error: "No APK published yet" });
  }
  res.json({
    ...info,
    downloadUrl: `${req.protocol}://${req.get("host")}/api/download/apk`,
  });
});

/**
 * POST /api/download/apk?versionName=1.5.0&versionCode=49
 *
 * Super-admin upload of a new build. Body is the raw APK bytes
 * (Content-Type: application/octet-stream), so no multipart dependency is
 * needed and it can be pushed with a single curl from a build script.
 *
 * The file is written to a temp name and renamed into place, so a device
 * downloading mid-upload never receives a half-written APK.
 */
router.post(
  "/apk",
  requireAuth,
  requireSuperAdmin,
  express.raw({ type: () => true, limit: process.env.APK_MAX_UPLOAD || "200mb" }),
  (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 1024) {
      return res.status(400).json({ error: "Request body must be the raw APK bytes" });
    }

    // Zip local file header - every APK is a zip, so this catches an HTML error
    // page accidentally uploaded as an APK.
    if (!(body[0] === 0x50 && body[1] === 0x4b)) {
      return res.status(400).json({ error: "Body is not a ZIP/APK (bad magic bytes)" });
    }

    const target = apkStorage.apkPath();
    const tmp = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });

    try {
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, target);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch (_e) {}
      return res.status(500).json({ error: "Failed to store APK", detail: err.message });
    }

    const meta = {
      filename: path.basename(target),
      sizeBytes: body.length,
      sha256: apkStorage.sha256OfFile(target),
      versionName: req.query.versionName || null,
      versionCode: req.query.versionCode ? Number(req.query.versionCode) : null,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.auth?.userId || null,
    };
    apkStorage.writeMeta(meta);

    res.json({ ok: true, ...meta, downloadUrl: `${req.protocol}://${req.get("host")}/api/download/apk` });
  }
);

module.exports = router;
