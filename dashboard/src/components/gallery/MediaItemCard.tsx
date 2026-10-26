import React from "react";
import type { MediaItem } from "./types";
import { formatBytes } from "./types";

interface MediaItemCardProps {
  item: MediaItem;
  onPreview: (item: MediaItem) => void;
  onDownload: (item: MediaItem) => void;
  isDownloading?: boolean;
}

export const MediaItemCard: React.FC<MediaItemCardProps> = ({
  item,
  onPreview,
  onDownload,
  isDownloading = false,
}) => {
  const categoryIcon = item.isVideo
    ? "🎬"
    : item.category === "whatsapp"
    ? "💬"
    : item.category === "screenshots"
    ? "📸"
    : item.category === "camera"
    ? "📷"
    : "📁";

  return (
    <div
      className="group relative flex flex-col rounded-xl overflow-hidden bg-slate-900 border border-slate-800 hover:border-emerald-500/60 shadow-sm hover:shadow-lg transition-all duration-200 text-left"
    >
      {/* 1. Thumbnail / Visual Frame */}
      <div
        onClick={() => onPreview(item)}
        className="relative w-full aspect-square sm:aspect-[4/3] bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center cursor-pointer overflow-hidden"
      >
        {item.previewUrl ? (
          item.isVideo ? (
            <div className="relative w-full h-full">
              <video
                src={item.previewUrl}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                <span className="w-10 h-10 rounded-full bg-emerald-500/90 text-white flex items-center justify-center shadow-lg">
                  ▶
                </span>
              </div>
            </div>
          ) : (
            <img
              src={item.previewUrl}
              alt={item.name}
              loading="lazy"
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />
          )
        ) : (
          <div className="flex flex-col items-center justify-center p-4 text-center">
            <span className="text-3xl mb-1 opacity-80 group-hover:scale-110 transition-transform">
              {categoryIcon}
            </span>
            <span className="text-[11px] font-mono text-slate-400 uppercase tracking-wider font-semibold">
              {item.extension || "FILE"}
            </span>
          </div>
        )}

        {/* Top Badges */}
        <div className="absolute top-2 left-2 flex items-center gap-1.5 z-10">
          <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-black/60 backdrop-blur-md text-emerald-400 border border-white/10 uppercase tracking-wider">
            {item.extension || "MEDIA"}
          </span>
          {item.isVideo && (
            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-purple-900/70 backdrop-blur-md text-purple-200 border border-purple-500/30">
              VIDEO
            </span>
          )}
        </div>

        {/* Interactive Hover Overlay */}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-gradient-to-t from-black/90 via-black/40 to-black/60 flex flex-col justify-between p-3 z-20">
          <div className="flex justify-end">
            <span className="text-[11px] font-mono text-slate-300 bg-black/60 px-2 py-0.5 rounded backdrop-blur-xs">
              {formatBytes(item.sizeBytes)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPreview(item);
              }}
              className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-1.5 px-2 rounded-lg shadow-md transition active:scale-95"
            >
              <span>👁️</span>
              <span>Preview</span>
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDownload(item);
              }}
              disabled={isDownloading}
              className="p-1.5 bg-white/10 hover:bg-white/20 text-white rounded-lg border border-white/20 transition active:scale-95 disabled:opacity-50"
              title="Download asset"
            >
              {isDownloading ? (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* 2. Bottom File Meta Caption */}
      <div className="p-2.5 bg-slate-900 border-t border-slate-800/80">
        <p className="text-xs font-medium text-slate-200 truncate" title={item.name}>
          {item.name}
        </p>
        <div className="flex items-center justify-between mt-1 text-[11px] text-slate-400">
          <span>{formatBytes(item.sizeBytes)}</span>
          <span className="capitalize text-slate-500">{item.category}</span>
        </div>
      </div>
    </div>
  );
};
