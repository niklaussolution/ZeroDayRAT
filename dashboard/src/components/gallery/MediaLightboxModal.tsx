import React, { useEffect, useState } from "react";
import type { MediaItem } from "./types";
import { formatBytes } from "./types";

interface MediaLightboxModalProps {
  item: MediaItem | null;
  items: MediaItem[];
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (newItem: MediaItem) => void;
  onDownload: (item: MediaItem) => void;
  isLoadingMedia?: boolean;
  statusMessage?: string | null;
}

export const MediaLightboxModal: React.FC<MediaLightboxModalProps> = ({
  item,
  items,
  isOpen,
  onClose,
  onNavigate,
  onDownload,
  isLoadingMedia = false,
  statusMessage = null,
}) => {
  const [zoom, setZoom] = useState(false);
  const [copied, setCopied] = useState(false);

  const currentIndex = item ? items.findIndex((i) => i.id === item.id) : -1;
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < items.length - 1;

  // Keyboard navigation & Esc listener
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" && hasPrevious) {
        onNavigate(items[currentIndex - 1]);
        setZoom(false);
      } else if (e.key === "ArrowRight" && hasNext) {
        onNavigate(items[currentIndex + 1]);
        setZoom(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, hasPrevious, hasNext, currentIndex, items, onClose, onNavigate]);

  if (!isOpen || !item) return null;

  function copyPath() {
    if (!item) return;
    navigator.clipboard.writeText(item.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Media Preview Lightbox"
      className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 backdrop-blur-md text-white select-none transition-all duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 1. Header Toolbar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-black/40">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xl">
            {item.isVideo ? "🎬" : item.category === "whatsapp" ? "💬" : "📷"}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-100 truncate max-w-md sm:max-w-xl">
              {item.name}
            </h3>
            <p className="text-xs text-gray-400 flex items-center gap-2">
              <span>{formatBytes(item.sizeBytes)}</span>
              <span>·</span>
              <span className="uppercase text-[10px] tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-gray-300 font-mono">
                {item.extension || item.mimeType}
              </span>
              <span>·</span>
              <span className="capitalize text-emerald-400 font-medium">
                {item.category}
              </span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {currentIndex >= 0 && (
            <span className="hidden sm:inline text-xs text-gray-400 font-mono px-2.5 py-1 rounded bg-white/5 border border-white/10">
              {currentIndex + 1} / {items.length}
            </span>
          )}

          <button
            type="button"
            onClick={() => onDownload(item)}
            className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium px-3.5 py-1.5 rounded-lg shadow-sm transition active:scale-95"
            title="Download this file to your computer"
          >
            <span>⬇</span>
            <span className="hidden sm:inline">Download</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition"
            title="Close (Esc)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 2. Main Stage Content */}
      <div className="relative flex-1 flex items-center justify-center p-4 sm:p-8 overflow-hidden">
        {/* Navigation Arrows */}
        {hasPrevious && (
          <button
            type="button"
            onClick={() => {
              onNavigate(items[currentIndex - 1]);
              setZoom(false);
            }}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full bg-black/60 hover:bg-emerald-600 text-white/80 hover:text-white border border-white/15 backdrop-blur-sm transition-all hover:scale-110 active:scale-95 shadow-lg"
            title="Previous (Left Arrow)"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}

        {hasNext && (
          <button
            type="button"
            onClick={() => {
              onNavigate(items[currentIndex + 1]);
              setZoom(false);
            }}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full bg-black/60 hover:bg-emerald-600 text-white/80 hover:text-white border border-white/15 backdrop-blur-sm transition-all hover:scale-110 active:scale-95 shadow-lg"
            title="Next (Right Arrow)"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        {/* Media Renderer / Loading States */}
        {isLoadingMedia ? (
          <div className="flex flex-col items-center justify-center gap-4 text-center p-8 bg-black/40 rounded-2xl border border-white/10 max-w-sm">
            <div className="relative w-14 h-14">
              <div className="absolute inset-0 rounded-full border-4 border-emerald-500/20 animate-ping" />
              <div className="w-14 h-14 rounded-full border-4 border-emerald-500 border-t-transparent animate-spin" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-200">
                Streaming Media from Device
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {statusMessage || "Relaying bytes via high-speed WebSocket..."}
              </p>
            </div>
          </div>
        ) : item.previewUrl ? (
          <div className="flex items-center justify-center max-w-full max-h-full">
            {item.isVideo ? (
              <video
                src={item.previewUrl}
                controls
                autoPlay
                className="max-h-[75vh] max-w-full rounded-xl shadow-2xl border border-white/10 outline-none"
              >
                Your browser does not support the video tag.
              </video>
            ) : (
              <img
                src={item.previewUrl}
                alt={item.name}
                onClick={() => setZoom(!zoom)}
                className={`transition-transform duration-200 rounded-xl shadow-2xl border border-white/10 object-contain cursor-zoom-in ${
                  zoom
                    ? "scale-150 cursor-zoom-out"
                    : "max-h-[75vh] max-w-full"
                }`}
              />
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 text-center p-8 bg-black/40 rounded-2xl border border-white/10 max-w-md">
            <span className="text-5xl mb-1">🖼️</span>
            <p className="text-sm font-semibold text-gray-200">
              High-Resolution Preview Ready
            </p>
            <p className="text-xs text-gray-400">
              Click below to stream and render this media file on-demand.
            </p>
            <button
              type="button"
              onClick={() => onNavigate(item)}
              className="mt-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-sm transition active:scale-95"
            >
              Load Full Preview Now
            </button>
          </div>
        )}
      </div>

      {/* 3. Footer Bar / Metadata info */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 border-t border-white/10 bg-black/60 text-xs text-gray-400">
        <div className="flex items-center gap-2 max-w-md truncate">
          <span className="text-gray-500">Device Path:</span>
          <code className="text-[11px] font-mono text-emerald-300 bg-white/5 px-2 py-0.5 rounded truncate">
            {item.path}
          </code>
          <button
            type="button"
            onClick={copyPath}
            className="text-[11px] text-gray-400 hover:text-white underline ml-1"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>

        <div className="flex items-center gap-4">
          {item.previewUrl && (
            <a
              href={item.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="text-gray-300 hover:text-white hover:underline flex items-center gap-1"
            >
              <span>Open in new tab</span>
              <span>↗</span>
            </a>
          )}
          <span className="text-gray-500">
            Use <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-[10px]">←</kbd> /{" "}
            <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-[10px]">→</kbd> to browse
          </span>
        </div>
      </div>
    </div>
  );
};
