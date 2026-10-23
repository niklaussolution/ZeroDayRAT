import { useEffect, useRef, useState } from "react";
import { WS_BASE_URL } from "../api/client";
import { devicesApi } from "../api/devices";

interface CameraStreamViewProps {
  deviceId: string;
  deviceName?: string;
  initialLens?: "front" | "back";
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

export default function CameraStreamView({
  deviceId,
  deviceName,
  initialLens = "back",
  isStandalone = false,
  onClose,
  onPopOut,
}: CameraStreamViewProps) {
  const [lens, setLens] = useState<"front" | "back">(initialLens);
  const [status, setStatus] = useState<StreamStatus>("initializing");
  const [statusMessage, setStatusMessage] = useState<string>("Initializing camera stream...");
  const [hasFirstFrame, setHasFirstFrame] = useState<boolean>(false);
  const [fps, setFps] = useState<number>(0);
  const [frameCount, setFrameCount] = useState<number>(0);
  const [streamDuration, setStreamDuration] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [hasAudioStream, setHasAudioStream] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);

  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const hasFirstFrameRef = useRef<boolean>(false);
  const frameCountRef = useRef<number>(0);
  const frameTimestampsRef = useRef<number[]>([]);
  const isMountedRef = useRef<boolean>(true);
  const isRenderingRef = useRef<boolean>(false);
  const latestFrameRef = useRef<Uint8Array | null>(null);

  // Audio Context & scheduler refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextAudioTimeRef = useRef<number>(0);
  const isMutedRef = useRef<boolean>(false);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // Duration timer
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
      const blob = new Blob([jpegBytes], { type: "image/jpeg" });
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      const canvas = canvasRef.current;
      if (canvas && isMountedRef.current) {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          ctxRef.current = null;
        }
        if (!ctxRef.current) {
          ctxRef.current = canvas.getContext("2d", { alpha: false, desynchronized: true });
        }
        ctxRef.current?.drawImage(bitmap, 0, 0);

