export type MediaCategory = "all" | "camera" | "whatsapp" | "screenshots" | "videos" | "downloads";

export interface MediaItem {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  mimeType: string;
  category: MediaCategory;
  extension: string;
  isVideo: boolean;
  isImage: boolean;
  previewUrl?: string;
  isLoadingPreview?: boolean;
}

export function categorizeFile(path: string, name: string, mimeType?: string): MediaCategory {
  const p = path.toLowerCase();
  const n = name.toLowerCase();

  if (p.includes("whatsapp") || n.includes("wa_") || p.includes("com.whatsapp")) {
    return "whatsapp";
  }
  if (p.includes("screenshot") || n.includes("screenshot")) {
    return "screenshots";
  }
  if (p.includes("dcim") || p.includes("camera") || n.startsWith("img_") || n.startsWith("dsc_")) {
    return "camera";
  }
  if (
    p.includes("movie") ||
    p.includes("video") ||
    mimeType?.startsWith("video/") ||
    /\.(mp4|mkv|mov|3gp|avi|webm)$/i.test(n)
  ) {
    return "videos";
  }
  if (p.includes("download")) {
    return "downloads";
  }
  return "all";
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}
