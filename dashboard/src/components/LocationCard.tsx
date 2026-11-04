import { useEffect, useState } from "react";
import { devicesApi } from "../api/devices";
import type { LocationPoint } from "../api/types";

/**
 * Reverse-geocodes lat/lng to a "City, District" label via OpenStreetMap's
 * free Nominatim API (no key needed, CORS-enabled). Cached per rounded
 * coordinate (~100m) so nearby/repeated points don't each trigger their own
 * lookup — important since Nominatim's public instance is rate-limited.
 */
const geocodeCache = new Map<string, string>();

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const key = cacheKey(lat, lng);
  const cached = geocodeCache.get(key);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`
    );
    const data = await res.json();
    const address = data.address || {};
    const city = address.city || address.town || address.village || address.suburb || null;
    const district = address.state_district || address.county || null;
    const state = address.state || null;
    // Skip the district when it's just the same name as the city
    // (common for India's city-as-district pattern, e.g. "Erode, Erode").
    const secondary = district && district !== city ? district : state;
    const label = [city, secondary].filter(Boolean).join(", ") || "Unknown area";
    geocodeCache.set(key, label);
    return label;
  } catch {
    return "Unknown area";
  }
}

export default function LocationCard({ deviceId, refreshKey }: { deviceId: string; refreshKey?: number }) {
  const [points, setPoints] = useState<LocationPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [areas, setAreas] = useState<Record<string, string>>({});

  useEffect(() => {
    devicesApi
      .locationHistory(deviceId, 20)
      .then((pts) => {
        setPoints(pts);
        // One geocode lookup per distinct rounded coordinate, not per point.
        const uniqueKeys = new Map<string, { lat: number; lng: number }>();
        pts.forEach((p) => uniqueKeys.set(cacheKey(p.latitude, p.longitude), { lat: p.latitude, lng: p.longitude }));
        uniqueKeys.forEach(({ lat, lng }, key) => {
          reverseGeocode(lat, lng).then((label) => setAreas((prev) => ({ ...prev, [key]: label })));
        });
      })
      .finally(() => setLoading(false));
    // refreshKey isn't read here — it's only in the dependency array so a
    // bump from RemoteActionsCard (after "Check Location Now" acks) triggers
    // a refetch, instead of the list staying stale until the next full page load.
  }, [deviceId, refreshKey]);

  const latest = points.length > 0 ? points[0] : null;
  const latestArea = latest ? areas[cacheKey(latest.latitude, latest.longitude)] : null;

  return (
    <div className="bg-white rounded-lg shadow-sm p-5 border border-slate-100">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <h2 className="font-semibold text-sm text-slate-800">On-Demand GPS Location</h2>
        </div>
        {latest && (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
            {latest.accuracy_m ? `±${Math.round(latest.accuracy_m)}m GPS Fix` : "Active GPS"}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : points.length === 0 ? (
        <div className="text-center py-8 bg-slate-50/70 rounded-lg border border-dashed border-slate-200 p-4">
          <span className="text-2xl mb-1 block">📍</span>
          <p className="text-xs text-slate-600 font-medium">No location points recorded yet</p>
          <p className="text-[11px] text-slate-400 mt-1">
            Click <strong>"Check Location Now"</strong> above to pinpoint device GPS coordinates.
          </p>
        </div>
      ) : (
        <div>
          {/* Interactive Live Mini-Map */}
          {latest && (
            <div className="mb-4">
              <div className="relative rounded-lg overflow-hidden border border-slate-200 shadow-sm bg-slate-100">
                <iframe
                  title="Live Device Map Location"
                  width="100%"
                  height="190"
                  className="w-full block"
                  loading="lazy"
                  src={`https://www.openstreetmap.org/export/embed.html?bbox=${(latest.longitude - 0.007).toFixed(6)}%2C${(latest.latitude - 0.004).toFixed(6)}%2C${(latest.longitude + 0.007).toFixed(6)}%2C${(latest.latitude + 0.004).toFixed(6)}&layer=mapnik&marker=${latest.latitude.toFixed(6)}%2C${latest.longitude.toFixed(6)}`}
                />
              </div>

              {/* Latest Fix Details Bar */}
              <div className="mt-2.5 p-3 rounded-lg bg-slate-50 border border-slate-200/80 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div>
                  <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                    <span>📍</span>
                    <span>{latestArea || "Resolving neighborhood / city..."}</span>
                  </div>
                  <div className="text-slate-500 font-mono text-[11px] mt-0.5">
                    {latest.latitude.toFixed(6)}, {latest.longitude.toFixed(6)}
                    {latest.accuracy_m && (
                      <span className="ml-2 text-emerald-600 font-medium">
                        (Accuracy: ±{Math.round(latest.accuracy_m)}m)
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-400">
                    {new Date(latest.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <a
                    href={`https://www.google.com/maps?q=${latest.latitude},${latest.longitude}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-300 rounded text-slate-700 font-medium text-[11px] shadow-sm transition"
                  >
                    <span>Open Google Maps</span>
                    <span>↗</span>
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* History List Header */}
          <div className="flex items-center justify-between mb-2 pt-2 border-t border-slate-100">
            <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wider">
              Recent Movement History ({points.length})
            </h3>
          </div>

          {/* Location History Logs */}
          <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
            {points.map((p, i) => {
              const area = areas[cacheKey(p.latitude, p.longitude)];
              return (
                <div
                  key={i}
                  className="flex justify-between items-center text-xs p-2 rounded hover:bg-slate-50 transition border border-transparent hover:border-slate-100"
                >
                  <div>
                    <div className="font-medium text-slate-700 flex items-center gap-1.5">
                      <span>{area || "Locating area..."}</span>
                      <span className="text-[10px] text-slate-400 font-normal">
                        {p.source === "geofence_event" ? "📍 geofence" : "🎯 on-demand"}
                      </span>
                    </div>
                    <div className="text-slate-400 font-mono text-[11px]">
                      {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)}
                      {p.accuracy_m && ` • ±${Math.round(p.accuracy_m)}m`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 whitespace-nowrap text-[11px]">
                      {new Date(p.recorded_at).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <a
                      href={`https://www.google.com/maps?q=${p.latitude},${p.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Open in Google Maps"
                      className="text-slate-500 hover:text-emerald-600 transition"
                    >
                      🗺️
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
