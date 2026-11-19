import { useEffect, useRef, useState } from "react";
import { WS_BASE_URL } from "../api/client";
import { devicesApi } from "../api/devices";

interface ScreenStreamViewProps {
  deviceId: string;
  deviceName?: string;
  isStandalone?: boolean;
  onClose?: () => void;
  onPopOut?: () => void;
}

type StreamStatus =
  | "initializing"
  | "connecting_ws"
  | "waiting_device"
  | "streaming"
  | "paused"
  | "stopped"
  | "error";

export default function ScreenStreamView({
  deviceId,
  deviceName,
  isStandalone = false,
  onClose,
  onPopOut,
}: ScreenStreamViewProps) {
  const [status, setStatus] = useState<StreamStatus>("initializing");
  const [statusMessage, setStatusMessage] = useState<string>("Initializing stream session...");
  const [hasFirstFrame, setHasFirstFrame] = useState<boolean>(false);
  const [fps, setFps] = useState<number>(0);
  const [frameCount, setFrameCount] = useState<number>(0);
  const [streamDuration, setStreamDuration] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [screenResolution, setScreenResolution] = useState<string | null>(null);
  const [isControlEnabled, setIsControlEnabled] = useState<boolean>(true);
  const [inputText, setInputText] = useState<string>("");

  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isRenderingRef = useRef<boolean>(false);
  const hasFirstFrameRef = useRef<boolean>(false);
  const frameCountRef = useRef<number>(0);
  const frameTimestampsRef = useRef<number[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const latestFrameRef = useRef<Uint8Array | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Mouse touch gesture tracking on canvas
  const dragStartRef = useRef<{ x: number; y: number; time: number } | null>(null);


  // Remote Control Helpers (AnyDesk style Touch & Gestures)
  const [lastActionFeedback, setLastActionFeedback] = useState<string | null>(null);
  const [forceCommandMode, setForceCommandMode] = useState(false);
  const [pressEnterOnSend, setPressEnterOnSend] = useState(false);

  const sendRemoteInput = async (payload: Record<string, unknown>, forceCommand = forceCommandMode) => {
    let sentWs = false;
    if (!forceCommand && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        const msg = JSON.stringify({
          action: "remote_input",
          ...payload,
        });
        console.log("[ScreenStreamView] Sending remote input via WebSocket:", msg);
        wsRef.current.send(msg);
        sentWs = true;
        setLastActionFeedback("Live WebSocket (0ms)");
      } catch (err) {
        console.warn("[ScreenStreamView] WebSocket send failed, falling back to Command API:", err);
      }
    }

    if (!sentWs || forceCommand) {
      try {
        console.log("[ScreenStreamView] Dispatching remote input via Command queue:", payload);
        setLastActionFeedback("Queueing Command...");
        await devicesApi.createCommand(deviceId, "remote_action", payload);
        setLastActionFeedback("Command queued to device");
      } catch (e) {
        console.warn("Failed to create remote_action command:", e);
        setLastActionFeedback("Delivery error");
      }
    }

    setTimeout(() => {
      setLastActionFeedback((prev) => (prev ? null : prev));
    }, 2500);
  };

  const getCanvasNormalizedCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
      return null;
    }

    // Canvas letterboxing / aspect ratio adjustment
    const canvasAspect = canvas.width / canvas.height;
    const boxAspect = rect.width / rect.height;

    let renderW = rect.width;
    let renderH = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (boxAspect > canvasAspect) {
      renderW = rect.height * canvasAspect;
      offsetX = (rect.width - renderW) / 2;
    } else {
      renderH = rect.width / canvasAspect;
      offsetY = (rect.height - renderH) / 2;
    }

    const xInRender = clientX - offsetX;
    const yInRender = clientY - offsetY;

    if (xInRender < 0 || xInRender > renderW || yInRender < 0 || yInRender > renderH) {
      return null;
    }

    return {
      x: Math.max(0, Math.min(1, xInRender / renderW)),
      y: Math.max(0, Math.min(1, yInRender / renderH)),
    };
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isControlEnabled || !hasFirstFrame) return;
    const coords = getCanvasNormalizedCoords(e);
    if (!coords) return;
    dragStartRef.current = { x: coords.x, y: coords.y, time: Date.now() };
  };

  const handleCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isControlEnabled || !hasFirstFrame || !dragStartRef.current) return;
    const start = dragStartRef.current;
    dragStartRef.current = null;

    const coords = getCanvasNormalizedCoords(e) || { x: start.x, y: start.y };
    const dx = coords.x - start.x;
    const dy = coords.y - start.y;
    const dist = Math.hypot(dx, dy);
    const duration = Math.min(600, Math.max(50, Date.now() - start.time));

    // If movement is small (< 2% screen distance), trigger a Tap
    if (dist < 0.02) {
      sendRemoteInput({
        type: "tap",
        x: start.x,
        y: start.y,
        duration: 50,
      });
    } else {
      // Otherwise trigger a Swipe
      sendRemoteInput({
        type: "swipe",
        startX: start.x,
        startY: start.y,
        endX: coords.x,
        endY: coords.y,
        duration: Math.max(200, duration),
      });
    }
  };

  const handleSendGlobalKey = (key: "BACK" | "HOME" | "RECENTS" | "NOTIFICATIONS" | "QUICK_SETTINGS" | "LOCK_SCREEN") => {
    sendRemoteInput({
      type: "key",
      key,
    });
  };

  const handleScroll = (direction: "UP" | "DOWN" | "LEFT" | "RIGHT") => {
    let startX = 0.5, startY = 0.5, endX = 0.5, endY = 0.5;
    if (direction === "UP") {
      startY = 0.75;
      endY = 0.25;
    } else if (direction === "DOWN") {
      startY = 0.25;
      endY = 0.75;
    } else if (direction === "LEFT") {
      startX = 0.8;
      endX = 0.2;
    } else if (direction === "RIGHT") {
      startX = 0.2;
      endX = 0.8;
    }
    sendRemoteInput({
      type: "swipe",
      startX,
      startY,
      endX,
      endY,
      duration: 250,
    });
  };

  const handleTapCenter = () => {
    sendRemoteInput({
      type: "tap",
      x: 0.5,
      y: 0.5,
      duration: 50,
    });
  };

  const handleSendText = (textToSend?: string) => {
    const text = textToSend ?? inputText;
    if (!text) return;
    sendRemoteInput({
      type: "text",
      text,
      pressEnter: pressEnterOnSend,
    });
    setInputText("");
  };
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (status === "streaming") {
      interval = setInterval(() => {
        setStreamDuration((prev) => prev + 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [status]);

  // FPS calculation cleaner (removes timestamps older than 1 second)
  useEffect(() => {
    const fpsInterval = setInterval(() => {
      const now = Date.now();
      frameTimestampsRef.current = frameTimestampsRef.current.filter((t) => now - t <= 1000);
      setFps(frameTimestampsRef.current.length);
      setFrameCount(frameCountRef.current);
    }, 500);

    return () => clearInterval(fpsInterval);
  }, []);

  const renderNextFrame = async () => {
    if (isRenderingRef.current || !latestFrameRef.current || !isMountedRef.current) return;
    isRenderingRef.current = true;
    const jpegBytes = latestFrameRef.current;
    latestFrameRef.current = null;

    try {
      const blob = new Blob([jpegBytes as BlobPart], { type: "image/jpeg" });
      const bitmap = await createImageBitmap(blob);
      const canvas = canvasRef.current;
      if (canvas && isMountedRef.current) {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          ctxRef.current = null;
          setScreenResolution(`${bitmap.width}x${bitmap.height}`);
        }
        if (!ctxRef.current) {
          ctxRef.current = canvas.getContext("2d", { alpha: false, desynchronized: true });
        }
        ctxRef.current?.drawImage(bitmap, 0, 0);

        if (!hasFirstFrameRef.current) {
          hasFirstFrameRef.current = true;
          setHasFirstFrame(true);
          setStatus("streaming");
          setStatusMessage("Live stream active");
        }
      }
      bitmap.close();
    } catch (err) {
      console.debug("Screen frame decode error", err);
    } finally {
      isRenderingRef.current = false;
      if (latestFrameRef.current && isMountedRef.current) {
        renderNextFrame();
      }
    }
  };



  const pollCommandStatus = async (commandId: string) => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, i < 5 ? 1000 : 2000));
      if (!isMountedRef.current) return;
      try {
        const cmd = await devicesApi.getCommand(deviceId, commandId);
        if (cmd.status === "acked") {
          const res = cmd.result as { success?: boolean; message?: string } | undefined;
          if (res && res.success === false) {
            setStatus("error");
            setStatusMessage(res.message || "Device reported an error starting screen stream.");
            return;
          } else {
            if (!hasFirstFrameRef.current) {
              setStatusMessage("Device started streaming. Awaiting incoming frames...");
            }
            return;
          }
        } else if (cmd.status === "failed") {
          const res = cmd.result as { message?: string } | undefined;
          setStatus("error");
          setStatusMessage(res?.message || "Remote command execution failed on device.");
          return;
        }
      } catch {
        // network glitch on poll
      }
    }
  };

  const startStream = () => {
    // 1. Cleanup any existing WS safely without firing aborted error events
    if (wsRef.current) {
      try {
        const oldWs = wsRef.current;
        wsRef.current = null;
        oldWs.onopen = null;
        oldWs.onerror = null;
        oldWs.onclose = null;
        oldWs.onmessage = null;
        oldWs.close();
      } catch {
        // ignore
      }
    }

    setStatus("connecting_ws");
    setStatusMessage("Connecting to live stream pipe...");

    const token = localStorage.getItem("spapp_token") || "";
    if (!token) {
      setStatus("error");
      setStatusMessage("Admin authentication missing. Please log in again.");
      return;
    }

    // 2. Open WebSocket IMMEDIATELY
    const wsUrl = `${WS_BASE_URL}/ws/screen-stream?role=admin&token=${encodeURIComponent(
      token
    )}&deviceId=${encodeURIComponent(deviceId)}`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      if (!isMountedRef.current || wsRef.current !== ws) return;
      setStatus("waiting_device");
      setStatusMessage("Relay connected. Waiting for phone frames...");
    };

    // 3. Concurrently dispatch wake command to device and poll acknowledgment
    devicesApi
      .createCommand(deviceId, "screen_stream", { action: "start" })
      .then((cmd) => {
        if (!isMountedRef.current) return;
        if (cmd.push && !cmd.push.sent) {
          setStatusMessage(
            `Wake queued (${cmd.push.reason || "push delayed"}). Awaiting device stream...`
          );
        } else {
          setStatusMessage("Wake signal delivered. Waiting for device stream...");
        }
        pollCommandStatus(cmd.id);
      })
      .catch((e) => {
        console.warn("Failed to send screen_stream wake command:", e);
        if (isMountedRef.current) {
          setStatusMessage("Wake error: " + (e as Error).message);
        }
      });

    ws.onmessage = async (event) => {
      if (!isMountedRef.current) return;

      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "status") {
            if (msg.message) {
              setStatusMessage(msg.message);
            }
            if (msg.status === "streaming") {
              setStatus("streaming");
            } else if (msg.status === "waiting_device") {
              setStatus("waiting_device");
            } else if (msg.status === "waiting_a11y" || msg.status === "capture_error") {
              setStatus("error");
            } else if (msg.status === "reconnecting") {
              setStatusMessage("Device switching apps / reconnecting...");
            } else if (msg.status === "device_stopped") {
              setStatus("stopped");
            }
          }
        } catch {
          // ignore
        }
      } else {
        let arrayBuffer: ArrayBuffer;
        if (event.data instanceof ArrayBuffer) {
          arrayBuffer = event.data;
        } else if (event.data instanceof Blob) {
          arrayBuffer = await event.data.arrayBuffer();
        } else {
          return;
        }

        const bytes = new Uint8Array(arrayBuffer);
        if (bytes.length < 2) return;

        // Packet Type Routing:
        // 0x01: Video JPEG frame
        // 0xFF, 0xD8: Legacy raw JPEG frame
        if (bytes[0] === 0x01 || (bytes[0] === 0xff && bytes[1] === 0xd8)) {
          if (status !== "streaming") {
            setStatus("streaming");
            setStatusMessage("Live screen stream active");
          }
          const jpegBytes = bytes[0] === 0x01 ? bytes.subarray(1) : bytes;
          latestFrameRef.current = jpegBytes;
          if (!isRenderingRef.current) {
            renderNextFrame();
          }

          frameCountRef.current += 1;
          frameTimestampsRef.current.push(Date.now());
        }
      }
    };

    ws.onerror = (err) => {
      console.error("Screen stream WebSocket error:", err);
      if (!isMountedRef.current || wsRef.current !== ws) return;
      setStatus("error");
      setStatusMessage("Connection error with screen relay. If this persists, please log out and log in again.");
    };

    ws.onclose = (event) => {
      if (!isMountedRef.current || wsRef.current !== ws) return;
      if (status !== "stopped") {
        if (event.code !== 1000 && event.code !== 1005) {
          setStatus("error");
          setStatusMessage(`Relay connection closed (${event.code}). Click 'Restart Stream' below.`);
        } else {
          setStatus("stopped");
          setStatusMessage("Screen stream session closed.");
        }
      }
    };
  };

  const stopStream = (sendRemoteCommand = true) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ action: "stop" }));
        wsRef.current.close();
      } catch {
        // ignore
      }
    }
    wsRef.current = null;
    setStatus("stopped");
    setStatusMessage("Screen stream stopped by administrator.");

    if (sendRemoteCommand) {
      // Also send stop remote command in case socket is already closed
      devicesApi
        .createCommand(deviceId, "screen_stream", { action: "stop" })
        .catch(() => {});
    }
  };

  const handleSnapshot = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasFirstFrame) return;
    try {
      const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
      const a = document.createElement("a");
      a.href = dataUrl;
      const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `spapp-screen-${deviceName || deviceId}-${dateStr}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      console.warn("Snapshot failed", e);
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    startStream();

    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);

    return () => {
      isMountedRef.current = false;
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (wsRef.current) {
        try {
          const old = wsRef.current;
          wsRef.current = null;
          old.onopen = null;
          old.onerror = null;
          old.onclose = null;
          old.onmessage = null;
          old.close();
        } catch {
          // ignore
        }
      }
    };
  }, [deviceId]);

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div
      ref={containerRef}
      className={`flex flex-col items-center justify-between bg-slate-950 text-slate-100 select-none ${
        isStandalone ? "min-h-screen p-4 sm:p-6" : "p-4 w-full"
      }`}
    >
      {/* Global Device Bar */}
      <div className="w-full max-w-5xl flex flex-wrap items-center justify-between gap-3 pb-4 mb-6 border-b border-slate-800/80">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center">
            <span
              className={`w-3.5 h-3.5 rounded-full ${
                status === "streaming"
                  ? "bg-emerald-500 animate-ping absolute opacity-75"
                  : status === "waiting_device"
                  ? "bg-amber-400 animate-pulse absolute opacity-75"
                  : status === "error"
                  ? "bg-rose-500"
                  : "bg-slate-600"
              }`}
            />
            <span
              className={`w-3 h-3 rounded-full ${
                status === "streaming"
                  ? "bg-emerald-500 shadow-lg shadow-emerald-500/50"
                  : status === "waiting_device"
                  ? "bg-amber-400 shadow-lg shadow-amber-400/50"
                  : status === "error"
                  ? "bg-rose-500 shadow-lg shadow-rose-500/50"
                  : "bg-slate-500"
              }`}
            />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-bold text-slate-100 tracking-tight">{deviceName || "Target Device"}</h2>
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                status === "streaming"
                  ? "bg-emerald-950/80 text-emerald-400 border border-emerald-700/80 shadow-sm shadow-emerald-950"
                  : status === "error"
                  ? "bg-rose-950/80 text-rose-400 border border-rose-700/80"
                  : "bg-slate-800 text-slate-400 border border-slate-700"
              }`}>
                {status === "streaming" ? "LIVE STREAM" : status}
              </span>
            </div>
            <p className={`text-xs truncate max-w-xs sm:max-w-md ${
              status === "error" ? "text-rose-400 font-medium" : "text-slate-400"
            }`}>
              {statusMessage}
            </p>
          </div>
        </div>

        {/* Global Toolbar Controls */}
        <div className="flex items-center gap-2">
          {status === "streaming" || status === "waiting_device" ? (
            <button
              onClick={() => stopStream(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 active:scale-95 text-white text-xs font-semibold shadow-md shadow-rose-950 transition"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" strokeWidth={2} />
              </svg>
              <span>Stop Stream</span>
            </button>
          ) : (
            <button
              onClick={startStream}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white text-xs font-semibold shadow-md shadow-emerald-950 transition"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              </svg>
              <span>Start Stream</span>
            </button>
          )}

          <button
            onClick={handleSnapshot}
            disabled={!hasFirstFrame}
            title="Save high-resolution screenshot"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 active:scale-95 text-slate-200 border border-slate-700/60 text-xs font-medium transition disabled:opacity-40"
          >
            <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="hidden sm:inline">Snapshot</span>
          </button>

          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            className="p-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/60 transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isFullscreen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              )}
            </svg>
          </button>

          {!isStandalone && onPopOut && (
            <button
              onClick={onPopOut}
              title="Open in separate window"
              className="p-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/60 transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
          )}

          {onClose && (
            <button
              onClick={onClose}
              title="Close Stream"
              className="p-2 rounded-xl bg-slate-800/90 hover:bg-rose-950/80 hover:text-rose-400 hover:border-rose-800/80 text-slate-400 border border-slate-700/60 transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Main Content: Dual-Column Deck */}
      <div className={`w-full ${isFullscreen ? "max-w-md" : "max-w-5xl"} flex flex-col lg:flex-row items-center lg:items-start justify-center gap-8`}>
        {/* Left Column: Mobile Phone Mockup */}
        <div className="flex flex-col items-center w-full max-w-[360px]">
          {/* Status Pills Bar */}
          <div className="w-full flex items-center justify-between text-[11px] font-mono text-slate-400 bg-slate-900/90 backdrop-blur rounded-xl px-3.5 py-2 mb-3 border border-slate-800/80 shadow-md">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1">
                <span className="text-slate-500 font-medium">FPS:</span>
                <span className={`font-bold ${fps > 0 ? "text-emerald-400" : "text-slate-400"}`}>{fps.toFixed(1)}</span>
              </span>
              <span className="text-slate-700">|</span>
              <span className="flex items-center gap-1">
                <span className="text-slate-500 font-medium">FRAMES:</span>
                <span className="text-slate-300 font-semibold">{frameCount}</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              {screenResolution && (
                <>
                  <span className="text-slate-400">{screenResolution}</span>
                  <span className="text-slate-700">|</span>
                </>
              )}
              <span className="text-slate-500 font-medium">TIME:</span>
              <span className="text-slate-200 font-semibold">{formatTimer(streamDuration)}</span>
            </div>
          </div>

          {/* Phone Frame */}
          <div className="relative w-full aspect-[9/19] bg-gradient-to-b from-slate-800 via-slate-900 to-slate-950 rounded-[48px] p-3 shadow-2xl shadow-cyan-950/20 border-[3px] border-slate-700/70 ring-1 ring-white/10 flex flex-col items-center justify-between">
            {/* Top Dynamic Island / Speaker Pill */}
            <div className="absolute top-3.5 z-20 flex items-center justify-center gap-2 px-3.5 py-1 rounded-full bg-slate-950 border border-slate-800 shadow-inner">
              <div className="w-2.5 h-2.5 rounded-full bg-slate-900 border border-slate-700/80 flex items-center justify-center">
                <div className="w-1 h-1 rounded-full bg-cyan-500/80 animate-pulse" />
              </div>
              <div className="w-9 h-1 rounded-full bg-slate-800" />
            </div>

            {/* Screen Viewport Canvas */}
            <div className="w-full h-full bg-black rounded-[36px] overflow-hidden relative flex items-center justify-center">
              <canvas
                ref={canvasRef}
                onMouseDown={handleCanvasMouseDown}
                onMouseUp={handleCanvasMouseUp}
                className={`w-full h-full object-contain select-none ${
                  hasFirstFrame ? "block cursor-pointer active:cursor-grabbing" : "hidden"
                }`}
              />

              {!hasFirstFrame && (
                <div className="flex flex-col items-center justify-center text-center p-6 space-y-4">
                  <div className="relative flex items-center justify-center">
                    {status === "error" ? (
                      <div className="w-12 h-12 rounded-full bg-rose-950 border border-rose-600 flex items-center justify-center">
                        <svg className="w-6 h-6 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                      </div>
                    ) : (
                      <>
                        <div className="w-16 h-16 rounded-full border border-sky-500/20 animate-ping absolute" />
                        <div className="w-12 h-12 rounded-full border border-sky-400/40 animate-pulse absolute" />
                        <div className="w-10 h-10 rounded-full bg-sky-500/10 border border-sky-500/60 flex items-center justify-center">
                          <svg className="w-5 h-5 text-sky-400 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="space-y-1">
                    <p className={`text-xs font-semibold ${status === "error" ? "text-rose-400" : "text-slate-200"}`}>
                      {status === "error" ? "Stream Stalled" : "Awaiting Device Screen..."}
                    </p>
                    <p className="text-[11px] text-slate-400 max-w-[200px] leading-relaxed break-words">
                      {statusMessage}
                    </p>
                  </div>

                  <button
                    onClick={startStream}
                    className="px-3.5 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-500 active:scale-95 text-white rounded-xl shadow-md shadow-sky-950 transition"
                  >
                    Retry Connection
                  </button>
                </div>
              )}

              {/* Bottom White Indicator Pill */}
              <div className="absolute bottom-2.5 z-20 w-24 h-1 bg-slate-400/50 rounded-full backdrop-blur-sm pointer-events-none" />
            </div>
          </div>

          {/* Under-Phone Hardware Nav Bar */}
          <div className="w-full mt-3 flex items-center justify-between p-1.5 rounded-2xl bg-slate-900/90 border border-slate-800 shadow-lg backdrop-blur">
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleSendGlobalKey("RECENTS")}
                disabled={!hasFirstFrame || !isControlEnabled}
                title="Recent Apps (Overview)"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-medium border border-slate-700/50 transition disabled:opacity-40"
              >
                <svg className="w-3.5 h-3.5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <rect x="5" y="5" width="14" height="14" rx="2" strokeWidth={2} />
                </svg>
                <span>Apps</span>
              </button>

              <button
                onClick={() => handleSendGlobalKey("HOME")}
                disabled={!hasFirstFrame || !isControlEnabled}
                title="Home Screen"
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-medium border border-slate-700/50 transition disabled:opacity-40"
              >
                <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="7" strokeWidth={2} />
                </svg>
                <span>Home</span>
              </button>

              <button
                onClick={() => handleSendGlobalKey("BACK")}
                disabled={!hasFirstFrame || !isControlEnabled}
                title="Back Button"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-medium border border-slate-700/50 transition disabled:opacity-40"
              >
                <svg className="w-3.5 h-3.5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                <span>Back</span>
              </button>
            </div>

            <button
              onClick={() => setIsControlEnabled((prev) => !prev)}
              title={isControlEnabled ? "Touch Gestures Active" : "Touch Gestures Paused"}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold transition active:scale-95 border ${
                isControlEnabled
                  ? "bg-emerald-950/80 text-emerald-400 border-emerald-600/60 shadow-sm shadow-emerald-950"
                  : "bg-slate-800 text-slate-400 border-slate-700"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isControlEnabled ? "bg-emerald-400 animate-pulse" : "bg-slate-500"}`} />
              <span>{isControlEnabled ? "Touch ON" : "View Only"}</span>
            </button>
          </div>
        </div>

        {/* Right Column: Sleek AnyDesk-Style Control Console */}
        {!isFullscreen && (
          <div className="w-full max-w-md lg:w-96 flex flex-col gap-4 bg-slate-900/80 border border-slate-800/90 rounded-3xl p-5 shadow-2xl ring-1 ring-white/5 backdrop-blur-xl">
            {/* Header / Dispatch Status */}
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-2xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400 shadow-inner">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100 tracking-tight">Remote Control Deck</h3>
                  <p className="text-[11px] text-slate-400">Interactive Device Automation</p>
                </div>
              </div>

              {lastActionFeedback ? (
                <span className="text-[10px] font-mono font-semibold px-2.5 py-1 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-700/80 shadow-sm animate-pulse">
                  {lastActionFeedback}
                </span>
              ) : (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                  Ready
                </span>
              )}
            </div>

            {/* Quick System Action Cards */}
            <div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-2 px-1">
                Quick Actions
              </span>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => handleSendGlobalKey("NOTIFICATIONS")}
                  disabled={!hasFirstFrame}
                  className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl bg-slate-950/60 hover:bg-slate-800/90 active:scale-95 text-slate-200 border border-slate-800/80 hover:border-slate-700 transition disabled:opacity-40 shadow-sm group"
                >
                  <div className="w-8 h-8 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 group-hover:scale-110 transition">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                    </svg>
                  </div>
                  <span className="text-[11px] font-medium text-slate-300">Alerts</span>
                </button>

                <button
                  onClick={() => handleSendGlobalKey("QUICK_SETTINGS")}
                  disabled={!hasFirstFrame}
                  className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl bg-slate-950/60 hover:bg-slate-800/90 active:scale-95 text-slate-200 border border-slate-800/80 hover:border-slate-700 transition disabled:opacity-40 shadow-sm group"
                >
                  <div className="w-8 h-8 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 group-hover:scale-110 transition">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <span className="text-[11px] font-medium text-slate-300">Settings</span>
                </button>

                <button
                  onClick={() => handleSendGlobalKey("LOCK_SCREEN")}
                  disabled={!hasFirstFrame}
                  className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl bg-slate-950/60 hover:bg-slate-800/90 active:scale-95 text-slate-200 border border-slate-800/80 hover:border-slate-700 transition disabled:opacity-40 shadow-sm group"
                >
                  <div className="w-8 h-8 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 group-hover:scale-110 transition">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </div>
                  <span className="text-[11px] font-medium text-slate-300">Lock Screen</span>
                </button>
              </div>
            </div>

            {/* Directional Touch & Scroll Pad (D-Pad) */}
            <div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-2 px-1">
                Directional Scroll & Swipe Pad
              </span>
              <div className="flex flex-col items-center gap-2 bg-slate-950/70 p-4 rounded-3xl border border-slate-800/80 shadow-inner">
                <button
                  onClick={() => handleScroll("UP")}
                  disabled={!hasFirstFrame}
                  title="Scroll Content Down (Swipe Upwards)"
                  className="w-28 py-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5 border border-slate-700/60 shadow-sm transition disabled:opacity-40"
                >
                  <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
                  </svg>
                  <span>Scroll Up</span>
                </button>

                <div className="flex items-center gap-2.5">
                  <button
                    onClick={() => handleScroll("LEFT")}
                    disabled={!hasFirstFrame}
                    title="Swipe Left"
                    className="w-24 py-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1 border border-slate-700/60 shadow-sm transition disabled:opacity-40"
                  >
                    <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                    </svg>
                    <span>Left</span>
                  </button>

                  <button
                    onClick={handleTapCenter}
                    disabled={!hasFirstFrame}
                    title="Tap Screen Center"
                    className="w-20 py-2.5 rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 active:scale-90 text-white text-xs font-extrabold shadow-lg shadow-sky-950 transition disabled:opacity-40 flex items-center justify-center"
                  >
                    <span>TAP</span>
                  </button>

                  <button
                    onClick={() => handleScroll("RIGHT")}
                    disabled={!hasFirstFrame}
                    title="Swipe Right"
                    className="w-24 py-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1 border border-slate-700/60 shadow-sm transition disabled:opacity-40"
                  >
                    <span>Right</span>
                    <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>

                <button
                  onClick={() => handleScroll("DOWN")}
                  disabled={!hasFirstFrame}
                  title="Scroll Content Up (Swipe Downwards)"
                  className="w-28 py-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5 border border-slate-700/60 shadow-sm transition disabled:opacity-40"
                >
                  <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                  </svg>
                  <span>Scroll Down</span>
                </button>
              </div>
            </div>

            {/* Remote Keyboard & Text Injector */}
            <div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-2 px-1">
                Remote Keyboard
              </span>
              <div className="bg-slate-950/70 p-3.5 rounded-2xl border border-slate-800/80 shadow-inner flex flex-col gap-2.5">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSendText();
                      }}
                      placeholder="Type text for active input..."
                      className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-700/80 rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500/50 transition"
                    />
                    <svg className="w-4 h-4 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18M7 6h10M7 18h10" />
                    </svg>
                  </div>
                  <button
                    onClick={() => handleSendText()}
                    disabled={!inputText.trim()}
                    className="px-4 py-2 text-xs font-bold bg-sky-600 hover:bg-sky-500 active:scale-95 text-white rounded-xl shadow-md shadow-sky-950 transition disabled:opacity-40"
                  >
                    Send
                  </button>
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-400 px-1">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={pressEnterOnSend}
                      onChange={(e) => setPressEnterOnSend(e.target.checked)}
                      className="rounded border-slate-700 text-sky-600 focus:ring-0 bg-slate-900 w-3.5 h-3.5"
                    />
                    <span>Press Enter (Submit) after typing</span>
                  </label>
                  {inputText && (
                    <button
                      onClick={() => setInputText("")}
                      className="text-slate-500 hover:text-slate-300 font-medium transition"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Channel Mode Toggle */}
            <div className="flex items-center justify-between text-xs bg-slate-950/50 px-3 py-2 rounded-xl border border-slate-800/60 mt-1">
              <span className="text-[11px] text-slate-400 font-medium">Channel:</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setForceCommandMode(false)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold tracking-wide uppercase transition ${
                    !forceCommandMode
                      ? "bg-sky-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  WebSocket 0ms
                </button>
                <button
                  onClick={() => setForceCommandMode(true)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold tracking-wide uppercase transition ${
                    forceCommandMode
                      ? "bg-amber-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  HTTP Queue
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