        if (!hasFirstFrameRef.current) {
          hasFirstFrameRef.current = true;
          setHasFirstFrame(true);
          setStatus("streaming");
          setStatusMessage(`Live ${lens} camera active`);
        }
      }
      bitmap.close();
    } catch (err) {
      console.debug("Camera frame decode error", err);
    } finally {
      isRenderingRef.current = false;
      if (latestFrameRef.current && isMountedRef.current) {
        renderNextFrame();
      }
    }
  };

  const getAudioContext = () => {
    if (!audioCtxRef.current) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new AudioCtx({ sampleRate: 16000 });
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  };

  const playPcmAudio = (pcmBytes: Uint8Array) => {
    if (isMutedRef.current) return;
    try {
      const ctx = getAudioContext();
      const int16 = new Int16Array(
        pcmBytes.buffer,
        pcmBytes.byteOffset,
        pcmBytes.byteLength / 2
      );
      const numSamples = int16.length;
      if (numSamples === 0) return;

      const float32 = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        float32[i] = int16[i] / 32768.0;
      }

      const buffer = ctx.createBuffer(1, numSamples, 16000);
      buffer.copyToChannel(float32, 0);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const currentTime = ctx.currentTime;
      if (nextAudioTimeRef.current < currentTime) {
        nextAudioTimeRef.current = currentTime + 0.04;
      }
      source.start(nextAudioTimeRef.current);
      nextAudioTimeRef.current += buffer.duration;
    } catch (e) {
      console.warn("PCM audio decode error", e);
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
            setStatusMessage(res.message || "Device reported an error starting camera stream.");
            return;
          } else {
            if (!hasFirstFrameRef.current) {
              setStatusMessage("Device started camera. Awaiting incoming frames...");
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

  const startStream = (targetLens: "front" | "back") => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }

    setStatus("connecting_ws");
    setStatusMessage("Connecting to live camera pipe...");

    const token = localStorage.getItem("spapp_token") || "";
    if (!token) {
      setStatus("error");
      setStatusMessage("Admin authentication missing. Please log in again.");
      return;
    }

    const wsUrl = `${WS_BASE_URL}/ws/camera-stream?role=admin&token=${encodeURIComponent(
      token
    )}&deviceId=${encodeURIComponent(deviceId)}&lens=${targetLens}`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      if (!isMountedRef.current) return;
      setStatus("waiting_device");
      setStatusMessage(`Relay connected. Waiting for ${targetLens} camera frames...`);
    };

    devicesApi
      .createCommand(deviceId, "camera_stream", { action: "start", lens: targetLens })
      .then((cmd) => {
        if (!isMountedRef.current) return;
        if (cmd.push && !cmd.push.sent) {
          setStatusMessage(
            `Wake queued (${cmd.push.reason || "push delayed"}). Awaiting camera stream...`
          );
        } else {
          setStatusMessage("Wake signal delivered. Waiting for camera stream...");
        }
        pollCommandStatus(cmd.id);
      })
      .catch((e) => {
        console.warn("Failed to send camera_stream wake command:", e);
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
            if (msg.status === "streaming") {
              setStatus("streaming");
              setStatusMessage(`Live ${msg.lens || targetLens} camera active`);
              if (msg.lens) setLens(msg.lens);
            } else if (msg.status === "waiting_device") {
              setStatus("waiting_device");
              setStatusMessage("Waiting for device camera stream...");
            } else if (msg.status === "device_stopped") {
              setStatus("stopped");
              setStatusMessage("Device stopped camera stream");
            }
          } else if (msg.type === "lens_switched") {
            setLens(msg.lens);
            setStatusMessage(`Switched to ${msg.lens} camera`);
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
        // 0x02: Audio PCM 16kHz mono chunk
        // 0xFF, 0xD8: Legacy raw JPEG frame
        if (bytes[0] === 0x01 || (bytes[0] === 0xff && bytes[1] === 0xd8)) {
          const jpegBytes = bytes[0] === 0x01 ? bytes.subarray(1) : bytes;
          latestFrameRef.current = jpegBytes;
          if (!isRenderingRef.current) {
            renderNextFrame();
          }

          frameCountRef.current += 1;
          frameTimestampsRef.current.push(Date.now());
        } else if (bytes[0] === 0x02) {
          setHasAudioStream(true);
          playPcmAudio(bytes.subarray(1));
        }
      }
    };

    ws.onerror = (err) => {
      console.error("Camera stream WebSocket error:", err);
      if (!isMountedRef.current) return;
      setStatus("error");
      setStatusMessage("Connection error with camera relay. Check network connection.");
    };

    ws.onclose = (event) => {
      if (!isMountedRef.current) return;
      if (status !== "stopped") {
        if (event.code !== 1000 && event.code !== 1005) {
          setStatus("error");
          setStatusMessage(`Relay connection closed (${event.code}). Click 'Restart Stream' below.`);
        } else {
          setStatus("stopped");
          setStatusMessage("Camera stream session closed.");
        }
      }
    };
  };

  const handleSwitchLens = (newLens: "front" | "back") => {
    if (lens === newLens) return;
    setLens(newLens);
    setStatusMessage(`Switching to ${newLens} camera...`);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: "switch_lens", lens: newLens }));
    }

    devicesApi
      .createCommand(deviceId, "camera_stream", { action: "start", lens: newLens })
      .catch((e) => console.warn("Failed to send switch lens command:", e));
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
    setStatusMessage("Camera stream stopped.");

    if (sendRemoteCommand) {
      devicesApi
        .createCommand(deviceId, "camera_stream", { action: "stop" })
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
      a.download = `spapp-camera-${lens}-${deviceName || deviceId}-${dateStr}.jpg`;
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

  const handlePopOut = () => {
    if (onPopOut) {
      onPopOut();
      return;
    }
    const width = 640;
    const height = 820;
    const left = window.screen.width / 2 - width / 2;
    const top = window.screen.height / 2 - height / 2;
    window.open(
      `/devices/${deviceId}/camera-stream?lens=${lens}`,
      `camera_stream_${deviceId}`,
      `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no`
    );
  };

  useEffect(() => {
    isMountedRef.current = true;
    startStream(initialLens);

    return () => {
      isMountedRef.current = false;
      stopStream(true);
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col bg-slate-950 text-slate-100 ${
        isStandalone ? "w-full max-w-2xl h-screen" : "w-full h-full min-h-[440px]"
      } select-none`}
    >
      {/* Top Header Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900/90 border-b border-slate-800 text-xs backdrop-blur-sm z-20">
        <div className="flex items-center gap-2.5">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              status === "streaming"
                ? "bg-red-500 animate-pulse"
                : status === "connecting_ws" || status === "waiting_device"
                ? "bg-amber-400 animate-bounce"
                : "bg-slate-500"
            }`}
          />
          <span className="font-semibold text-slate-200">
            {deviceName ? `${deviceName}` : "Camera Feed"}
          </span>

          {/* Lens Badge */}
          <span className="px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
            {lens} camera
          </span>

          {status === "streaming" && (
            <span className="text-[11px] font-mono text-slate-400">
              {formatDuration(streamDuration)}
            </span>
          )}
        </div>

        {/* Lens Switch Controls */}
        <div className="flex items-center gap-1 bg-slate-800/80 p-0.5 rounded-lg border border-slate-700/60">
          <button
            onClick={() => handleSwitchLens("front")}
            disabled={status !== "streaming" && status !== "waiting_device"}
            className={`px-2 py-1 text-[11px] rounded transition font-medium ${
              lens === "front"
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Switch to Front Selfie Camera"
          >
            Front
          </button>
          <button
            onClick={() => handleSwitchLens("back")}
            disabled={status !== "streaming" && status !== "waiting_device"}
            className={`px-2 py-1 text-[11px] rounded transition font-medium ${
              lens === "back"
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Switch to Rear Main Camera"
          >
            Back
          </button>
        </div>

        {/* Action icons */}
        <div className="flex items-center gap-1.5">
          {hasAudioStream && (
            <button
              onClick={() => setIsMuted((prev) => !prev)}
              className={`p-1.5 rounded hover:bg-slate-800 transition ${
                isMuted ? "text-amber-400" : "text-emerald-400"
              }`}
              title={isMuted ? "Unmute audio" : "Mute audio"}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isMuted ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15zM17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                )}
              </svg>
            </button>
          )}

          <button
            onClick={handleSnapshot}
            disabled={!hasFirstFrame}
            className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition disabled:opacity-40"
            title="Take snapshot"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {!isStandalone && (
            <button
              onClick={handlePopOut}
              className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
              title="Open in new window"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
          )}

          <button
            onClick={toggleFullscreen}
            className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
            title="Toggle fullscreen"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isFullscreen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              )}
            </svg>
          </button>

          {onClose && (
            <button
              onClick={() => {
                stopStream(true);
                onClose();
              }}
              className="p-1.5 rounded hover:bg-red-950/80 text-slate-400 hover:text-red-400 transition"
              title="Close live stream"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Main View Area */}
      <div className="relative flex-1 flex items-center justify-center bg-black overflow-hidden min-h-[360px]">
        <canvas
          ref={canvasRef}
          className={`max-h-full max-w-full object-contain pointer-events-none select-none transition-opacity duration-200 ${
            hasFirstFrame ? "opacity-100" : "hidden opacity-0"
          }`}
          style={{
            transform: lens === "front" ? "scaleX(-1)" : "none", // mirror front camera feed like a selfie preview
          }}
        />

        {!hasFirstFrame && (
          <div className="flex flex-col items-center justify-center p-6 text-center text-slate-400 max-w-xs">
            {status === "error" ? (
              <div className="w-12 h-12 rounded-full bg-red-950/60 border border-red-800 flex items-center justify-center mb-3 text-red-400">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
            ) : (
              <div className="relative w-12 h-12 rounded-full border-2 border-indigo-500/30 border-t-indigo-500 animate-spin mb-3" />
            )}
            <p className="text-xs font-medium text-slate-300 mb-1">{statusMessage}</p>
            <p className="text-[11px] text-slate-500">
              {status === "error"
                ? "Ensure camera permission is granted on the device."
                : `Waiting for ${lens} camera frame transmission...`}
            </p>

            {status === "error" && (
              <button
                onClick={() => startStream(lens)}
                className="mt-4 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-medium transition"
              >
                Restart Stream
              </button>
            )}
          </div>
        )}

        {/* Live Overlay Indicators */}
        {status === "streaming" && (
          <div className="absolute top-3 left-3 flex items-center gap-2 pointer-events-none z-10">
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-600/90 text-white font-bold text-[10px] uppercase tracking-wider backdrop-blur-sm shadow">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
              LIVE
            </span>
            <span className="px-2 py-0.5 rounded bg-black/60 text-slate-300 font-mono text-[10px] backdrop-blur-sm border border-white/10">
              {fps} FPS
            </span>
          </div>
        )}
      </div>

      {/* Footer Controls & Diagnostics */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-t border-slate-800 text-[11px] text-slate-400">
        <div className="flex items-center gap-4">
          <span>Frames: <strong className="text-slate-200">{frameCount}</strong></span>
          <span>Status: <strong className="text-slate-200 capitalize">{status}</strong></span>
        </div>

        <div className="flex items-center gap-2">
          {status === "streaming" ? (
            <button
              onClick={() => stopStream(true)}
              className="px-2.5 py-1 bg-red-600/90 hover:bg-red-500 text-white rounded text-[11px] font-semibold transition"
            >
              Stop Stream
            </button>
          ) : (
            <button
              onClick={() => startStream(lens)}
              className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[11px] font-semibold transition"
            >
              Start Stream
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
