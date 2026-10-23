import { useState } from "react";
import ScreenStreamView from "./ScreenStreamView";

interface ScreenStreamCardProps {
  deviceId: string;
  deviceName?: string;
  isActive?: boolean;
  onToggleActive?: (active: boolean) => void;
}

export default function ScreenStreamCard({
  deviceId,
  deviceName,
  isActive: externalActive,
  onToggleActive,
}: ScreenStreamCardProps) {
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
        id="live-screen-card"
        className="bg-slate-950 rounded-xl shadow-lg border border-slate-800 overflow-hidden flex flex-col transition-all duration-300"
      >
        <ScreenStreamView
          deviceId={deviceId}
          deviceName={deviceName}
          isStandalone={false}
          onClose={() => setActive(false)}
        />
      </div>
    );
  }

  return (
    <div
      id="live-screen-card"
      className="bg-white rounded-xl shadow-sm p-5 border border-slate-100 flex flex-col justify-between transition-all duration-300"
    >
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
            <h2 className="font-semibold text-sm text-slate-800">Live Screen Stream</h2>
          </div>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-500 uppercase tracking-wider">
            Standby
          </span>
        </div>

        <div className="flex flex-col items-center justify-center p-8 text-center bg-slate-50/80 rounded-xl border border-dashed border-slate-200 my-2">
          <div className="w-12 h-12 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center mb-3">
            <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
              />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-slate-800 mb-1">Silent Screen Stream</h3>
          <p className="text-xs text-slate-500 max-w-sm leading-relaxed mb-4">
            Stream real-time display frames directly in this dashboard without any popups, microphone usage, or alerts on the device.
          </p>
          <button
            onClick={() => setActive(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-semibold rounded-lg shadow-sm hover:shadow transition"
          >
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            <span>Start Live Screen</span>
          </button>
        </div>
      </div>

      <p className="text-[11px] text-slate-400 mt-3 text-center">
        💡 Requires SPApp Accessibility Service to be active on the target phone.
      </p>
    </div>
  );
}
