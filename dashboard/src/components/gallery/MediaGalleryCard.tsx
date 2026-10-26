import React, { useEffect, useMemo, useRef, useState } from "react";
import { devicesApi } from "../../api/devices";
import { downloadFileViaRelay, fetchMediaBlobViaRelay } from "../../api/fileDownload";
import { MediaItemCard } from "./MediaItemCard";
import { MediaLightboxModal } from "./MediaLightboxModal";
import type { MediaCategory, MediaItem } from "./types";
import { categorizeFile, formatBytes } from "./types";

interface FileEntryDtoLocal {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes?: number | null;
  mimeType?: string | null;
}

interface MediaGalleryCardProps {
  deviceId: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "heic",
  "heif",
  "mp4",
  "mkv",
  "mov",
  "3gp",
]);

export const MediaGalleryCard: React.FC<MediaGalleryCardProps> = ({ deviceId }) => {
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<string | null>(null);

  // Filters & Controls
  const [selectedCategory, setSelectedCategory] = useState<MediaCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"largest" | "smallest" | "name_asc" | "name_desc">("largest");
  const [density, setDensity] = useState<"compact" | "normal">("normal");

  // Pagination / Infinite Scroll
  const [visibleCount, setVisibleCount] = useState(36);
  const observerTarget = useRef<HTMLDivElement | null>(null);

  // Lightbox & Streaming State
  const [activeLightboxItem, setActiveLightboxItem] = useState<MediaItem | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<string | null>(null);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);

  // 1. Poll Device Command Helper
  async function pollCommand(commandId: string, label: string) {
    setScanStatus(`${label}: waiting for device response...`);
    for (let i = 0; i < 25; i++) {
      const delay = i < 6 ? 1000 : 2000;
      await new Promise((r) => setTimeout(r, delay));
      try {
        const cmd = await devicesApi.getCommand(deviceId, commandId);
        if (cmd.status === "acked") {
          setScanStatus(`${label}: completed.`);
          return cmd;
        }
        if (cmd.status === "failed") {
          setScanStatus(`${label}: failed.`);
          return cmd;
        }
      } catch {
        // retry polling
      }
    }
    setScanStatus(`${label}: response taking longer than expected.`);
    return null;
  }

  // 2. Scan Device Storage for Media
  async function handleScanMedia() {
    setIsScanning(true);
    setScanStatus("Requesting media assets from device...");
    try {
      // First try optimized gallery_list, fallback to file_list
      let cmd;
      try {
        cmd = await devicesApi.createCommand(deviceId, "gallery_list");
      } catch {
        cmd = await devicesApi.createCommand(deviceId, "file_list");
      }

      const result = await pollCommand(cmd.id, "Gallery Scan");
      if (result?.status === "acked") {
        const full = await devicesApi.getCommand(deviceId, cmd.id);
        const rawFiles = (full.result?.files as FileEntryDtoLocal[]) || [];

        const items: MediaItem[] = rawFiles
          .filter((f) => {
            if (f.isDirectory) return false;
            const ext = f.name.split(".").pop()?.toLowerCase() || "";
            return (
              SUPPORTED_EXTENSIONS.has(ext) ||
              f.mimeType?.startsWith("image/") ||
              f.mimeType?.startsWith("video/")
            );
          })
          .map((f, idx) => {
            const ext = f.name.split(".").pop()?.toLowerCase() || "";
            const isVideo =
              /\.(mp4|mkv|mov|3gp|avi)$/i.test(f.name) ||
              Boolean(f.mimeType?.startsWith("video/"));
            const isImage = !isVideo;
            return {
              id: `${f.path}-${idx}`,
              name: f.name,
              path: f.path,
              sizeBytes: f.sizeBytes || 0,
              mimeType: f.mimeType || (isVideo ? "video/mp4" : "image/jpeg"),
              category: categorizeFile(f.path, f.name, f.mimeType || undefined),
              extension: ext,
              isVideo,
              isImage,
            };
          });

        setMediaList(items);
        setVisibleCount(36);
        setScanStatus(`Found ${items.length} media assets on device.`);
      }
    } catch (e) {
      setScanStatus(`Failed to scan media: ${(e as Error).message}`);
    } finally {
      setIsScanning(false);
    }
  }

  // 3. Category Counts
  const counts = useMemo(() => {
    const res: Record<MediaCategory, number> = {
      all: mediaList.length,
      camera: 0,
      whatsapp: 0,
      videos: 0,
      screenshots: 0,
      downloads: 0,
    };
    for (const item of mediaList) {
      if (item.category in res) {
        res[item.category]++;
      }
    }
    return res;
  }, [mediaList]);

  // 4. Filtering and Sorting
  const filteredAndSortedList = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = mediaList.filter((item) => {
      const matchCat =
        selectedCategory === "all" || item.category === selectedCategory;
      const matchSearch =
        !q || item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q);
      return matchCat && matchSearch;
    });

    return filtered.sort((a, b) => {
      if (sortBy === "largest") return b.sizeBytes - a.sizeBytes;
      if (sortBy === "smallest") return a.sizeBytes - b.sizeBytes;
      if (sortBy === "name_asc") return a.name.localeCompare(b.name);
      if (sortBy === "name_desc") return b.name.localeCompare(a.name);
      return 0;
    });
  }, [mediaList, selectedCategory, searchQuery, sortBy]);

  // 5. Total Size calculation
  const totalSizeBytes = useMemo(() => {
    return mediaList.reduce((acc, curr) => acc + curr.sizeBytes, 0);
  }, [mediaList]);

  // 6. Infinite Scroll Observer
  useEffect(() => {
    const target = observerTarget.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + 24, filteredAndSortedList.length));
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [filteredAndSortedList.length]);

  // 7. On-Demand Preview Streaming Handler
  async function handleOpenPreview(item: MediaItem) {
    setActiveLightboxItem(item);

    // If already streamed & cached, return immediately
    if (item.previewUrl) return;

    setIsLoadingPreview(true);
    setPreviewStatus(`Streaming ${item.name} from device...`);
    try {
      const cmd = await devicesApi.createCommand(deviceId, "file_download", { path: item.path });
      const streamPromise = fetchMediaBlobViaRelay(cmd.id, (s) => setPreviewStatus(s));
      await pollCommand(cmd.id, `Stream: ${item.name}`);
      const { objectUrl } = await streamPromise;

      // Cache objectUrl into media item
      setMediaList((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, previewUrl: objectUrl } : i))
      );
      setActiveLightboxItem((current) =>
        current?.id === item.id ? { ...current, previewUrl: objectUrl } : current
      );
    } catch (e) {
      setPreviewStatus(`Stream failed: ${(e as Error).message}`);
    } finally {
      setIsLoadingPreview(false);
    }
  }

  // 8. On-Demand Download Handler
  async function handleDownloadMedia(item: MediaItem) {
    setDownloadingPath(item.path);
    try {
      // If we already have the blob cached in memory, download instantly!
      if (item.previewUrl) {
        const a = document.createElement("a");
        a.href = item.previewUrl;
        a.download = item.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }

      // Otherwise stream via WebSocket relay
      const cmd = await devicesApi.createCommand(deviceId, "file_download", { path: item.path });
      const downloadPromise = downloadFileViaRelay(cmd.id);
      await pollCommand(cmd.id, `Download: ${item.name}`);
      await downloadPromise;
    } catch (e) {
      alert(`Download failed: ${(e as Error).message}`);
    } finally {
      setDownloadingPath(null);
    }
  }

  const displayedItems = filteredAndSortedList.slice(0, visibleCount);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* =================================================================== */}
      {/* 1. HEADER SECTION                                                   */}
      {/* =================================================================== */}
      <div className="p-5 border-b border-gray-100 flex flex-wrap items-center justify-between gap-4 bg-slate-50/70">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">🖼️</span>
            <h2 className="font-bold text-base text-gray-900">Media Gallery</h2>
            {mediaList.length > 0 && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                {mediaList.length} Items ({formatBytes(totalSizeBytes)})
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Browse and download photos, videos, and WhatsApp media on-demand.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleScanMedia}
            disabled={isScanning}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-sm hover:shadow transition active:scale-95 disabled:opacity-50"
          >
            {isScanning ? (
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <span>🔍</span>
            )}
            <span>{isScanning ? "Scanning Device..." : "Scan Media Gallery"}</span>
          </button>
        </div>
      </div>

      {scanStatus && (
        <div className="px-5 py-2 bg-emerald-50/60 border-b border-emerald-100 text-xs text-emerald-800 flex items-center justify-between">
          <span>{scanStatus}</span>
          <button
            type="button"
            onClick={() => setScanStatus(null)}
            className="text-emerald-600 hover:text-emerald-900 font-bold ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* =================================================================== */}
      {/* 2. TOOLBAR: CATEGORIES & CONTROLS                                   */}
      {/* =================================================================== */}
      {mediaList.length > 0 && (
        <div className="p-4 border-b border-gray-100 bg-white space-y-3">
          {/* Category Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs scrollbar-none">
            {(
              [
                { id: "all", label: "All Media", icon: "📁", count: counts.all },
                { id: "camera", label: "Camera (DCIM)", icon: "📷", count: counts.camera },
                { id: "whatsapp", label: "WhatsApp Media", icon: "💬", count: counts.whatsapp },
                { id: "videos", label: "Videos", icon: "🎬", count: counts.videos },
                { id: "screenshots", label: "Screenshots", icon: "📸", count: counts.screenshots },
                { id: "downloads", label: "Downloads", icon: "📥", count: counts.downloads },
              ] as const
            ).map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => {
                  setSelectedCategory(cat.id);
                  setVisibleCount(36);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition whitespace-nowrap ${
                  selectedCategory === cat.id
                    ? "bg-slate-900 text-white shadow-xs"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                <span>{cat.icon}</span>
                <span>{cat.label}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                    selectedCategory === cat.id ? "bg-white/20 text-white" : "bg-gray-200 text-gray-700"
                  }`}
                >
                  {cat.count}
                </span>
              </button>
            ))}
          </div>

          {/* Search, Sort, & Density */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-gray-400">
                🔍
              </span>
              <input
                type="text"
                placeholder="Filter by media filename..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setVisibleCount(36);
                }}
                className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 bg-gray-50/50"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 text-xs">
              <label htmlFor="gallery-sort-select" className="text-gray-500">Sort:</label>
              <select
                id="gallery-sort-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="bg-gray-50 border border-gray-300 rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              >
                <option value="largest">Size: Largest First</option>
                <option value="smallest">Size: Smallest First</option>
                <option value="name_asc">Name: A to Z</option>
                <option value="name_desc">Name: Z to A</option>
              </select>

              <div className="hidden sm:flex items-center border border-gray-300 rounded-lg overflow-hidden ml-2">
                <button
                  type="button"
                  onClick={() => setDensity("normal")}
                  className={`px-2 py-1 text-xs ${
                    density === "normal" ? "bg-slate-900 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                  title="Comfortable Grid"
                >
                  ⊞
                </button>
                <button
                  type="button"
                  onClick={() => setDensity("compact")}
                  className={`px-2 py-1 text-xs ${
                    density === "compact" ? "bg-slate-900 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                  title="Compact Grid"
                >
                  ▦
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* 3. MEDIA GRID / CONTENT                                             */}
      {/* =================================================================== */}
      <div className="p-5">
        {mediaList.length === 0 ? (
          <div className="text-center py-16 px-4">
            <span className="text-5xl block mb-3">🖼️</span>
            <h3 className="text-sm font-semibold text-gray-800">
              Media Gallery Not Yet Loaded
            </h3>
            <p className="text-xs text-gray-500 max-w-sm mx-auto mt-1 mb-5">
              Click &quot;Scan Media Gallery&quot; to fetch the on-device photo & video library with on-demand download support.
            </p>
            <button
              type="button"
              onClick={handleScanMedia}
              disabled={isScanning}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-sm transition active:scale-95 disabled:opacity-50"
            >
              {isScanning ? "Scanning Phone..." : "Scan Media Gallery Now"}
            </button>
          </div>
        ) : displayedItems.length === 0 ? (
          <div className="text-center py-12 text-gray-500 text-xs">
            No media found matching &quot;{searchQuery}&quot; in {selectedCategory} category.
          </div>
        ) : (
          <>
            <div
              className={`grid gap-4 ${
                density === "compact"
                  ? "grid-cols-2 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8"
                  : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6"
              }`}
            >
              {displayedItems.map((item) => (
                <MediaItemCard
                  key={item.id}
                  item={item}
                  onPreview={handleOpenPreview}
                  onDownload={handleDownloadMedia}
                  isDownloading={downloadingPath === item.path}
                />
              ))}
            </div>

            {/* Infinite Scroll Sentinel */}
            {visibleCount < filteredAndSortedList.length && (
              <div
                ref={observerTarget}
                className="py-8 flex flex-col items-center justify-center gap-2 text-xs text-gray-400"
              >
                <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                <span>Loading more media ({displayedItems.length} of {filteredAndSortedList.length})...</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* =================================================================== */}
      {/* 4. LIGHTBOX PREVIEW MODAL                                           */}
      {/* =================================================================== */}
      <MediaLightboxModal
        item={activeLightboxItem}
        items={filteredAndSortedList}
        isOpen={Boolean(activeLightboxItem)}
        onClose={() => setActiveLightboxItem(null)}
        onNavigate={handleOpenPreview}
        onDownload={handleDownloadMedia}
        isLoadingMedia={isLoadingPreview}
        statusMessage={previewStatus}
      />
    </div>
  );
};
export default MediaGalleryCard;
