import { useState } from "react";
import AudioStreamView from "./AudioStreamView";

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

  const isControlled = externalActive !== undefined;
  const active = isControlled ? externalActive : internalActive;

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
              💾 WAV Snippet Record
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
      </div>

      <p className="text-[11px] text-slate-400 mt-3 text-center">
        💡 Streams raw ambient audio without activating camera or turning on target phone screen.
      </p>
    </div>
  );
}
