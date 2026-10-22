import { useEffect, useState } from "react";
import AudioStreamView from "./AudioStreamView";
import { devicesApi } from "../api/devices";
import { API_BASE_URL } from "../api/client";
import type { AudioRecording } from "../api/types";

interface AudioStreamCardProps {
  deviceId: string;
  deviceName?: string;
  isActive?: boolean;
  onToggleActive?: (active: boolean) => void;
}

export default function AudioStreamCard({
  deviceId,
  deviceName,
  isActive: externalActive,
  onToggleActive,
}: AudioStreamCardProps) {
  const [internalActive, setInternalActive] = useState(false);
  const [recordings, setRecordings] = useState<AudioRecording[]>([]);
  const [loadingRecordings, setLoadingRecordings] = useState(false);
  const [token, setToken] = useState("");

  const isControlled = externalActive !== undefined;
  const active = isControlled ? externalActive : internalActive;

  useEffect(() => {
    const t = localStorage.getItem("spapp_token") || "";
    setToken(t);
  }, []);

  const loadRecordings = async () => {
    setLoadingRecordings(true);
    try {
      const list = await devicesApi.listAudioRecordings(deviceId);
      setRecordings(list);
    } catch (err) {
      console.warn("Failed to load recordings in card:", err);
    } finally {
      setLoadingRecordings(false);
    }
  };

  useEffect(() => {
    if (!active) {
      loadRecordings();
    }
  }, [deviceId, active]);

  const handleDeleteRecording = async (recId: string) => {
    if (!confirm("Are you sure you want to delete this audio recording?")) return;
    try {
      await devicesApi.deleteAudioRecording(deviceId, recId);
      setRecordings((prev) => prev.filter((r) => r.id !== recId));
    } catch {
      alert("Failed to delete recording");
    }
  };

  const setActive = (val: boolean) => {
    if (isControlled && onToggleActive) {
      onToggleActive(val);
    } else {
      setInternalActive(val);
    }
  };

  if (active) {
    return (
      <div
        id="live-audio-card"
        className="bg-slate-950 rounded-xl shadow-lg border border-slate-800 overflow-hidden flex flex-col transition-all duration-300"
      >
        <AudioStreamView
          deviceId={deviceId}
          deviceName={deviceName}
          onClose={() => setActive(false)}
        />
      </div>
    );
  }

  return (
    <div
      id="live-audio-card"
      className="bg-white rounded-xl shadow-sm p-5 border border-slate-100 flex flex-col justify-between transition-all duration-300"
    >
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
            <h2 className="font-semibold text-sm text-slate-800">Live Surrounding Audio</h2>
          </div>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-500 uppercase tracking-wider">
            Standby
          </span>
        </div>

        <div className="flex flex-col items-center justify-center p-8 text-center bg-slate-50/80 rounded-xl border border-dashed border-slate-200 my-2">
          <div className="w-12 h-12 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-3">
            <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
              />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-slate-800 mb-1">Live Surrounding / Ambient Sound</h3>
          <p className="text-xs text-slate-500 max-w-sm leading-relaxed mb-4">
            Listen to the device's real-time surroundings using dual-microphone binaural stereo with raw whisper gain amplification.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-2 mb-5 max-w-sm">
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
              🎙️ Binaural 360° Stereo
            </span>
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200">
              ⚡ 5x Whisper Amplifier
            </span>
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
              ⏱️ &lt;100ms Real-Time
            </span>
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">
              🎵 MP3 Audio Record & Save
            </span>
          </div>

          <div className="w-full max-w-xs">
            <button
              id="start-live-audio-btn"
              onClick={() => setActive(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gradient-to-r from-amber-600 via-orange-600 to-rose-600 hover:from-amber-500 hover:to-rose-500 text-white text-xs font-semibold rounded-lg shadow-sm hover:shadow transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              </svg>
              <span>Start Live Listening</span>
            </button>
          </div>
        </div>

        {/* Saved MP3 Recordings History */}
        {recordings.length > 0 && (
          <div className="mt-5 pt-4 border-t border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-amber-600 font-bold">🎵</span>
                <h4 className="font-semibold text-xs text-slate-800 uppercase tracking-wide">
                  Saved Audio Recordings (.MP3)
                </h4>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                  {recordings.length}
                </span>
              </div>
              <button
                onClick={loadRecordings}
                disabled={loadingRecordings}
                className="text-[11px] text-slate-500 hover:text-amber-700 transition font-mono"
              >
                {loadingRecordings ? "Refreshing..." : "↻ Refresh"}
              </button>
            </div>

            <div className="flex flex-col gap-2 max-h-60 overflow-y-auto pr-1">
              {recordings.map((rec) => {
                const streamUrl = `${API_BASE_URL}/api/devices/${deviceId}/audio-recordings/${rec.id}/stream?token=${encodeURIComponent(token)}`;
                const downloadUrl = `${API_BASE_URL}/api/devices/${deviceId}/audio-recordings/${rec.id}/download?token=${encodeURIComponent(token)}`;
                const dateStr = new Date(rec.created_at).toLocaleString();
                const sizeKb = (rec.file_size_bytes / 1024).toFixed(1);

                return (
                  <div
                    key={rec.id}
                    className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 hover:border-slate-300 transition flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 text-xs"
                  >
                    <div className="flex flex-col gap-0.5 min-w-[150px]">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-800 font-mono text-[11px] truncate max-w-[180px]" title={rec.filename}>
                          {rec.filename}
                        </span>
                        <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-amber-100 text-amber-700 font-semibold">
                          MP3
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
                        <span>{dateStr}</span>
                        <span>•</span>
                        <span>{rec.duration_seconds}s</span>
                        <span>•</span>
                        <span>{sizeKb} KB</span>
                      </div>
                    </div>

                    <div className="w-full sm:w-auto flex flex-wrap items-center gap-2">
                      <audio
                        controls
                        preload="none"
                        src={streamUrl}
                        className="h-7 max-w-full sm:max-w-[200px]"
                      />

                      <a
                        href={downloadUrl}
                        download={rec.filename}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 bg-amber-600 hover:bg-amber-700 text-white px-2.5 py-1 rounded text-xs font-semibold shadow-sm transition"
                        title="Download .MP3 directly to device"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        <span>Download .MP3</span>
                      </a>

                      <button
                        onClick={() => handleDeleteRecording(rec.id)}
                        className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition"
                        title="Delete recording"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-400 mt-3 text-center">
        💡 Streams raw ambient audio without activating camera or turning on target phone screen.
      </p>
    </div>
  );
}

