import { useEffect, useRef, useState } from "react";
import { WS_BASE_URL } from "../api/client";
import { devicesApi } from "../api/devices";

interface RemoteControlCardProps {
  deviceId: string;
  deviceName?: string;
  isStreamActive?: boolean;
  onStartStream?: () => void;
}

interface ActionLogEntry {
  id: string;
  timestamp: string;
  type: "key" | "tap" | "swipe" | "text";
  details: string;
  channel: "WebSocket (0ms)" | "HTTP Command Queue";
  status: "dispatched" | "delivered" | "failed";
}

export default function RemoteControlCard({
  deviceId,
  deviceName,
  isStreamActive = false,
  onStartStream,
}: RemoteControlCardProps) {
  const [lastActionStatus, setLastActionStatus] = useState<string | null>(null);
  const [actionLogs, setActionLogs] = useState<ActionLogEntry[]>([]);
  const [inputText, setInputText] = useState("");
  const [pressEnterOnSend, setPressEnterOnSend] = useState(false);
  const [channelMode, setChannelMode] = useState<"auto" | "command">("auto");
  const [isWsConnected, setIsWsConnected] = useState<boolean>(false);

  const wsRef = useRef<WebSocket | null>(null);

  // Maintain real-time WebSocket connection to screen relay for 0ms command execution
  useEffect(() => {
    const token = localStorage.getItem("spapp_token") || "";
    if (!token || !deviceId) return;

    let ws: WebSocket | null = null;
    let shouldReconnect = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!shouldReconnect) return;
      try {
        const wsUrl = `${WS_BASE_URL}/ws/screen-stream?role=admin&token=${encodeURIComponent(
          token
        )}&deviceId=${encodeURIComponent(deviceId)}`;
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setIsWsConnected(true);
        };

        ws.onclose = () => {
          setIsWsConnected(false);
          if (shouldReconnect) {
            reconnectTimer = setTimeout(connect, 2500);
          }
        };

        ws.onerror = () => {
          setIsWsConnected(false);
        };
      } catch (err) {
        console.warn("RemoteControlCard WS init error:", err);
      }
    };

    connect();

    return () => {
      shouldReconnect = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {}
      }
      wsRef.current = null;
    };
  }, [deviceId]);

  // Coordinate tester state
  const [testTapX, setTestTapX] = useState<number>(50);
  const [testTapY, setTestTapY] = useState<number>(50);
  const [testDuration, setTestDuration] = useState<number>(100);

  const addLog = (
    type: "key" | "tap" | "swipe" | "text",
    details: string,
    channel: "WebSocket (0ms)" | "HTTP Command Queue",
    status: "dispatched" | "delivered" | "failed"
  ) => {
    const entry: ActionLogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString(),
      type,
      details,
      channel,
      status,
    };
    setActionLogs((prev) => [entry, ...prev.slice(0, 14)]);
  };

  const dispatchAction = async (payload: Record<string, unknown>, label: string) => {
    let sentWs = false;

    // Fast 0ms WebSocket execution
    if (channelMode !== "command" && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        const msg = JSON.stringify({
          action: "remote_input",
          ...payload,
        });
        wsRef.current.send(msg);
        sentWs = true;
        setLastActionStatus(`Executed (0ms): ${label}`);
        addLog((payload.type as ActionLogEntry["type"]) || "key", label, "WebSocket (0ms)", "delivered");
      } catch (err) {
        console.warn("WebSocket dispatch failed, falling back to command queue:", err);
      }
    }

    // Reliable fallback via HTTP Command Queue
    if (!sentWs) {
      setLastActionStatus(`Queueing: ${label}...`);
      try {
        await devicesApi.createCommand(deviceId, "remote_action", payload);
        setLastActionStatus(`Queued: ${label}`);
        addLog((payload.type as ActionLogEntry["type"]) || "key", label, "HTTP Command Queue", "dispatched");
      } catch (err) {
        console.error("Remote action error:", err);
        setLastActionStatus(`Error: Failed ${label}`);
        addLog((payload.type as ActionLogEntry["type"]) || "key", label, "HTTP Command Queue", "failed");
      }
    }

    setTimeout(() => {
      setLastActionStatus((prev) => (prev?.startsWith("Executed") || prev?.startsWith("Queued") ? null : prev));
    }, 2500);
  };

  // Nav actions
  const handleKey = (key: "BACK" | "HOME" | "RECENTS" | "NOTIFICATIONS" | "QUICK_SETTINGS" | "LOCK_SCREEN", name: string) => {
    dispatchAction({ type: "key", key }, `Key: ${name}`);
  };

  // Directional scroll / swipe
  const handleScroll = (dir: "UP" | "DOWN" | "LEFT" | "RIGHT") => {
    let startX = 0.5, startY = 0.5, endX = 0.5, endY = 0.5;
    if (dir === "UP") {
      startY = 0.75;
      endY = 0.25;
    } else if (dir === "DOWN") {
      startY = 0.25;
      endY = 0.75;
    } else if (dir === "LEFT") {
      startX = 0.8;
      endX = 0.2;
    } else if (dir === "RIGHT") {
      startX = 0.2;
      endX = 0.8;
    }
    dispatchAction(
      {
        type: "swipe",
        startX,
        startY,
        endX,
        endY,
        duration: 350,
      },
      `Scroll ${dir}`
    );
  };

  // Tap center
  const handleTapCenter = () => {
    dispatchAction({ type: "tap", x: 0.5, y: 0.5, duration: 100 }, "Tap Screen Center");
  };

  // Text send
  const handleSendText = () => {
    if (!inputText.trim()) return;
    const text = inputText;
    dispatchAction(
      {
        type: "text",
        text,
        pressEnter: pressEnterOnSend,
      },
      `Type: "${text.length > 15 ? text.substring(0, 15) + "..." : text}"`
    );
    setInputText("");
  };

  // Coordinate tester tap
  const handleCustomTap = () => {
    const x = Math.min(100, Math.max(0, testTapX)) / 100;
    const y = Math.min(100, Math.max(0, testTapY)) / 100;
    dispatchAction({ type: "tap", x, y, duration: testDuration }, `Precision Tap (${testTapX}%, ${testTapY}%)`);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden flex flex-col transition-all">
      {/* Top Header Bar */}
      <div className="px-5 py-4 bg-slate-950/80 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-sky-600 flex items-center justify-center text-white shadow-md shadow-indigo-950">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white tracking-tight">Remote Control Station</h2>
              {isWsConnected ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950 text-emerald-400 border border-emerald-700/60 flex items-center gap-1 shadow-sm">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Instant Pipe (0ms)
                </span>
              ) : isStreamActive ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-950 text-sky-400 border border-sky-700/60 flex items-center gap-1">
                  Connecting...
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-950/80 text-amber-400 border border-amber-800/60 flex items-center gap-1">
                  Queue Mode
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              {deviceName || "Target Device"} · Real-time Input Injection
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {lastActionStatus && (
            <span className="text-xs font-mono font-medium px-2.5 py-1 rounded-lg bg-sky-950 text-sky-300 border border-sky-800 animate-pulse">
              {lastActionStatus}
            </span>
          )}
          {!isStreamActive && onStartStream && (
            <button
              onClick={onStartStream}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition shadow-sm"
            >
              View Screen
            </button>
          )}
        </div>
      </div>

      <div className="p-5 flex flex-col gap-5">
        {/* Hardware Navigation & System Action Controls */}
        <div>
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2 px-1">
            System Keys & Navigation
          </span>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            <button
              onClick={() => handleKey("BACK", "Back")}
              className="flex flex-col items-center justify-center gap-1.5 py-3 px-2 rounded-xl bg-slate-950/70 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 active:scale-95 text-slate-200 transition group shadow-sm"
            >
              <div className="w-7 h-7 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 group-hover:scale-110 transition">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                </svg>
              </div>
              <span className="text-[11px] font-semibold">Back</span>
            </button>

            <button
              onClick={() => handleKey("HOME", "Home")}
              className="flex flex-col items-center justify-center gap-1.5 py-3 px-2 rounded-xl bg-slate-950/70 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 active:scale-95 text-slate-200 transition group shadow-sm"
            >
              <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 group-hover:scale-110 transition">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                </svg>
              </div>
              <span className="text-[11px] font-semibold">Home</span>
            </button>

            <button
              onClick={() => handleKey("RECENTS", "Recents")}
              className="flex flex-col items-center justify-center gap-1.5 py-3 px-2 rounded-xl bg-slate-950/70 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 active:scale-95 text-slate-200 transition group shadow-sm"
            >
              <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 group-hover:scale-110 transition">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </div>
              <span className="text-[11px] font-semibold">Recents</span>
            </button>

            <button
              onClick={() => handleKey("NOTIFICATIONS", "Alerts")}
              className="flex flex-col items-center justify-center gap-1.5 py-3 px-2 rounded-xl bg-slate-950/70 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 active:scale-95 text-slate-200 transition group shadow-sm"
            >
              <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 group-hover:scale-110 transition">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              </div>
              <span className="text-[11px] font-semibold">Alerts</span>
            </button>

            <button
              onClick={() => handleKey("QUICK_SETTINGS", "Settings")}
              className="flex flex-col items-center justify-center gap-1.5 py-3 px-2 rounded-xl bg-slate-950/70 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 active:scale-95 text-slate-200 transition group shadow-sm"
            >
              <div className="w-7 h-7 rounded-lg bg-teal-500/10 border border-teal-500/20 flex items-center justify-center text-teal-400 group-hover:scale-110 transition">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <span className="text-[11px] font-semibold">Settings</span>
            </button>

            <button
              onClick={() => handleKey("LOCK_SCREEN", "Lock")}
              className="flex flex-col items-center justify-center gap-1.5 py-3 px-2 rounded-xl bg-slate-950/70 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 active:scale-95 text-slate-200 transition group shadow-sm"
            >
              <div className="w-7 h-7 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 group-hover:scale-110 transition">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <span className="text-[11px] font-semibold">Lock</span>
            </button>
          </div>
        </div>

        {/* 2-Column Section: D-Pad Directional Controller & Remote Keyboard */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Directional Pad */}
          <div className="bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80 flex flex-col items-center justify-center">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3">
              Directional Navigation & Scroll
            </span>

            <div className="flex flex-col items-center gap-2">
              <button
                onClick={() => handleScroll("UP")}
                title="Scroll Content Upward"
                className="w-28 py-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5 border border-slate-700 shadow-sm transition"
              >
                <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
                </svg>
                <span>Scroll Up</span>
              </button>

              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => handleScroll("LEFT")}
                  title="Swipe Left"
                  className="w-24 py-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1 border border-slate-700 shadow-sm transition"
                >
                  <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                  </svg>
                  <span>Left</span>
                </button>

                <button
                  onClick={handleTapCenter}
                  title="Tap Screen Center"
                  className="w-20 py-2.5 rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 active:scale-90 text-white text-xs font-extrabold shadow-lg shadow-sky-950 transition flex items-center justify-center"
                >
                  <span>TAP</span>
                </button>

                <button
                  onClick={() => handleScroll("RIGHT")}
                  title="Swipe Right"
                  className="w-24 py-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1 border border-slate-700 shadow-sm transition"
                >
                  <span>Right</span>
                  <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>

              <button
                onClick={() => handleScroll("DOWN")}
                title="Scroll Content Downward"
                className="w-28 py-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5 border border-slate-700 shadow-sm transition"
              >
                <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
                <span>Scroll Down</span>
              </button>
            </div>
          </div>

          {/* Remote Keyboard */}
          <div className="bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80 flex flex-col justify-between">
            <div>
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                Remote Keyboard & Input
              </span>

              <div className="flex flex-col gap-2.5">
                <div className="relative">
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSendText();
                    }}
                    placeholder="Type text to inject into phone input..."
                    className="w-full pl-9 pr-3 py-2.5 text-xs bg-slate-900 border border-slate-700 rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition"
                  />
                  <svg className="w-4 h-4 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18M7 6h10M7 18h10" />
                  </svg>
                </div>

                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={pressEnterOnSend}
                      onChange={(e) => setPressEnterOnSend(e.target.checked)}
                      className="rounded border-slate-700 text-sky-600 focus:ring-0 bg-slate-900 w-3.5 h-3.5"
                    />
                    <span>Submit (IME Enter)</span>
                  </label>

                  <button
                    onClick={handleSendText}
                    disabled={!inputText.trim()}
                    className="px-4 py-2 text-xs font-bold bg-sky-600 hover:bg-sky-500 active:scale-95 text-white rounded-xl shadow-md shadow-sky-950 transition disabled:opacity-40"
                  >
                    Inject Text
                  </button>
                </div>
              </div>
            </div>

            {/* Quick Text Chips */}
            <div className="mt-4 pt-3 border-t border-slate-800/80">
              <span className="text-[10px] text-slate-500 block mb-1.5 font-medium">Quick Insert:</span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {["Hello", "Test", "1234", "OK"].map((chip) => (
                  <button
                    key={chip}
                    onClick={() => {
                      setInputText(chip);
                    }}
                    className="px-2 py-0.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-medium border border-slate-700 transition"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Precision Coordinates & Gestures Lab */}
        <div className="bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
              Precision Coordinates Tester
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setTestTapX(50);
                  setTestTapY(15);
                }}
                className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
              >
                Top Bar (50%, 15%)
              </button>
              <button
                onClick={() => {
                  setTestTapX(50);
                  setTestTapY(50);
                }}
                className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
              >
                Center (50%, 50%)
              </button>
              <button
                onClick={() => {
                  setTestTapX(50);
                  setTestTapY(85);
                }}
                className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
              >
                Bottom (50%, 85%)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <div>
              <label className="text-[10px] text-slate-400 font-medium block mb-1">X Coord (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={testTapX}
                onChange={(e) => setTestTapX(Number(e.target.value))}
                className="w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-slate-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 font-medium block mb-1">Y Coord (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={testTapY}
                onChange={(e) => setTestTapY(Number(e.target.value))}
                className="w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-slate-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 font-medium block mb-1">Duration (ms)</label>
              <input
                type="number"
                min={40}
                max={1000}
                value={testDuration}
                onChange={(e) => setTestDuration(Number(e.target.value))}
                className="w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-slate-200"
              />
            </div>
            <button
              onClick={handleCustomTap}
              className="py-2 px-4 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white font-semibold text-xs rounded-lg shadow-sm transition"
            >
              Test Tap
            </button>
          </div>
        </div>

        {/* Activity & Execution Feed */}
        <div>
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
              Dispatched Command Logs
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500">Channel:</span>
              <button
                onClick={() => setChannelMode(channelMode === "auto" ? "command" : "auto")}
                className={`text-[10px] font-semibold px-2 py-0.5 rounded transition ${
                  channelMode === "auto"
                    ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                    : "bg-amber-950 text-amber-400 border border-amber-800"
                }`}
              >
                {channelMode === "auto" ? "Auto (Live WebSocket / Fallback Queue)" : "Force HTTP Command Queue"}
              </button>
              {actionLogs.length > 0 && (
                <button
                  onClick={() => setActionLogs([])}
                  className="text-[10px] text-slate-500 hover:text-slate-300 ml-2"
                >
                  Clear Logs
                </button>
              )}
            </div>
          </div>

          <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl max-h-40 overflow-y-auto">
            {actionLogs.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-5">
                No actions dispatched yet in this session.
              </p>
            ) : (
              <div className="divide-y divide-slate-800/60">
                {actionLogs.map((log) => (
                  <div key={log.id} className="px-3.5 py-2 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2.5">
                      <span className="font-mono text-[10px] text-slate-500">{log.timestamp}</span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-800 text-slate-300">
                        {log.type}
                      </span>
                      <span className="text-slate-200 font-medium">{log.details}</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400">{log.channel}</span>
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                          log.status === "dispatched"
                            ? "bg-emerald-950 text-emerald-400"
                            : "bg-rose-950 text-rose-400"
                        }`}
                      >
                        {log.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
